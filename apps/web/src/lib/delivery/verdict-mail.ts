/**
 * "Your verdict is in" — the one message a paying customer is actually waiting
 * for, and the only place in the app that sends it.
 *
 * ## It runs AFTER the money transaction, never inside it
 *
 * `settleDelivery` calls this once the transaction that wrote the verdict, marked
 * the job delivered and spent the attempt has COMMITTED. Sending inside the
 * transaction would put a third-party HTTP request inside a `pg_advisory_xact_lock`
 * held on the customer's account, and a provider that took four seconds to answer
 * would hold the lock for four seconds; a provider that threw would roll back a
 * delivered verdict because an email bounced. The customer's verdict does not
 * depend on Resend being up.
 *
 * So every failure here is absorbed: a malformed payload, a missing slug, a
 * provider 500, a thrown transport. `mailVerdict` returns a boolean and never
 * rejects, and `SettleResult.mailed` is what the caller logs.
 *
 * ## Sending exactly once, without a new column
 *
 * A settle is retried by Inngest, so "send on settle" has to mean "send on the
 * settle that actually settled". It does: `settleDelivery` calls this only when
 * the ledger answers `delivered`, and the ledger answers `duplicate` — which
 * becomes `already_settled` — for every replay, because the consume is keyed
 * `delivery:run:<runId>`. The idempotency the money path already has is the
 * idempotency the mail path needs, and it needs no storage of its own.
 *
 * That is deliberate rather than lazy. A `verdict_mailed_at` column would have to
 * live on `verdicts` or on `jobs`, and `migrations/0002` and `0003` make both
 * rows frozen the instant they are delivered — `jobs_delivery_immutable` refuses
 * every UPDATE of a delivered job and `verdicts_immutable` refuses every UPDATE
 * full stop. A mail flag on either would be a column that could never be set.
 *
 * The residual window is a crash between the commit and the send: that customer
 * is not emailed, and a retry reports `already_settled` and does not try again.
 * That is the correct direction to fail. The verdict is written, public and
 * permanent, and it is on the account page; the alternative arrangement — send
 * first, or send on every pass — mails a stranger's verdict twice and is the one
 * that generates support.
 *
 * The message also carries a provider idempotency key derived from the account
 * and the URL (`verdictIdempotencyKey`), so a double send that got past all of
 * that is deduplicated by Resend rather than by us.
 *
 * ## Seeded listings are not mailed
 *
 * `brief` Part 7's cold-start verdicts have no account and no payer, so they never
 * reach here — `settleDelivery` answers `unpaid` first. The `to` address is the
 * one on the `products` row (`products_source_submitter` requires it on a `paid`
 * row and leaves it NULL on a seeded one), and a null address is a skip rather
 * than a guess.
 */

import {
  capabilityUrl,
  renderVerdictEmail,
  type MailTransport,
} from '@the-pit/auth';

import { parseVerdict } from '@/lib/verdict/model';
import { cutsLine, stampedRank } from '@/lib/verdict/page';

/** What sending one verdict email needs. Nothing here reaches a database directly. */
export interface VerdictMailDeps {
  readonly transport: MailTransport;
  /** `From:`, e.g. `The Pit <no-reply@thepit.show>`. `AUTH_MAIL_FROM`. */
  readonly from: string;
  /** Absolute origin for the verdict URL and the account URL. `APP_ORIGIN`. */
  readonly origin: string;
  /**
   * The account's CURRENT capability slug, or `null`.
   *
   * `IdentityStore.capabilitySlugFor`. A read and never a mint: the account-link
   * email and the success page both show the slug the webhook already created,
   * and a delivery that minted one would be a second way for an account URL to
   * come into existence.
   */
  capabilitySlugFor(accountId: string): Promise<string | null>;
}

/** The row that was just written, as this module needs to read it back. */
export interface VerdictMailInput {
  /** `products.submitted_by_email`. `null` on a seeded row, which is not mailed. */
  readonly to: string | null;
  readonly accountId: string;
  readonly publicSlug: string;
  /** The frozen document. Parsed by `parseVerdict`, never trusted by shape. */
  readonly payload: unknown;
  readonly productCount: number;
  readonly attemptNumber: number;
  /** The instant the board was generated — the stamp the card carries. */
  readonly deliveredAt: Date;
}

/** `https://thepit.show/v/<slug>` — the public, permanent URL. */
export function verdictUrl(origin: string, slug: string): string {
  return `${origin}/v/${encodeURIComponent(slug)}`;
}

/**
 * Send it, and answer whether it went.
 *
 * Never rejects. See the module header: this runs after a committed money
 * transaction, and the honest response to "the mail provider is down" is a
 * delivered verdict and a line in the log.
 */
export async function mailVerdict(
  input: VerdictMailInput,
  deps: VerdictMailDeps,
): Promise<boolean> {
  if (input.to === null || input.to === '') return false;

  try {
    const verdict = parseVerdict({
      publicSlug: input.publicSlug,
      payload: input.payload,
      productCount: input.productCount,
      attemptNumber: input.attemptNumber,
      deliveredAt: input.deliveredAt,
    });

    const slug = await deps.capabilitySlugFor(input.accountId);
    const message = renderVerdictEmail({
      email: input.to,
      from: deps.from,
      name: verdict.name,
      cuts: verdict.cuts,
      // `brief` Part 5's rank rule, as the only rank the message can be given.
      rankStamp: stampedRank(verdict),
      sharpest:
        verdict.sharpest === null
          ? null
          : { role: verdict.sharpest.role, reason: verdict.sharpest.reason },
      url: verdictUrl(deps.origin, input.publicSlug),
      accountUrl: slug === null ? null : capabilityUrl(deps.origin, slug),
      accountId: input.accountId,
    });

    const result = await deps.transport.send(message);
    if (result.outcome === 'failed') {
      console.error(`[delivery] the verdict email for ${input.publicSlug} was not sent: ${result.reason}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      `[delivery] the verdict email for ${input.publicSlug} was not sent: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * The page's own sentence, re-exported so a test can pin the email to it.
 *
 * `@the-pit/auth` cannot import `apps/web` (`PHASE-0.md §3`), so the email
 * restates `cutsLine` rather than calling it. This is the handle the drift test
 * holds the two together by.
 */
export { cutsLine };
