/**
 * `@the-pit/payments`' two write seams, against these tables: the webhook's
 * store and the attempts ledger's store.
 *
 * Here for the same reason `auth-store.ts` and `identity-store.ts` are: every
 * statement below is a claim about a table and its constraints, and a claim about
 * a table belongs next to the table, where the schema tests can execute it
 * against a real Postgres rather than against a mock that agrees with it.
 *
 * ## The grant is one transaction and two inserts, and the ORDER matters
 *
 * `AttemptsLedger.grant` hands us one `AttemptEntry`. It becomes two rows:
 *
 * ```
 * INSERT INTO orders   (...)  ON CONFLICT DO NOTHING RETURNING id
 * INSERT INTO attempts (...)  ON CONFLICT DO NOTHING RETURNING id   -- order_id = above
 * ```
 *
 * The order row first, because `attempts.order_id` is a foreign key onto it and
 * `attempts_grant_has_order` requires exactly the grant rows to name one. Both
 * inside one transaction, because an order with no attempt is a payment that
 * bought nothing and an attempt with no order is an attempt conjured from air —
 * and `attempts_grant_matches_order` is a trigger that reads the order, so the
 * two must be visible to each other.
 *
 * ## `ON CONFLICT DO NOTHING` with NO target, deliberately
 *
 * This is the whole idempotency story and it is why the target is omitted. Three
 * different constraints can legitimately swallow this insert, and naming one of
 * them would leave the other two throwing:
 *
 * | Constraint | The case it catches |
 * |---|---|
 * | `orders_provider_event_uk` | Dodo redelivers the same event. `brief §2.2`. |
 * | `orders_payment_grant_uk` | Dodo emits **two different event ids for one payment** — a retry re-enveloped with a fresh id, or an authorize/settle pair. `attempts_idempotency_key_uk` cannot see this one: the keys differ, because `grantIdempotencyKey` is `dodo:event:<event id>`. |
 * | `attempts_idempotency_key_uk` | The order landed on a previous delivery and the attempt did not. |
 *
 * A swallowed insert returns no row, and no row is what this store reports as
 * `duplicate`. `AppendResult`'s own comment is right that `duplicate` is a
 * SUCCESS: it is what a correctly retried webhook looks like, and the caller's
 * response is to report the balance and move on.
 *
 * ## `currency` and `raw_event`, the two columns an `AttemptEntry` cannot carry
 *
 * `AttemptEntryReason`'s grant arm has the event id, the payment id, the tier and
 * the amount. `orders` also needs a currency and the verbatim event.
 *
 * The currency is `USD` and that is derived rather than assumed. `tierForPayment`
 * returns `null` for anything whose currency is not `SUPPORTED_CURRENCY`, and
 * `handleDodoWebhook` turns a null tier into `needs_review` without ever reaching
 * the ledger. So a grant that arrives here is USD by construction, and writing
 * anything else would mean the handler had been rewritten.
 *
 * The raw event is supplied at construction, because the route has the exact
 * bytes before it has anything else — that is the same string
 * `verifyWebhookSignature` covered. A store built without one refuses a grant
 * rather than writing `'{}'`: `brief §2.2` prices a dispute at $30, and arguing
 * one without the payload the decision was made on is not possible.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { attemptRow, type LedgerEntry } from './identity.js';
import { createPostgresWebhookAccounts, type EnsuredAccount } from './identity-store.js';
import { attempts, orders, submissions, webhookEvents } from './schema/index.js';

/** The provider these stores speak for, unless told otherwise. */
export const DEFAULT_PAYMENTS_PROVIDER = 'dodo';

/**
 * The only currency the tiers are priced in.
 *
 * Mirrors `SUPPORTED_CURRENCY` in `@the-pit/payments`. Re-declared rather than
 * imported for the reason `identity.ts` gives about `LedgerEntry`: `apps/web`
 * depends on this package and it must not put the payments package into its
 * published type surface. See the module header for why a grant reaching this
 * file is USD by construction.
 */
const GRANT_CURRENCY = 'USD';

/** Mirrors `AppendResult` in `@the-pit/payments`. */
export type AppendOutcome =
  | { readonly outcome: 'appended'; readonly balance: number }
  | { readonly outcome: 'duplicate'; readonly balance: number };

/** Mirrors `AttemptsStore` in `@the-pit/payments`. */
export interface PostgresAttemptsStore {
  append(entry: LedgerEntry): Promise<AppendOutcome>;
  balance(accountId: string): Promise<number>;
}

/** Mirrors `WebhookStore` in `@the-pit/payments`. */
export interface PostgresWebhookStore {
  ensureAccount(input: { readonly email: string; readonly now: Date }): Promise<EnsuredAccount>;
  recordEvent(input: {
    readonly eventId: string;
    readonly type: string;
    readonly receivedAt: Date;
    readonly outcome: string;
  }): Promise<'recorded' | 'duplicate'>;
  queueForReview(input: {
    readonly eventId: string;
    readonly reason: string;
    readonly event: unknown;
  }): Promise<void>;
}

export interface PaymentsStoreOptions {
  /** `dodo`. Named so a second processor cannot collide event-id spaces. */
  readonly provider?: string;
  /** `mintCapabilitySlug` from `@the-pit/auth`; injected so this package does not depend on it. */
  readonly mintSlug?: () => string;
}

export interface AttemptsStoreOptions extends PaymentsStoreOptions {
  /**
   * The verified webhook body, byte for byte, for `orders.raw_event`.
   *
   * Required to write a GRANT and irrelevant to a consume, which is why it is
   * optional here and checked at the point of use. See the module header.
   */
  readonly rawEvent?: string;
}

/**
 * `WebhookStore`, implemented.
 *
 * `ensureAccount` is `createPostgresWebhookAccounts`' single upsert, unchanged and
 * delegated rather than re-stated — it is the one function in this repository
 * that inserts into `accounts`, and there must go on being exactly one.
 */
export function createPostgresWebhookStore(
  db: Database,
  options: PaymentsStoreOptions = {},
): PostgresWebhookStore {
  const provider = options.provider ?? DEFAULT_PAYMENTS_PROVIDER;
  const accounts = createPostgresWebhookAccounts(
    db,
    options.mintSlug === undefined ? {} : { mintSlug: options.mintSlug },
  );

  return {
    ensureAccount(input: { email: string; now: Date }): Promise<EnsuredAccount> {
      return accounts.ensureAccount(input);
    },

    async recordEvent(input: {
      eventId: string;
      type: string;
      receivedAt: Date;
      outcome: string;
    }): Promise<'recorded' | 'duplicate'> {
      // `webhook_events_provider_event_uk` decides, not a SELECT. Two concurrent
      // deliveries of one dispute both reach this line; exactly one gets a row
      // back, and only that one is allowed to file a ticket.
      const inserted = await db
        .insert(webhookEvents)
        .values({
          provider,
          providerEventId: input.eventId,
          type: input.type,
          outcome: input.outcome,
          receivedAt: input.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });

      return inserted.length === 0 ? 'duplicate' : 'recorded';
    },

    async queueForReview(input: { eventId: string; reason: string; event: unknown }): Promise<void> {
      // An UPDATE and not an INSERT, because `handleDodoWebhook` only calls this
      // after a `recorded` answer from `recordEvent` — so the row exists, and
      // writing a second one would put the same event on the queue twice under
      // two ids, which is the duplication this table was added to prevent.
      await db
        .update(webhookEvents)
        .set({ reviewReason: input.reason, payload: input.event })
        .where(
          and(eq(webhookEvents.provider, provider), eq(webhookEvents.providerEventId, input.eventId)),
        );
    },
  };
}

/**
 * `AttemptsStore`, implemented.
 *
 * Both invariants `packages/payments` says it deliberately does not enforce
 * itself — "in the database, not here" — are enforced by the schema this writes
 * to: `attempts_idempotency_key_uk` for retry safety, and the
 * `attempts_no_overdraft` trigger for the balance. Neither is re-checked here,
 * because a check in TypeScript over a value read a moment earlier is exactly the
 * race the constraints exist to win.
 */
export function createPostgresAttemptsStore(
  db: Database,
  options: AttemptsStoreOptions = {},
): PostgresAttemptsStore {
  const provider = options.provider ?? DEFAULT_PAYMENTS_PROVIDER;

  async function balanceOf(tx: Database, accountId: string): Promise<number> {
    const rows = await tx
      .select({ balance: sql<number>`coalesce(sum(${attempts.delta}), 0)::int` })
      .from(attempts)
      .where(eq(attempts.accountId, accountId));
    return Number(rows[0]?.balance ?? 0);
  }

  return {
    async append(entry: LedgerEntry): Promise<AppendOutcome> {
      return db.transaction(async (tx) => {
        if (entry.reason.kind !== 'grant') {
          // A consume or an adjustment names no order, so `attemptRow` is given
          // no context and `attempts_consume_has_job` /
          // `attempts_adjustment_has_reason` police the rest.
          const written = await tx
            .insert(attempts)
            .values(attemptRow(entry))
            .onConflictDoNothing()
            .returning({ id: attempts.id });

          return {
            outcome: written.length === 0 ? 'duplicate' : 'appended',
            balance: await balanceOf(tx, entry.accountId),
          };
        }

        if (options.rawEvent === undefined) {
          throw new RangeError(
            'createPostgresAttemptsStore: refused a grant with no raw event. `orders.raw_event` is the ' +
              'verified payload a $30 dispute is argued from (brief §2.2); build the store with the ' +
              'request body the signature covered.',
          );
        }

        const reason = entry.reason;

        // No conflict TARGET. Three constraints can legitimately swallow this and
        // naming one would leave the other two throwing — see the module header.
        const order = await tx
          .insert(orders)
          .values({
            provider,
            providerEventId: reason.providerEventId,
            providerPaymentId: reason.providerPaymentId,
            accountId: entry.accountId,
            amountCents: reason.amountCents,
            currency: GRANT_CURRENCY,
            // The trigger `attempts_grant_matches_order` compares this to the
            // ledger row's delta, so they are written from the one value.
            attemptsGranted: entry.delta,
            // Always false, and the column stays. The only tier that ever set it
            // bundled a fit report nothing in this repository generates, so it
            // was withdrawn from sale; the column is kept because the rows that
            // carry `true` were really sold and a migration that dropped it would
            // rewrite what those buyers were charged for.
            includesFitReport: false,
            status: 'paid',
            rawEvent: sql`${options.rawEvent}::jsonb`,
            receivedAt: entry.createdAt,
            createdAt: entry.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: orders.id });

        const orderId = order[0]?.id;
        if (orderId === undefined) {
          // Already granted, by this event id or by another one for the same
          // payment. Nothing is written and the balance stands.
          return { outcome: 'duplicate', balance: await balanceOf(tx, entry.accountId) };
        }

        const written = await tx
          .insert(attempts)
          .values(attemptRow(entry, { orderId }))
          .onConflictDoNothing()
          .returning({ id: attempts.id });

        return {
          outcome: written.length === 0 ? 'duplicate' : 'appended',
          balance: await balanceOf(tx, entry.accountId),
        };
      });
    },

    balance(accountId: string): Promise<number> {
      // `attempts_account_idx` is `(account_id, created_at)`, so the fold is a
      // range scan on the leading column rather than a table scan.
      return balanceOf(db, accountId);
    },
  };
}

/** One pending pitch, as it was typed. */
export interface SubmissionDraftRow {
  readonly submissionId: string;
  readonly categorySlug: string;
  readonly name: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly description: string;
  readonly descriptionHash: string;
  /**
   * What the founder claims, in their own words, or `null` when they said
   * nothing.
   *
   * Separate from `description`, which is now the SITE's copy — pre-filled from
   * the product's own page by `POST /api/site-metadata`. `null` and `''` are
   * deliberately not the same thing here: one is a founder who left the field
   * alone, the other would be a claim they never made.
   */
  readonly pitch: string | null;
  /**
   * Published without a name or a URL, chosen on the form before anybody scored
   * anything.
   *
   * Not optional and not nullable. Every other field on this row is text somebody
   * typed; this one is a decision, and "the buyer did not say" is not one of its
   * values — the form always sends a value and the route defaults an absent one to
   * `false` explicitly, so by the time a draft reaches here the answer exists.
   * Making it optional would let a writer omit it and publish a name by accident,
   * which is the one mistake on this path that cannot be taken back.
   *
   * `products.anonymous` is where it lands and where it freezes
   * (`products_anonymity_immutable`).
   */
  readonly anonymous: boolean;
  readonly cycleId: string;
  /**
   * `single` is the only tier on sale, so it is the only value written. The
   * retired `triple` stays in the union — and in `submissions_tier_known` — because
   * rows written before it was withdrawn still hold it and a read must be able to
   * say so.
   */
  readonly tier: 'single' | 'triple';
  readonly attemptNumber: number;
  readonly repitchOf: string | null;
}

export interface PostgresSubmissionStore {
  /** Persist a draft before checkout opens, and return the id that crosses Dodo. */
  create(draft: Omit<SubmissionDraftRow, 'submissionId'> & { now: Date }): Promise<string>;
  /** Read one back on the webhook. `null` for an id that never existed. */
  find(submissionId: string): Promise<SubmissionDraftRow | null>;
}

/**
 * The pending-pitch store.
 *
 * `find` takes a raw string off a webhook payload, so it must survive one that is
 * not a uuid at all: `submission_id` arrives in Dodo metadata, which is
 * attacker-influenced by construction (`DodoCheckoutRequest.metadata` says so).
 * Postgres would answer a malformed uuid with `22P02` — an exception on the money
 * path — so the shape is checked here and a non-uuid is `null`, which is the same
 * answer an unknown id gets.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresSubmissionStore(db: Database): PostgresSubmissionStore {
  return {
    async create(draft): Promise<string> {
      const inserted = await db
        .insert(submissions)
        .values({
          categorySlug: draft.categorySlug,
          name: draft.name,
          url: draft.url,
          normalizedUrl: draft.normalizedUrl,
          description: draft.description,
          descriptionHash: draft.descriptionHash,
          pitch: draft.pitch,
          anonymous: draft.anonymous,
          cycleId: draft.cycleId,
          tier: draft.tier,
          attemptNumber: draft.attemptNumber,
          repitchOf: draft.repitchOf,
          createdAt: draft.now,
        })
        .returning({ id: submissions.id });

      const id = inserted[0]?.id;
      if (id === undefined) {
        throw new Error('createPostgresSubmissionStore: the insert returned no row');
      }
      return id;
    },

    async find(submissionId: string): Promise<SubmissionDraftRow | null> {
      if (!UUID_SHAPE.test(submissionId)) return null;

      const rows = await db
        .select({
          submissionId: submissions.id,
          categorySlug: submissions.categorySlug,
          name: submissions.name,
          url: submissions.url,
          normalizedUrl: submissions.normalizedUrl,
          description: submissions.description,
          descriptionHash: submissions.descriptionHash,
          pitch: submissions.pitch,
          anonymous: submissions.anonymous,
          cycleId: submissions.cycleId,
          tier: submissions.tier,
          attemptNumber: submissions.attemptNumber,
          repitchOf: submissions.repitchOf,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return null;
      // `submissions_tier_known` restricts the column to the two tiers; the cast
      // states what the constraint already guarantees.
      return { ...row, tier: row.tier as 'single' | 'triple' };
    },
  };
}
