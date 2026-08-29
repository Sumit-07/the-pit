/**
 * The webhook handler — the only place in the project where attempts are
 * created.
 *
 * `brief §2.2`, three sentences, all of them load-bearing:
 *
 * > Grant attempts on the **signed webhook**, never on the success redirect.
 * > Webhook handler must be **idempotent** — Dodo retries.
 *
 * ## Where idempotency actually comes from
 *
 * Not from `WebhookStore.recordEvent`. That table is an audit trail and a
 * dedupe for the non-granting events; if it were the guard, there would be a
 * window between recording the event and appending the grant in which a crash
 * loses a customer's attempts permanently — the retry would see the recorded id
 * and skip.
 *
 * The guard is the UNIQUE index on `attempt_ledger.idempotency_key`, and the key
 * is `dodo:event:<Dodo's event id>`. That makes the grant itself idempotent, so
 * the handler can be written in the only crash-safe order:
 *
 *   1. verify the signature — before parsing, because an unverified body is
 *      attacker-authored;
 *   2. resolve the account from the email Dodo verified (`brief §2.1`);
 *   3. append the grant, which no-ops on a replay;
 *   4. record the event id, which is allowed to fail without losing money.
 *
 * A crash between any two of those steps leaves a retry that reaches the same
 * end state. A crash before step 3 grants nothing and Dodo retries, which is the
 * correct direction.
 *
 * ## HTTP status is part of the contract
 *
 * Every result carries the status the route must answer with, because getting
 * this backwards is silent and expensive: 200 tells Dodo to stop retrying. A
 * body we could not verify, or could not parse, gets 400 so the retries keep
 * coming and the alarm fires. Everything we understood — including an event we
 * chose to ignore and an amount we refuse to price — gets 200, because retrying
 * it would not change the answer.
 *
 * ## The amount is never turned into attempts by arithmetic
 *
 * `tierForPayment` returns `null` for anything unrecognised and this handler
 * turns that into `needs_review`. Nothing here divides by 500. See
 * `src/money.ts`.
 */

import type { AttemptsLedger } from '../attempts/ledger.js';
import type { PriceTier } from '../money.js';
import { tierForPayment } from '../money.js';
import { verifyWebhookSignature } from './signature.js';
import type { DodoConfig, DodoEvent } from './types.js';
import { parseDodoEvent } from './types.js';

/** An account, resolved from the email Dodo verified while taking the payment. */
export interface ResolvedAccount {
  readonly accountId: string;
  readonly created: boolean;
}

export interface WebhookStore {
  /**
   * Find or create the account for a verified email. `brief §2.1`: the account
   * is created server-side from the webhook, so the first magic link most people
   * follow already has results waiting behind it.
   */
  ensureAccount(input: { email: string; now: Date }): Promise<ResolvedAccount>;
  /**
   * Record that this provider event id was handled. UNIQUE on the event id;
   * returns `duplicate` without inserting on conflict. An audit trail and a
   * dedupe for non-granting events — NOT the idempotency guard for grants.
   */
  recordEvent(input: {
    eventId: string;
    type: string;
    receivedAt: Date;
    outcome: string;
  }): Promise<'recorded' | 'duplicate'>;
  /**
   * Park an event a human has to look at: an amount we do not price, a refund, a
   * dispute. Should itself be keyed on the event id so a retry does not file the
   * same ticket twice.
   */
  queueForReview(input: { eventId: string; reason: string; event: DodoEvent }): Promise<void>;
}

export type WebhookResult =
  | {
      readonly status: 'granted';
      readonly httpStatus: 200;
      readonly accountId: string;
      readonly accountCreated: boolean;
      readonly tier: PriceTier;
      readonly attemptsGranted: number;
      readonly balance: number;
      readonly event: DodoEvent;
    }
  | {
      /** A retry of an event we already granted. Grants nothing; still a 200. */
      readonly status: 'duplicate';
      readonly httpStatus: 200;
      readonly accountId: string;
      readonly attemptsGranted: 0;
      readonly balance: number;
      readonly event: DodoEvent;
    }
  | {
      /** Understood, deliberately not acted on (a failed or processing payment). */
      readonly status: 'ignored';
      readonly httpStatus: 200;
      readonly reason: string;
      readonly event: DodoEvent;
    }
  | {
      /** Understood, but a human has to decide. Never a guess at the attempt count. */
      readonly status: 'needs_review';
      readonly httpStatus: 200;
      readonly reason: string;
      readonly event: DodoEvent;
    }
  | {
      /** Not verified or not parseable. 400, so Dodo keeps retrying and we get paged. */
      readonly status: 'rejected';
      readonly httpStatus: 400;
      readonly reason: string;
    };

export interface HandleWebhookInput {
  /** The request body as bytes-in, never a re-serialized object. */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly config: DodoConfig;
  readonly ledger: AttemptsLedger;
  readonly store: WebhookStore;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}

export async function handleDodoWebhook(input: HandleWebhookInput): Promise<WebhookResult> {
  const signature = verifyWebhookSignature({
    rawBody: input.rawBody,
    headers: input.headers,
    secret: input.config.webhookSecret,
    now: input.now,
    ...(input.toleranceSeconds === undefined ? {} : { toleranceSeconds: input.toleranceSeconds }),
  });
  if (!signature.valid) {
    return { status: 'rejected', httpStatus: 400, reason: `signature: ${signature.reason}` };
  }

  const parsed = parseDodoEvent(input.rawBody);
  if (!parsed.ok) {
    return { status: 'rejected', httpStatus: 400, reason: `payload: ${parsed.reason}` };
  }
  const event = parsed.event;

  if (event.type !== 'payment.succeeded') {
    // Refunds and disputes cost real money to get wrong ($30 a dispute per
    // `brief §2.2`) and no automatic clawback is defensible on a $5 sale, so
    // they go to a human. `recordEvent` is what stops a retry filing twice.
    const seen = await input.store.recordEvent({
      eventId: event.id,
      type: event.type,
      receivedAt: input.now,
      outcome: 'not_a_grant',
    });
    if (seen === 'recorded' && (event.type === 'refund.succeeded' || event.type === 'dispute.opened')) {
      await input.store.queueForReview({ eventId: event.id, reason: event.type, event });
    }
    return { status: 'ignored', httpStatus: 200, reason: `event type ${event.type}`, event };
  }

  const tier = tierForPayment(
    { amountCents: event.amountCents, currency: event.currency, productId: event.productId },
    input.config.productIds,
  );
  if (tier === null) {
    const seen = await input.store.recordEvent({
      eventId: event.id,
      type: event.type,
      receivedAt: input.now,
      outcome: 'unpriced',
    });
    if (seen === 'recorded') {
      await input.store.queueForReview({
        eventId: event.id,
        reason: `unrecognised amount ${event.amountCents} ${event.currency}`,
        event,
      });
    }
    return {
      status: 'needs_review',
      httpStatus: 200,
      reason: `no tier priced at ${event.amountCents} ${event.currency}`,
      event,
    };
  }

  const account = await input.store.ensureAccount({ email: event.customerEmail, now: input.now });

  const grant = await input.ledger.grant({
    accountId: account.accountId,
    tier,
    providerEventId: event.id,
    providerPaymentId: event.paymentId,
    amountCents: event.amountCents,
    now: input.now,
  });

  await input.store.recordEvent({
    eventId: event.id,
    type: event.type,
    receivedAt: input.now,
    outcome: grant.outcome,
  });

  if (grant.outcome === 'duplicate') {
    return {
      status: 'duplicate',
      httpStatus: 200,
      accountId: account.accountId,
      attemptsGranted: 0,
      balance: grant.balance,
      event,
    };
  }

  return {
    status: 'granted',
    httpStatus: 200,
    accountId: account.accountId,
    accountCreated: account.created,
    tier,
    attemptsGranted: grant.attemptsGranted,
    balance: grant.balance,
    event,
  };
}
