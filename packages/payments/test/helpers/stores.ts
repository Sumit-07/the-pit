/**
 * In-memory stores that enforce the guarantees the real schema must enforce.
 *
 * A fake that is more permissive than the database it stands for makes tests
 * that pass and production that does not. So:
 *
 * - `MemoryAttemptsStore` keeps a real unique index over `idempotencyKey` and
 *   refuses to let a balance go negative, which are exactly the two constraints
 *   `AttemptsStore`'s doc comment demands of a Postgres implementation.
 * - `MemoryDeliveryTx` is a REAL transaction: it snapshots, applies, and rolls
 *   back on rejection. A `withDeliveryTx` that merely ran the callback would let
 *   a test of "the consume is rolled back when the verdict write fails" pass
 *   against an implementation that does not roll back.
 *
 * Every store records what it was asked to do, in order, so a test can assert
 * "the ledger was not touched" rather than only "the balance came out right" —
 * a balance that is right by accident is the failure mode these rules exist to
 * catch.
 */

import type {
  AppendResult,
  AttemptEntry,
  AttemptsStore,
  DeliveryTx,
  VerdictWrite,
  WithDeliveryTx,
} from '../../src/attempts/types.js';
import { InsufficientAttemptsError } from '../../src/attempts/types.js';
import type { CreateJobResult, JobStore, SubmissionJob } from '../../src/submission/job.js';
import type { DodoEvent, ResolvedAccount, WebhookStore } from '../../src/index.js';

interface LedgerState {
  entries: AttemptEntry[];
  keys: Set<string>;
}

function clone(state: LedgerState): LedgerState {
  return { entries: [...state.entries], keys: new Set(state.keys) };
}

function fold(entries: readonly AttemptEntry[], accountId: string): number {
  return entries.reduce((sum, entry) => (entry.accountId === accountId ? sum + entry.delta : sum), 0);
}

export class MemoryAttemptsStore implements AttemptsStore {
  state: LedgerState = { entries: [], keys: new Set() };
  /** Every append that reached the store, duplicates included. */
  readonly appendCalls: AttemptEntry[] = [];

  append(entry: AttemptEntry): Promise<AppendResult> {
    return Promise.resolve(this.appendSync(entry));
  }

  appendSync(entry: AttemptEntry): AppendResult {
    this.appendCalls.push(entry);
    if (this.state.keys.has(entry.idempotencyKey)) {
      return { outcome: 'duplicate', balance: fold(this.state.entries, entry.accountId) };
    }
    const next = fold(this.state.entries, entry.accountId) + entry.delta;
    if (next < 0) {
      throw new InsufficientAttemptsError(entry.accountId, fold(this.state.entries, entry.accountId));
    }
    this.state.entries.push(entry);
    this.state.keys.add(entry.idempotencyKey);
    return { outcome: 'appended', balance: next };
  }

  balance(accountId: string): Promise<number> {
    return Promise.resolve(fold(this.state.entries, accountId));
  }

  /** Ledger rows only, so a test can say "nothing was written" precisely. */
  get entryCount(): number {
    return this.state.entries.length;
  }
}

export interface DeliveryRecord {
  verdicts: VerdictWrite[];
  delivered: { runId: string; verdictId: string; deliveredAt: Date }[];
}

/**
 * A transaction runner over a `MemoryAttemptsStore`.
 *
 * `failOn` makes a chosen step throw, so a test can drive the partial-write
 * cases the real transaction exists to prevent.
 */
export function memoryDeliveryTx(
  store: MemoryAttemptsStore,
  record: DeliveryRecord,
  failOn?: 'writeVerdict' | 'markDelivered' | 'appendAttemptEntry',
): WithDeliveryTx {
  return async <T>(body: (tx: DeliveryTx) => Promise<T>): Promise<T> => {
    const ledgerBefore = clone(store.state);
    const verdictsBefore = [...record.verdicts];
    const deliveredBefore = [...record.delivered];

    const tx: DeliveryTx = {
      writeVerdict(verdict): Promise<void> {
        if (failOn === 'writeVerdict') {
          return Promise.reject(new Error('writeVerdict failed'));
        }
        record.verdicts.push(verdict);
        return Promise.resolve();
      },
      markDelivered(input): Promise<void> {
        if (failOn === 'markDelivered') {
          return Promise.reject(new Error('markDelivered failed'));
        }
        record.delivered.push(input);
        return Promise.resolve();
      },
      appendAttemptEntry(entry): Promise<AppendResult> {
        if (failOn === 'appendAttemptEntry') {
          return Promise.reject(new Error('appendAttemptEntry failed'));
        }
        return store.append(entry);
      },
    };

    try {
      return await body(tx);
    } catch (error) {
      store.state = ledgerBefore;
      record.verdicts.length = 0;
      record.verdicts.push(...verdictsBefore);
      record.delivered.length = 0;
      record.delivered.push(...deliveredBefore);
      throw error;
    }
  };
}

export function emptyDeliveryRecord(): DeliveryRecord {
  return { verdicts: [], delivered: [] };
}

export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, SubmissionJob>();
  /** Every create that reached the store, duplicates included. */
  readonly createCalls: SubmissionJob[] = [];

  create(job: SubmissionJob): Promise<CreateJobResult> {
    this.createCalls.push(job);
    const existing = this.jobs.get(job.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({ outcome: 'duplicate', job: existing });
    }
    this.jobs.set(job.idempotencyKey, job);
    return Promise.resolve({ outcome: 'created', job });
  }
}

export class MemoryWebhookStore implements WebhookStore {
  readonly accounts = new Map<string, string>();
  readonly events = new Set<string>();
  readonly reviewQueue: { eventId: string; reason: string; event: DodoEvent }[] = [];
  #counter = 0;

  ensureAccount(input: { email: string; now: Date }): Promise<ResolvedAccount> {
    const existing = this.accounts.get(input.email);
    if (existing !== undefined) {
      return Promise.resolve({ accountId: existing, created: false });
    }
    this.#counter += 1;
    const accountId = `acct_${this.#counter}`;
    this.accounts.set(input.email, accountId);
    return Promise.resolve({ accountId, created: true });
  }

  recordEvent(input: { eventId: string; type: string; receivedAt: Date; outcome: string }): Promise<'recorded' | 'duplicate'> {
    if (this.events.has(input.eventId)) {
      return Promise.resolve('duplicate');
    }
    this.events.add(input.eventId);
    return Promise.resolve('recorded');
  }

  queueForReview(input: { eventId: string; reason: string; event: DodoEvent }): Promise<void> {
    this.reviewQueue.push(input);
    return Promise.resolve();
  }
}
