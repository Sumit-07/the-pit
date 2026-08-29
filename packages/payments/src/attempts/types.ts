/**
 * The attempts ledger: what an entry is, and what a store has to guarantee.
 *
 * ## Why a ledger and not a counter
 *
 * `accounts.attempts_remaining` as an integer column is one `UPDATE ... SET
 * attempts = attempts - 1` away from being wrong forever, with no record of when
 * or why. Every rule in `brief §2.3` is a rule about an EVENT — granted on this
 * webhook, consumed on that delivery, not consumed on this failure — so the
 * durable thing is the event, and the balance is a fold over the events. When a
 * customer says "I paid for three and got one", the ledger answers; a counter
 * only restates the complaint.
 *
 * The balance may still be cached as a column for reads. It must never be the
 * source of truth for a write.
 *
 * ## The two invariants a store must enforce, in the database, not here
 *
 * 1. `idempotency_key` is UNIQUE. Both money paths — granting on a retried
 *    webhook and consuming on a retried delivery — are protected by that one
 *    index, and by nothing else. A "check then insert" in application code
 *    loses the race that Dodo's retry actually creates.
 * 2. Balance never goes negative. Enforced by taking a row lock on the account
 *    and folding the ledger inside the same transaction as the insert
 *    (`SELECT ... FOR UPDATE`), not by trusting a value read a moment earlier.
 *
 * Neither can be enforced by this package. `AttemptsStore` is written so a
 * correct implementation is the obvious one, and `MemoryAttemptsStore` in
 * `test/helpers` enforces both so the tests exercise real contention behaviour.
 */

import type { PriceTierId } from '../money.js';

/** Why an entry exists. The discriminant is what an audit reads first. */
export type AttemptEntryReason =
  | {
      readonly kind: 'grant';
      /** Dodo's event id. Also the idempotency key — see `grantIdempotencyKey`. */
      readonly providerEventId: string;
      readonly providerPaymentId: string;
      readonly tier: PriceTierId;
      readonly amountCents: number;
    }
  | {
      readonly kind: 'consume';
      /** The run whose verdict was delivered in this same transaction. */
      readonly runId: string;
      readonly verdictId: string;
      readonly listingId: string;
    }
  | {
      readonly kind: 'adjustment';
      /** Free text is acceptable here and nowhere else: this arm is a human's decision. */
      readonly note: string;
      readonly actor: string;
    };

/**
 * One immutable row. `delta` is positive on a grant, negative on a consume, and
 * either on an adjustment; there is no update path and no delete path.
 */
export interface AttemptEntry {
  readonly accountId: string;
  readonly delta: number;
  readonly reason: AttemptEntryReason;
  /** UNIQUE across the whole table. The only thing making retries safe. */
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

/**
 * What an append did.
 *
 * `duplicate` is a SUCCESS, not an error: it is what a correctly retried webhook
 * and a correctly retried delivery both look like, and the caller's response to
 * it is to report the balance and move on. Modelling it as a thrown unique
 * constraint violation pushes every caller into catching a database error and
 * pattern-matching its message.
 */
export type AppendResult =
  | { readonly outcome: 'appended'; readonly balance: number }
  | { readonly outcome: 'duplicate'; readonly balance: number };

/** Raised when a consume would take an account below zero. Never caught internally. */
export class InsufficientAttemptsError extends Error {
  readonly accountId: string;
  readonly balance: number;

  constructor(accountId: string, balance: number) {
    super(`account ${accountId} has ${balance} attempts; cannot consume`);
    this.name = 'InsufficientAttemptsError';
    this.accountId = accountId;
    this.balance = balance;
  }
}

/**
 * The ledger seam.
 *
 * Deliberately three methods. Anything richer (list, search, aggregate by tier)
 * belongs to reporting, which does not need to be on the write path's interface
 * and should not be able to reach it.
 */
export interface AttemptsStore {
  /**
   * Insert one entry. MUST be atomic with respect to the balance: fold the
   * ledger under a row lock, refuse a negative result with
   * `InsufficientAttemptsError`, and return `duplicate` — without inserting —
   * when `idempotencyKey` already exists.
   */
  append(entry: AttemptEntry): Promise<AppendResult>;
  /** Sum of `delta` for the account. A read; may be served from a cached column. */
  balance(accountId: string): Promise<number>;
}

/**
 * The unit of work that `brief §2.3`'s "same transaction" clause names.
 *
 * The consume, the verdict row, and the delivered flag are three writes that
 * must land together or not at all. Two of those three tables belong to the
 * schema agent, so this package cannot own the transaction — it can only require
 * one. `DeliveryTx` is what the web app hands us: a Drizzle transaction wearing
 * an interface narrow enough that the delivery logic cannot reach past it.
 *
 * Ordering inside the transaction is not arbitrary. `consumeOnDelivery` writes
 * the verdict FIRST and appends the ledger entry LAST, so an implementation that
 * silently loses its transaction (an autocommit connection, a driver that
 * ignores the callback's rejection) fails in the direction that gives the
 * customer a verdict they were not charged for, rather than the direction that
 * charges for a verdict that was never written.
 */
export interface DeliveryTx {
  writeVerdict(verdict: VerdictWrite): Promise<void>;
  markDelivered(input: { runId: string; verdictId: string; deliveredAt: Date }): Promise<void>;
  appendAttemptEntry(entry: AttemptEntry): Promise<AppendResult>;
}

/**
 * Runs `body` inside one database transaction, committing if it resolves and
 * rolling back if it rejects. The web app supplies this; nothing here creates a
 * connection.
 */
export type WithDeliveryTx = <T>(body: (tx: DeliveryTx) => Promise<T>) => Promise<T>;

/**
 * The verdict as the ledger needs to see it — an opaque, already-rendered
 * payload plus the keys that tie it to a listing and a run.
 *
 * `payload` is `unknown` rather than the engine's `Ranking` on purpose: this
 * module must not grow an opinion about verdict CONTENT. The moment it can read
 * a rank, someone can write `if (newRank < oldRank)` on the money path, and
 * `brief §2.4`'s "never keep-the-best" stops being structurally impossible and
 * becomes a rule that has to be remembered.
 */
export interface VerdictWrite {
  readonly verdictId: string;
  readonly listingId: string;
  readonly runId: string;
  readonly accountId: string;
  /** Which pitch this is, 1-based. `brief §2.4`: shown publicly as "3rd pitch". */
  readonly attemptNumber: number;
  readonly payload: unknown;
  readonly createdAt: Date;
}
