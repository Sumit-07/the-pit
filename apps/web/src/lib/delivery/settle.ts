/**
 * What happens when a run says it delivered: the verdict is written, the job is
 * marked, one attempt is spent, and the rendered board pages are invalidated.
 *
 * ## This is the end of the money path
 *
 * `brief §2.3`:
 *
 * > "An attempt is consumed **only on delivery** — decrement in the same
 * > transaction that writes the verdict and marks it delivered. Not on job start,
 * > not on pipeline completion."
 *
 * Every clause of that sentence is somewhere else. `deliverStep` is the only
 * caller of `onDelivered` and it fires AFTER the board snapshot exists, so an
 * attempt can never be spent on a verdict that was not published.
 * `AttemptsLedger.deliver` is the only method in `@the-pit/payments` that
 * decrements, and it refuses a decision that is not `consume`.
 * `createPostgresDeliveryStore` is the transaction, with the advisory lock
 * `migrations/0001` asks for. This module is the join: it takes the event, finds
 * the two ids a run does not hold, and calls the ledger once.
 *
 * ## Three arms, and only one of them moves money
 *
 * - **No payer.** A seed run and an admin re-run deliver a board and spend
 *   nothing, because there is no attempt behind them. `brief` Part 7's cold-start
 *   verdicts already exist — written by the seed CLI, `job_id` NULL, unclaimed —
 *   and inventing another here would take the ordinal a founder's real first
 *   pitch is entitled to (`verdicts_product_attempt_uk`).
 * - **No durable store.** A filesystem-bound deployment has no `jobs` row to mark
 *   delivered, so there is nothing to settle and nothing to charge. `service.ts`
 *   already refuses the filesystem binding in production; this is the same rule
 *   arriving from the other side, and it is reported rather than absorbed.
 * - **A payer and a run.** The transaction runs.
 *
 * ## Nothing here is a throw
 *
 * Every failure below happens after the customer's money is recorded and after a
 * board has been republished. The honest response to "we could not settle this"
 * is a named result the caller can log and route, not an exception that makes the
 * executor retry a delivery whose first three writes may already have committed.
 * The one exception is a genuine database fault, which is left to propagate so
 * the executor's retry can find the row exactly as it left it — every write in
 * the transaction is idempotent, so a retry either completes it or reports
 * `already_settled`.
 *
 * ## The email is outside the transaction, and outside the result
 *
 * A settled delivery also tells the customer. That send happens AFTER the
 * transaction commits and cannot affect it: a provider outage produces
 * `mailed: false` beside a `settled` outcome, never a rolled-back verdict. It
 * fires only on the pass that actually settled, which is what stops an Inngest
 * retry mailing twice — see `verdict-mail.ts` for why that is the ledger's
 * idempotency key rather than a column.
 *
 * ## The invalidation is here and not in the sink
 *
 * `SNAPSHOT_PURGE_URL` purges the board JSON at the CDN. The RENDERED pages —
 * `/`, `/boards`, `/boards/<slug>` — are a separate artifact with
 * `revalidate = 86400` on them, and nothing was invalidating it: a paid placement
 * could be live in the JSON and up to a day stale on the page a visitor actually
 * sees. Same two-documents-no-error shape as the snapshot sink seam one layer
 * down, so it is closed the same way — one call site, on the event that says a
 * board changed, for every path that republishes one.
 */

import {
  AttemptsLedger,
  type AttemptDecision,
  type VerdictWrite,
} from '@the-pit/payments';
import { deterministicUuid, verdictSlug } from '@the-pit/db';

import type { DeliveryRecord } from '@/lib/pipeline/types';

import type { BoardInvalidator } from './revalidate';
import { mailVerdict, type VerdictMailDeps } from './verdict-mail';

/**
 * The two reads and the one transaction a settle needs, as a seam.
 *
 * Deliberately not a `Database`. Everything below is testable against an
 * in-memory implementation AND against PGlite, and a module that took a
 * connection could only be tested against one of them.
 */
export interface DeliveryBindings {
  /** `products.id` for the listing this run placed, by the identity the run holds. */
  findListing(input: {
    categorySlug: string;
    engineId: number;
  }): Promise<{ productId: string; source: string; submittedByEmail: string | null } | null>;
  /**
   * A ledger bound to ONE delivery.
   *
   * Per delivery rather than per process because the transaction it wraps needs
   * two facts a `VerdictWrite` deliberately cannot carry — the board's product
   * count and the public slug — and one it must not carry, the account the
   * advisory lock is taken on. `@the-pit/payments` is blind to verdict CONTENT on
   * purpose ("the moment it can read a rank, someone can write
   * `if (newRank < oldRank)` on the money path"), so those arrive here instead.
   */
  ledgerFor(input: {
    accountId: string;
    publicSlug: string;
    productCount: number;
  }): AttemptsLedger;
}

export interface SettleDeps {
  /**
   * `null` in a deployment with no database bound.
   *
   * A real state and not a convenience: `next build` traces server modules with
   * no `DATABASE_URL`, and a local run against `cjr/` has no `jobs` table to
   * mark. Both must reach `not_settleable` rather than a connection error on a
   * path that has already taken somebody's money.
   */
  readonly bindings: DeliveryBindings | null;
  /** The rendered pages to invalidate. Absent outside a Next request context. */
  readonly invalidator?: BoardInvalidator;
  /**
   * How to tell the customer. Absent means nothing is sent.
   *
   * Optional because a settle is correct without it — `brief §2.3`'s clause is
   * about the ledger, and the verdict is public the instant the transaction
   * commits. Every existing settle test therefore mails nobody by construction,
   * and a deployment with no mail provider still delivers.
   */
  readonly mail?: VerdictMailDeps;
  readonly now?: () => Date;
}

/** What a settle did, in a shape the caller can log and route. */
export type SettleResult =
  /** The verdict was written, the job marked, one attempt spent. */
  | {
      readonly outcome: 'settled';
      readonly verdictSlug: string;
      readonly verdictId: string;
      readonly productId: string;
      readonly balance: number;
      /**
       * Whether "your verdict is in" reached the customer.
       *
       * A flag and not a failure: the send happens after the transaction has
       * committed, so `false` means a delivered, public, permanent verdict that
       * nobody was told about — a line for the log and, at worst, a support
       * conversation. It is never a reason to retry a settle.
       */
      readonly mailed: boolean;
    }
  /**
   * The same run settled twice. The verdict stands; the customer is charged once,
   * and — because `mailed` is only ever true on the pass that settled — emailed
   * once.
   */
  | {
      readonly outcome: 'already_settled';
      readonly verdictSlug: string;
      readonly verdictId: string;
      readonly productId: string;
      readonly balance: number;
      readonly mailed: false;
    }
  /** Nobody paid for this delivery, so there is nothing to spend. */
  | { readonly outcome: 'unpaid' }
  /** Something the caller has to look at. Never a throw — see the module header. */
  | { readonly outcome: 'not_settleable'; readonly reason: string };

/**
 * The verdict's identity, derived from the run.
 *
 * `verdicts_one_per_job_uk` already says a job produces one verdict, and
 * `consumeIdempotencyKey` keys the decrement to the same run, so deriving the id
 * from the run makes the whole transaction replay onto the same three rows rather
 * than onto a second set that the unique indexes would then have to reject. A
 * random uuid here would turn a retried delivery into a constraint violation
 * inside the money transaction.
 */
export function deliveredVerdictId(runId: string): string {
  return deterministicUuid('verdict', 'delivery', runId);
}

/**
 * Settle one delivered run.
 *
 * Idempotent end to end: run it twice on the same record and the second pass
 * writes nothing, charges nothing, and answers `already_settled`.
 */
export async function settleDelivery(
  record: DeliveryRecord,
  deps: SettleDeps,
): Promise<SettleResult> {
  // The board changed, whoever paid for it. Invalidation is not part of the money
  // transaction and must not be conditional on it: a seed run's republish moves
  // the same three pages a paid placement's does.
  await deps.invalidator?.invalidateBoard(record.slug);

  const paid = record.paid;
  if (paid === undefined) return { outcome: 'unpaid' };

  if (deps.bindings === null) {
    return {
      outcome: 'not_settleable',
      reason:
        'no database is bound in this process, so there is no jobs row to mark delivered and no ledger ' +
        'to consume from. The customer keeps the attempt (brief §2.3 spends one only on delivery); the ' +
        'board is published and the verdict is owed.',
    };
  }

  const runId = record.run_id;
  if (runId === undefined || runId === '') {
    return {
      outcome: 'not_settleable',
      reason:
        'the delivered run carries no run id. attempts_consume_requires_delivery reads jobs.delivered_at ' +
        'before it will accept a decrement, and a run with no row cannot set it.',
    };
  }

  const decision: AttemptDecision = paid.decision;
  if (decision.action !== 'consume') {
    // `AttemptsLedger.deliver` throws on this, and a throw here would be an
    // executor retry of a decision that will never change.
    return {
      outcome: 'not_settleable',
      reason: `the run decided '${decision.action}', which brief §2.3 does not deliver against`,
    };
  }

  const listing = await deps.bindings.findListing({
    categorySlug: record.slug,
    engineId: paid.engineId,
  });
  if (listing === null) {
    return {
      outcome: 'not_settleable',
      reason:
        `no products row for engine id ${paid.engineId} in ${JSON.stringify(record.slug)}. The catalogue ` +
        'write runs between the publish and this settle (placement.ts), so a missing row means it did not ' +
        'land — and verdicts.product_id is a foreign key onto it.',
    };
  }

  const verdictId = deliveredVerdictId(runId);
  const publicSlug = verdictSlug(verdictId);
  const now = (deps.now ?? (() => new Date()))();

  const verdict: VerdictWrite = {
    verdictId,
    listingId: listing.productId,
    runId,
    accountId: paid.accountId,
    attemptNumber: paid.attemptNumber,
    payload: paid.payload,
    // The instant the board was generated, not the instant this event was
    // handled. `verdicts.delivered_at` is stamped on the card beside the product
    // count (`brief` Part 5) and has to name the board it describes.
    createdAt: new Date(record.delivered_at),
  };

  const ledger = deps.bindings.ledgerFor({
    accountId: paid.accountId,
    publicSlug,
    productCount: record.product_count,
  });

  const result = await ledger.deliver({ decision, verdict, now });

  if (result.outcome !== 'delivered') {
    // A replay. The verdict stands, the customer was charged once, and they were
    // told once — on the pass below, whenever that was.
    return {
      outcome: 'already_settled',
      verdictSlug: publicSlug,
      verdictId: result.verdictId,
      productId: listing.productId,
      balance: result.balance,
      mailed: false,
    };
  }

  // AFTER the commit, and outside it. `mailVerdict` never rejects; the worst it
  // can do to a delivered verdict is decline to announce it.
  const mailed =
    deps.mail === undefined
      ? false
      : await mailVerdict(
          {
            to: listing.submittedByEmail,
            accountId: paid.accountId,
            publicSlug,
            payload: paid.payload,
            productCount: record.product_count,
            attemptNumber: paid.attemptNumber,
            deliveredAt: new Date(record.delivered_at),
          },
          deps.mail,
        );

  return {
    outcome: 'settled',
    verdictSlug: publicSlug,
    verdictId: result.verdictId,
    productId: listing.productId,
    balance: result.balance,
    mailed,
  };
}
