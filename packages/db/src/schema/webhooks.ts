/**
 * `webhook_events` — the audit trail behind the one endpoint that can create
 * money, and the review queue a human is routed to.
 *
 * ## Why this is not `orders`
 *
 * `orders` already records every payment event that GRANTS, and its
 * `(provider, provider_event_id)` unique is the idempotency constraint
 * `brief §2.2` names. It cannot record the others, and the reason is structural
 * rather than aesthetic: `orders.account_id` is `NOT NULL`, and
 * `@the-pit/payments`' `handleDodoWebhook` calls `WebhookStore.recordEvent`
 * BEFORE `ensureAccount` for every event it is not going to grant on — a refund,
 * a dispute, a `payment.failed`, an amount we refuse to price. At that moment
 * there is no account id to write, and there must not be: resolving one would
 * mean creating an account for a payment that did not succeed.
 *
 * So the events that grant live in `orders`, keyed to a payer, and every event
 * we merely SAW lives here, keyed to nothing but the provider's own event id.
 * The two are deliberately not merged. `orders` is the money record and every
 * row in it means someone paid; this is the log, and a row in it means only that
 * a correctly signed envelope arrived.
 *
 * ## What it is for, in order of how expensive getting it wrong is
 *
 * 1. **Not filing the same ticket twice.** `brief §2.2` prices a dispute at $30
 *    and a refund at $1, and Dodo retries. `handleDodoWebhook` calls
 *    `queueForReview` only when `recordEvent` answered `recorded` — so the
 *    UNIQUE below is what makes the second delivery of one dispute silent.
 * 2. **Arguing a dispute.** `payload` is the verified event as we parsed it.
 *    `orders.raw_event` holds the same thing for a payment that granted; this
 *    holds it for the ones that did not, which are precisely the events a
 *    chargeback argument is about.
 * 3. **Explaining a balance.** `outcome` records what the handler decided —
 *    `granted`, `duplicate`, `unpriced`, `not_a_grant` — so "why did this $5 not
 *    become an attempt" is answerable from one row rather than reconstructed
 *    from logs that have rotated.
 *
 * ## It is NOT the idempotency guard for grants
 *
 * `@the-pit/payments`' `checkout/webhook.ts` is explicit about this and the
 * ordering it forces: a crash between recording the event and appending the
 * grant would, if this table were the guard, lose a customer's attempts forever
 * — the retry would see the recorded id and skip. The guard is
 * `attempts_idempotency_key_uk` and `orders_provider_event_uk` /
 * `orders_payment_grant_uk`, all of which sit on the write that actually moves
 * money. This table is written LAST, and it is allowed to fail.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `dodo` today. Named so a second processor cannot collide event-id spaces. */
    provider: text('provider').notNull().default('dodo'),

    /**
     * The provider's own id for this event — the value `brief §2.2` keys
     * idempotency on, and the whole reason this table has a UNIQUE at all.
     */
    providerEventId: text('provider_event_id').notNull(),

    /** `payment.succeeded`, `refund.succeeded`, … Stored as text rather than as an
     * enum: this column records what a THIRD PARTY sent us, and a value we have
     * never seen before is exactly the thing the log needs to be able to hold. An
     * enum would make an unrecognised event type a failed INSERT on the money
     * path, which is the one place a schema should not be strict about a
     * stranger's vocabulary. */
    type: text('type').notNull(),

    /** What the handler decided: `granted`, `duplicate`, `unpriced`, `not_a_grant`. */
    outcome: text('outcome').notNull(),

    /**
     * Why a human has to look at this, or null. Set by `queueForReview`, which
     * runs at most once per event because `recordEvent` reports `duplicate` on
     * every retry.
     */
    reviewReason: text('review_reason'),

    /** Set when the row is resolved by a person. Null means still on the queue. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    /** The verified event, as parsed. Null until something asks for a review. */
    payload: jsonb('payload'),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One row per provider event. This is what makes a retried dispute file one
     * ticket instead of one per delivery — `recordEvent` inserts with
     * `ON CONFLICT DO NOTHING` and reports `duplicate` when nothing came back.
     */
    unique('webhook_events_provider_event_uk').on(t.provider, t.providerEventId),

    /** "What is waiting for a human", the only query the review queue makes. */
    index('webhook_events_review_idx').on(t.reviewedAt, t.receivedAt),

    /** Matches `orders.provider` and `account_identities.provider`. */
    check('webhook_events_provider_shape', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,31}$'`),

    /** An empty event id would make the UNIQUE above protect nothing. */
    check(
      'webhook_events_event_id_present',
      sql`char_length(${t.providerEventId}) between 1 and 255`,
    ),

    /**
     * A resolved row must say what it was resolved FROM. Without this, marking a
     * row reviewed when it was never queued would read, later, as a dispute
     * somebody handled.
     */
    check(
      'webhook_events_reviewed_implies_queued',
      sql`${t.reviewedAt} is null or ${t.reviewReason} is not null`,
    ),
  ],
);
