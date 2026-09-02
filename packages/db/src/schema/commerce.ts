/**
 * `orders` and `attempts` — the money path.
 *
 * Both tables exist to make two sentences from the brief true at the database
 * level rather than in a code review comment:
 *
 * - `§2.2`: "Grant attempts on the **signed webhook**, never on the success
 *   redirect. Webhook handler must be **idempotent** — Dodo retries."
 * - `§2.3`: "An attempt is **consumed only on delivery** — decrement in the same
 *   transaction that writes the verdict and marks it delivered. Not on job start,
 *   not on pipeline completion." And: "Failures are free retries."
 *
 * Both tables key the payer with `account_id`, a foreign key onto `accounts`.
 * They originally carried a lowercased `account_email` instead, on the reasoning
 * that `brief §2.1` has no login at submission and identifies a returning payer
 * only by a magic link to the address Dodo verified. The address is still the
 * identity — it is UNIQUE on `accounts` for exactly that reason — but a copy of
 * it on every table is a foreign key with no referent, and nothing stopped
 * `attempts` holding a balance for an address `orders` had never seen. See
 * `schema/accounts.ts`.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.js';
import { attemptKind, orderStatus } from './enums.js';
import { jobs } from './jobs.js';
import { products } from './products.js';

/**
 * One payment event from the merchant of record.
 *
 * The row is created by the signed webhook handler and by nothing else. Its
 * `(provider, provider_event_id)` unique constraint IS the idempotency mechanism:
 * Dodo's retry of the same event loses the insert with a unique violation, the
 * transaction rolls back, and the attempts it would have granted are not granted
 * twice. That is a database guarantee rather than a "check first, then insert"
 * read-modify-write, which two concurrent retries can both pass.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `dodo` today. Named so a second processor cannot collide event-id spaces. */
    provider: text('provider').notNull().default('dodo'),

    /**
     * The provider's own id for THIS event — not for the payment. A payment
     * produces several events (succeeded, refunded, disputed) and a retry
     * reproduces one of them verbatim; the unique is on the event so a refund is
     * not mistaken for a duplicate of the charge.
     */
    providerEventId: text('provider_event_id').notNull(),

    /** The provider's payment id. Several events share it; not unique. */
    providerPaymentId: text('provider_payment_id'),

    /**
     * Who paid. Resolved from the email Dodo collected and verified, which the
     * webhook handler upserts into `accounts` before it writes this row
     * (`brief §2.1`).
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** Gross, in the smallest currency unit. `brief §2.3`: $5. */
    amountCents: integer('amount_cents').notNull(),

    currency: char('currency', { length: 3 }).notNull(),

    /**
     * How many attempts this event grants. `brief §2.3`: "$5 = 1 attempt. Keeps
     * $5 as the atomic unit so 'same five dollars for everyone' stays literally
     * true."
     *
     * Zero for a refund or dispute event, which grants nothing.
     */
    attemptsGranted: integer('attempts_granted').notNull(),

    /**
     * An off-board advisory report (`brief` Part 4) that the withdrawn second
     * tier bundled. Nothing generates one, no tier on sale sets this, and every
     * new order writes `false`. The column stays because the rows that hold
     * `true` are real sales and dropping it would rewrite what they bought.
     */
    includesFitReport: boolean('includes_fit_report').notNull().default(false),

    status: orderStatus('status').notNull(),

    /**
     * The verified webhook body, verbatim. `brief §2.2` prices a dispute at $30;
     * arguing one without the payload the decision was made on is not possible.
     */
    rawEvent: jsonb('raw_event').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * THE idempotency constraint. `brief §2.2`: "Webhook handler must be
     * idempotent — Dodo retries."
     */
    unique('orders_provider_event_uk').on(t.provider, t.providerEventId),

    /**
     * The second half of idempotency, and the one the event id alone does not
     * cover: **one payment grants attempts once**.
     *
     * `brief §2.2` names the event id as the mechanism, and it is the right one
     * for a literal retry — Dodo replays the same envelope and loses on
     * `orders_provider_event_uk`. But a provider can emit two DIFFERENT event ids
     * for a single payment: a retry re-enveloped with a fresh id, or an
     * authorize/settle pair that both report the charge. Both slip past a
     * key on the event id and grant a second attempt for one $5.
     *
     * Scoped to `attempts_granted > 0` so it constrains only the rows that
     * actually hand out attempts. A refund, a dispute, or any other event on the
     * same payment grants nothing, is excluded from the index, and is still
     * recorded — which is what `brief §2.2` needs, since it prices both.
     */
    uniqueIndex('orders_payment_grant_uk')
      .on(t.provider, t.providerPaymentId)
      .where(sql`attempts_granted > 0`),

    index('orders_account_idx').on(t.accountId, t.createdAt),
    index('orders_payment_idx').on(t.provider, t.providerPaymentId),

    check('orders_amount_positive', sql`${t.amountCents} > 0`),
    check('orders_attempts_granted_non_negative', sql`${t.attemptsGranted} >= 0`),
    check('orders_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),

    /**
     * Only a paid order grants anything. A refunded or disputed event that
     * carried a positive grant would hand out attempts for money we no longer
     * have.
     */
    check('orders_grants_only_when_paid', sql`${t.status} = 'paid' or ${t.attemptsGranted} = 0`),

    /**
     * A granting order must name its payment, or `orders_payment_grant_uk` has
     * nothing to constrain: NULLs are all distinct to a unique index, so a grant
     * with a null payment id would be exempt from the one-payment-one-grant rule
     * — which is precisely the hole it was added to close.
     */
    check('orders_grant_names_payment', sql`${t.attemptsGranted} = 0 or ${t.providerPaymentId} is not null`),
  ],
);

/**
 * The attempt LEDGER. Append-only, immutable, one row per movement.
 *
 * `brief §2.3` decides the shape. A mutable `accounts.attempts_remaining` integer
 * can be decremented twice by two concurrent deliveries of the same job, can be
 * decremented by a retry that should have been free, and once wrong carries no
 * record of how it got there. A ledger cannot: the balance is
 * `sum(delta) WHERE account_id = $1`, every row names the order that bought it
 * or the job that spent it, and six database-level guards make the failure modes
 * unrepresentable rather than merely unlikely.
 *
 * ## This table is the store `@the-pit/payments` is written against
 *
 * `AttemptsStore` in `packages/payments/src/attempts/types.ts` names the two
 * invariants it deliberately does NOT enforce itself — "in the database, not
 * here": a UNIQUE `idempotency_key`, and a balance that never goes negative. Both
 * are here, along with four more. The columns line up with `AttemptEntry` field
 * for field so a Postgres implementation of that seam is a direct mapping rather
 * than a translation.
 *
 * The guards. Two are indexes, one is a column constraint, and three need
 * triggers because they read another row or another table
 * (`migrations/0001_ledger_guards.sql`):
 *
 * 1. **One row per money event** — `idempotency_key` is UNIQUE. The payments
 *    ledger keys a grant on Dodo's event id and a consume on the run id, so a
 *    retried webhook and a retried delivery both lose the insert. This single
 *    index is what the payments package calls "the only thing making retries
 *    safe"; everything below is defence in depth behind it.
 * 2. **One consume per job** — a partial unique index. Even if a delivery
 *    somehow produced two different idempotency keys, a job is charged once.
 * 3. **One grant per order** — the same, on the buying side.
 * 4. **A consume requires a delivered job** — `attempts_consume_requires_delivery`,
 *    a trigger, because it reads another table. This is `§2.3`'s "not on job
 *    start, not on pipeline completion": the verdict transaction must set
 *    `jobs.delivered_at` before it may insert the decrement, and a free retry of
 *    a failed job never can.
 * 5. **A grant matches what was paid for** — `attempts_grant_matches_order`, a
 *    trigger. `delta` must equal the order's `attempts_granted`, so a bug in the
 *    webhook handler cannot hand out four attempts for a three-attempt order.
 * 6. **No overdraft** — `attempts_no_overdraft`, a trigger, because a balance is
 *    an aggregate over rows.
 *
 * And underneath all six, **append-only**: `attempts_immutable` refuses UPDATE
 * and DELETE outright. Without it the ledger is a slower mutable counter.
 */
export const attempts = pgTable(
  'attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Whose balance this row moves. `accountId` in `@the-pit/payments`. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    kind: attemptKind('kind').notNull(),

    /**
     * How many attempts this row moves. Positive on a grant, exactly `-1` on a
     * consume, either sign on an adjustment.
     *
     * A grant is ONE row worth whatever the tier bought — `delta` is the tier's
     * `attempts`, which is 1 at today's one price — because the grant is one
     * event: one signed webhook, one idempotency key, one row that either lands
     * or does not. `delta > 1` is still allowed: a tier that grants several is a
     * pricing decision, and this column must not be the thing that forbids it.
     * A consume is always exactly one, because a delivery delivers one verdict.
     */
    delta: integer('delta').notNull(),

    /**
     * The one index that makes both money paths safe under retry.
     *
     * `@the-pit/payments` builds it as `dodo:event:<providerEventId>` for a grant
     * and `delivery:run:<runId>` for a consume — namespaced precisely so a
     * provider id and a run id cannot silently deduplicate against each other.
     * This table does not care about the format, only that it is unique: a
     * "check, then insert" in application code loses the race Dodo's retry
     * actually creates, and this does not.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /** The purchase. Non-null exactly on a grant. */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** The delivered run that spent it. Non-null exactly on a consume. */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** What the consume was spent on, for the account's history page. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** Why a human moved the balance. Non-null exactly on an adjustment. */
    note: text('note'),

    /** Who moved it. Free text is acceptable on this arm and on no other. */
    actor: text('actor'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Guard 1. One row per money event, whichever direction it moves. */
    unique('attempts_idempotency_key_uk').on(t.idempotencyKey),

    /**
     * Guard 2. A job is charged for at most once, whatever the delivery path
     * does — a retried or double-fired delivery transaction cannot bill a
     * customer twice for one verdict.
     */
    uniqueIndex('attempts_one_consume_per_job_uk')
      .on(t.jobId)
      .where(sql`kind = 'consume'`),

    /** Guard 3. An order grants once. */
    uniqueIndex('attempts_one_grant_per_order_uk')
      .on(t.orderId)
      .where(sql`kind = 'grant'`),

    /** The balance read: `sum(delta)` for one account. */
    index('attempts_account_idx').on(t.accountId, t.createdAt),
    index('attempts_order_idx').on(t.orderId),

    /** A row that moves nothing is noise in the integrity record. */
    check('attempts_delta_non_zero', sql`${t.delta} <> 0`),

    /**
     * `kind` and `delta` say the same thing and are never allowed to disagree. A
     * grant that decrements, or a consume that takes two attempts for one
     * verdict, is refused here rather than discovered in a support ticket.
     */
    check(
      'attempts_kind_matches_delta',
      sql`(${t.kind} = 'grant' and ${t.delta} > 0)
          or (${t.kind} = 'consume' and ${t.delta} = -1)
          or ${t.kind} = 'adjustment'`,
    ),

    /**
     * Every grant traces to a paid order, every consume to a job, every
     * adjustment to a person. A row with none of those would be an attempt
     * conjured from nothing.
     */
    check('attempts_grant_has_order', sql`(${t.kind} = 'grant') = (${t.orderId} is not null)`),
    check('attempts_consume_has_job', sql`(${t.kind} = 'consume') = (${t.jobId} is not null)`),
    check(
      'attempts_adjustment_has_reason',
      sql`(${t.kind} = 'adjustment') = (${t.actor} is not null and ${t.note} is not null)`,
    ),
  ],
);
