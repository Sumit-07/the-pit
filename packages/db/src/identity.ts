/**
 * The boundary between `@the-pit/payments`' vocabulary and this schema's.
 *
 * ## Why an adapter and not a rename
 *
 * The two packages were written in parallel against the same brief and picked
 * different words for the same four things:
 *
 * | `@the-pit/payments` | this schema   | what it is                     |
 * |---------------------|---------------|--------------------------------|
 * | `accountId`         | `accounts.id` | who paid                       |
 * | `runId`             | `jobs.id`     | the evaluation that ran        |
 * | `listingId`         | `products.id` | the thing in the pit           |
 * | `verdictId`         | `verdicts.id` | what was delivered             |
 *
 * Neither vocabulary is wrong. `payments` is deliberately storage-agnostic —
 * `AttemptsStore` is a two-method seam precisely so the money rules can be
 * tested with no database — and "run" and "listing" are the words `brief §2.3`
 * and `§2.4` use. This schema names tables after what they hold. Renaming either
 * side would churn the package whose 146 tests are mutation-verified in order to
 * settle a disagreement about spelling.
 *
 * So the mapping is written down once, here, as two functions that turn what
 * `payments` produces into rows this schema accepts. Everything the disagreement
 * could cost — a `runId` written into `product_id`, a consume that loses the run
 * it spent — is a type error at this one call site instead of a silent swap at
 * every one.
 *
 * ## The input types are declared locally, on purpose
 *
 * `LedgerEntry` and `DeliveredVerdict` below mirror `AttemptEntry` and
 * `VerdictWrite` from `@the-pit/payments` structurally. They are re-declared
 * rather than imported so that `@the-pit/db` — which `apps/web` depends on and
 * which must stay importable with no database and no payment provider — does not
 * put the payments package into its published type surface.
 *
 * That mirror is not maintained by hand-waving. `test/identity.test.ts` imports
 * the real types from `@the-pit/payments` and asserts assignability in BOTH
 * directions, so a field added, removed or retyped over there fails this
 * package's typecheck rather than drifting quietly.
 */

import { digest } from '@the-pit/engine';

import type { attempts, verdicts } from './schema/index.js';

/**
 * The mapping, as data, so a reader does not have to reconstruct it from the
 * function bodies and a reviewer can diff it.
 */
export const PAYMENTS_IDENTITY_MAPPING = {
  accountId: 'accounts.id',
  runId: 'jobs.id',
  listingId: 'products.id',
  verdictId: 'verdicts.id',
} as const satisfies Record<string, string>;

/** Mirrors `AttemptEntryReason` in `@the-pit/payments`. */
export type LedgerEntryReason =
  | {
      readonly kind: 'grant';
      readonly providerEventId: string;
      readonly providerPaymentId: string;
      /**
       * `PriceTierId` re-declared. Written out as its members rather than as
       * `string` so the bidirectional assignability check in
       * `test/identity.test.ts` has something to fail on: a second tier added
       * beside `brief §2.3`'s "$5 = 1 attempt" is a pricing change, and it should
       * reach this package as a typecheck error rather than as a value nothing
       * here knows about.
       */
      readonly tier: 'single';
      readonly amountCents: number;
    }
  | {
      readonly kind: 'consume';
      readonly runId: string;
      readonly verdictId: string;
      readonly listingId: string;
    }
  | {
      readonly kind: 'adjustment';
      readonly note: string;
      readonly actor: string;
    };

/** Mirrors `AttemptEntry` in `@the-pit/payments`. */
export interface LedgerEntry {
  readonly accountId: string;
  readonly delta: number;
  readonly reason: LedgerEntryReason;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

/** Mirrors `VerdictWrite` in `@the-pit/payments`. */
export interface DeliveredVerdict {
  readonly verdictId: string;
  readonly listingId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly attemptNumber: number;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * What the caller has to supply that a `LedgerEntry` cannot.
 *
 * `AttemptEntryReason`'s grant arm carries the provider's event and payment ids,
 * which is what `brief §2.2` keys idempotency on — but `attempts.order_id` is a
 * foreign key onto the `orders` row those ids produced, and only the webhook
 * handler that just inserted it knows its uuid. Required on a grant and rejected
 * on anything else, because `attempts_grant_has_order` says the same thing in the
 * database: exactly the grant rows name an order.
 */
export interface AttemptRowContext {
  /** The `orders` row this grant was written against. */
  readonly orderId: string;
}

/**
 * One `AttemptEntry` as an `attempts` row.
 *
 * The consume arm drops `verdictId`, and that is not a loss: `verdicts.job_id`
 * is UNIQUE, so the verdict a consume paid for is `SELECT id FROM verdicts WHERE
 * job_id = attempts.job_id`. Storing it here as well would be a second copy of a
 * fact that two tables could then disagree about, on the one table in the schema
 * that cannot be corrected by an UPDATE.
 */
export function attemptRow(
  entry: LedgerEntry,
  context?: AttemptRowContext,
): typeof attempts.$inferInsert {
  const base = {
    accountId: entry.accountId,
    delta: entry.delta,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
  } as const;

  switch (entry.reason.kind) {
    case 'grant': {
      if (context === undefined) {
        throw new RangeError(
          'attemptRow: a grant must name the orders row it was written against ' +
            '(attempts_grant_has_order). Insert the order first and pass its id.',
        );
      }
      return { ...base, kind: 'grant', orderId: context.orderId };
    }
    case 'consume': {
      if (context !== undefined) {
        throw new RangeError('attemptRow: a consume names a job, not an order (attempts_consume_has_job).');
      }
      // `runId` -> `job_id`, `listingId` -> `product_id`. The whole disagreement,
      // in two lines, in one place.
      return { ...base, kind: 'consume', jobId: entry.reason.runId, productId: entry.reason.listingId };
    }
    case 'adjustment': {
      if (context !== undefined) {
        throw new RangeError('attemptRow: an adjustment names a person, not an order (attempts_adjustment_has_reason).');
      }
      return { ...base, kind: 'adjustment', note: entry.reason.note, actor: entry.reason.actor };
    }
  }
}

/**
 * What a `VerdictWrite` cannot carry, because `@the-pit/payments` is deliberately
 * blind to verdict CONTENT — "the moment it can read a rank, someone can write
 * `if (newRank < oldRank)` on the money path".
 *
 * `productCount` is a fact about the board, which is exactly the kind of thing
 * that module must not be able to see. `publicSlug` is a routing decision.
 */
export interface VerdictRowContext {
  /** The public URL. `verdictSlug` derives a stable one; any unique slug works. */
  readonly publicSlug: string;
  /** `brief` Part 5: stamped on the card beside the timestamp. */
  readonly productCount: number;
}

/**
 * One `VerdictWrite` as a `verdicts` row.
 *
 * `createdAt` becomes `delivered_at` rather than a separate creation timestamp,
 * because for this table they are the same instant by construction: the row is
 * written inside `AttemptsLedger.deliver`, which is the transaction that marks
 * the job delivered and consumes the attempt (`brief §2.3`). A row that was
 * created at one time and delivered at another would mean a verdict had existed,
 * unpublished, in a table with no UPDATE path.
 */
export function verdictRow(
  verdict: DeliveredVerdict,
  context: VerdictRowContext,
): typeof verdicts.$inferInsert {
  return {
    id: verdict.verdictId,
    publicSlug: context.publicSlug,
    productId: verdict.listingId,
    jobId: verdict.runId,
    accountId: verdict.accountId,
    attemptNumber: verdict.attemptNumber,
    payload: verdict.payload,
    productCount: context.productCount,
    deliveredAt: verdict.createdAt,
  };
}

/**
 * A stable public slug for a verdict id.
 *
 * Not the uuid itself. The uuid is an internal key that appears in foreign keys
 * and admin queries; the slug is a customer-facing address that appears in a
 * tweet and a screenshot, and keeping them distinct means the public page cannot
 * be used to enumerate or address internal rows. Deriving it from the id keeps it
 * deterministic — the same verdict gets the same URL on a re-run of a seed — and
 * 32 hex characters satisfies `verdicts_public_slug_shape`.
 */
export function verdictSlug(verdictId: string): string {
  return digest(`verdict:${verdictId}`).slice(0, 32);
}
