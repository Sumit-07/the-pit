/**
 * The attempts ledger service: the only code in the project that moves an
 * attempt.
 *
 * Two write paths, and they are the two sentences in `brief §2.3`:
 *
 * - `grant` — attempts appear on a SIGNED WEBHOOK and nowhere else. Keyed on
 *   Dodo's event id, so a retried webhook grants nothing the second time.
 * - `deliver` — an attempt is consumed in the SAME TRANSACTION that writes the
 *   verdict and marks it delivered. There is no other decrement in this
 *   package, and no method that decrements without writing a verdict.
 *
 * And one non-write path that exists to be a no-op: `noteRunStarted`. `brief
 * §2.3` names two moments that specifically must NOT charge — job start and
 * pipeline completion — and a hook that visibly refuses to charge is a better
 * record of that rule than its absence. Pipeline completion is covered by
 * `decideAttempt` being pure: the pipeline finishing produces a DECISION, and
 * only the `consume` arm of that decision reaches this class.
 */

import type { AttemptDecision } from './decide.js';
import type {
  AppendResult,
  AttemptEntry,
  AttemptsStore,
  VerdictWrite,
  WithDeliveryTx,
} from './types.js';
import type { PriceTier } from '../money.js';

/**
 * The idempotency key for a grant: Dodo's own event id, namespaced.
 *
 * The namespace matters. Grants and consumes share one unique index, and an
 * unprefixed provider id could in principle collide with a run id. Two money
 * events silently deduplicating against each other is the failure this prefix
 * costs six characters to make impossible.
 *
 * Keyed on the EVENT id because `brief §2.2` says so. The residual exposure is
 * worth naming: if Dodo ever emitted two distinct `payment.succeeded` event ids
 * for one payment, this key would grant twice. A partial unique index on the
 * payment id, over grant rows only, closes that at no cost — see the Phase 3
 * report's schema section.
 */
export function grantIdempotencyKey(providerEventId: string): string {
  return `dodo:event:${providerEventId}`;
}

/**
 * The idempotency key for a consume: the run whose verdict is being delivered.
 *
 * Keyed on the RUN, not on the attempt or the timestamp, because a run delivers
 * exactly once and a retried delivery — an Inngest step replayed after a
 * connection drop, a worker that came back and finished the job twice — is the
 * same run. A retried delivery therefore appends nothing and the customer is
 * charged once, which is the same guarantee the webhook gets, from the same
 * index.
 */
export function consumeIdempotencyKey(runId: string): string {
  return `delivery:run:${runId}`;
}

export interface GrantInput {
  readonly accountId: string;
  readonly tier: PriceTier;
  readonly providerEventId: string;
  readonly providerPaymentId: string;
  readonly amountCents: number;
  readonly now: Date;
}

export interface GrantResult {
  readonly outcome: 'granted' | 'duplicate';
  readonly attemptsGranted: number;
  readonly balance: number;
}

export interface DeliverInput {
  /** Must be the `consume` arm. Anything else throws rather than silently no-op. */
  readonly decision: AttemptDecision;
  readonly verdict: VerdictWrite;
  readonly now: Date;
}

export type DeliverResult =
  | { readonly outcome: 'delivered'; readonly balance: number; readonly verdictId: string }
  /** The same run delivered twice. The verdict stands; the customer is charged once. */
  | { readonly outcome: 'already_delivered'; readonly balance: number; readonly verdictId: string };

/** What `noteRunStarted` returns: a record that says, in a field, that nothing moved. */
export interface RunStartRecord {
  readonly runId: string;
  readonly startedAt: Date;
  /** Always 0. `brief §2.3`: not on job start. */
  readonly attemptsMoved: 0;
}

export class AttemptsLedger {
  readonly #store: AttemptsStore;
  readonly #withTx: WithDeliveryTx;

  constructor(store: AttemptsStore, withDeliveryTx: WithDeliveryTx) {
    this.#store = store;
    this.#withTx = withDeliveryTx;
  }

  /** Sum of the ledger for one account. */
  async balance(accountId: string): Promise<number> {
    return this.#store.balance(accountId);
  }

  /**
   * A run started. Records the moment and moves nothing.
   *
   * Takes no store and returns no promise, so there is no version of this that
   * quietly grows a write later without changing its signature.
   */
  noteRunStarted(input: { runId: string; startedAt: Date }): RunStartRecord {
    return { runId: input.runId, startedAt: input.startedAt, attemptsMoved: 0 };
  }

  /**
   * Credit a settled payment. Called by the webhook handler and by nothing else
   * — in particular, never by the success-redirect route (`brief §2.2`).
   */
  async grant(input: GrantInput): Promise<GrantResult> {
    const entry: AttemptEntry = {
      accountId: input.accountId,
      delta: input.tier.attempts,
      reason: {
        kind: 'grant',
        providerEventId: input.providerEventId,
        providerPaymentId: input.providerPaymentId,
        tier: input.tier.id,
        amountCents: input.amountCents,
      },
      idempotencyKey: grantIdempotencyKey(input.providerEventId),
      createdAt: input.now,
    };

    const result: AppendResult = await this.#store.append(entry);
    return {
      outcome: result.outcome === 'appended' ? 'granted' : 'duplicate',
      attemptsGranted: result.outcome === 'appended' ? input.tier.attempts : 0,
      balance: result.balance,
    };
  }

  /**
   * Write the verdict, mark it delivered, and consume one attempt — all three or
   * none of the three.
   *
   * Write order inside the transaction is verdict, then delivered flag, then
   * ledger. A `DeliveryTx` implementation that fails to be a real transaction
   * therefore breaks toward "delivered but not charged" rather than "charged but
   * not delivered". Neither is acceptable; only one of them is survivable.
   *
   * A store that refuses the decrement (`InsufficientAttemptsError`) rejects the
   * whole transaction, so no verdict is written either. A run that reached
   * delivery with no attempt behind it is a bug upstream, and delivering it
   * anyway would hide the bug behind free work.
   */
  async deliver(input: DeliverInput): Promise<DeliverResult> {
    if (input.decision.action !== 'consume') {
      throw new RangeError(
        `AttemptsLedger.deliver: refused a '${input.decision.action}' decision. ` +
          'Only a consume decision may write a verdict; brief §2.3 forbids delivering anything else.',
      );
    }

    const { verdict } = input;
    return this.#withTx(async (tx): Promise<DeliverResult> => {
      await tx.writeVerdict(verdict);
      await tx.markDelivered({
        runId: verdict.runId,
        verdictId: verdict.verdictId,
        deliveredAt: input.now,
      });
      const appended = await tx.appendAttemptEntry({
        accountId: verdict.accountId,
        delta: -1,
        reason: {
          kind: 'consume',
          runId: verdict.runId,
          verdictId: verdict.verdictId,
          listingId: verdict.listingId,
        },
        idempotencyKey: consumeIdempotencyKey(verdict.runId),
        createdAt: input.now,
      });
      return {
        outcome: appended.outcome === 'appended' ? 'delivered' : 'already_delivered',
        balance: appended.balance,
        verdictId: verdict.verdictId,
      };
    });
  }
}
