/**
 * An in-memory settling side that enforces what the schema enforces. Not a test
 * file.
 *
 * A fake that is more permissive than the database it stands for makes tests that
 * pass and production that does not, so every guarantee the money path leans on
 * is implemented here rather than assumed:
 *
 * - `idempotencyKey` is a real unique index (`attempts_idempotency_key_uk`);
 * - a balance may not go negative (`attempts_no_overdraft`);
 * - a consume requires a job that has been marked delivered
 *   (`attempts_consume_requires_delivery`);
 * - a verdict naming a job requires the same (`verdicts_require_delivered_job`);
 * - and `withDeliveryTx` is a REAL transaction — it snapshots, applies and rolls
 *   back on rejection. A runner that merely called the callback would let "a
 *   delivery that fails partway consumes nothing" pass against an implementation
 *   that consumes anyway.
 *
 * The PGlite suite (`test/delivery-pg.test.ts`) runs the same scenarios against
 * the real DDL. This one exists because it can drive the failure injections a
 * real database cannot be asked for on demand.
 */

import { AttemptsLedger, InsufficientAttemptsError } from '@the-pit/payments';
import type {
  AppendResult,
  AttemptEntry,
  AttemptsStore,
  DeliveryTx,
  VerdictWrite,
  WithDeliveryTx,
} from '@the-pit/payments';

import type { DeliveryBindings } from '@/lib/delivery/settle';
import type { BoardInvalidator } from '@/lib/delivery/revalidate';

/** One `verdicts` row, as this fake stores it. */
export interface FakeVerdictRow {
  readonly publicSlug: string;
  readonly productCount: number;
  readonly verdict: VerdictWrite;
}

/** Which step of the transaction to make throw, for the partial-write cases. */
export type FailAt = 'writeVerdict' | 'markDelivered' | 'appendAttemptEntry';

interface State {
  entries: AttemptEntry[];
  keys: Set<string>;
  verdicts: FakeVerdictRow[];
  /** `jobs.delivered_at`, by run id. */
  delivered: Map<string, Date>;
}

function snapshot(state: State): State {
  return {
    entries: [...state.entries],
    keys: new Set(state.keys),
    verdicts: [...state.verdicts],
    delivered: new Map(state.delivered),
  };
}

function fold(entries: readonly AttemptEntry[], accountId: string): number {
  return entries.reduce((sum, entry) => (entry.accountId === accountId ? sum + entry.delta : sum), 0);
}

/**
 * The whole settling side, in memory.
 *
 * `listings` is seeded by the test, because resolving `products.id` from a slug
 * and an engine id is a READ the delivery path makes and not something it may
 * invent — a settle that could conjure a listing would hide the case this fake is
 * most useful for, which is the catalogue write not having landed.
 */
export class FakeDelivery {
  state: State = { entries: [], keys: new Set(), verdicts: [], delivered: new Map() };
  /** Every append that reached the ledger, duplicates and refusals included. */
  readonly appendCalls: AttemptEntry[] = [];
  /** `(slug, engineId)` -> the `products` row. */
  readonly listings = new Map<string, { productId: string; source: string; submittedByEmail: string | null }>();

  #failAt: FailAt | undefined;

  constructor(options: { failAt?: FailAt } = {}) {
    this.#failAt = options.failAt;
  }

  /** Grant attempts the way a signed webhook would, so a delivery has one to spend. */
  grant(accountId: string, attempts: number, key = `dodo:event:${accountId}:${attempts}`): void {
    this.state.entries.push({
      accountId,
      delta: attempts,
      reason: {
        kind: 'grant',
        providerEventId: key,
        providerPaymentId: `pay_${key}`,
        // One tier is on sale, so a multi-attempt balance is several $5 grants
        // rather than one larger one. The helper folds them into a single ledger
        // row because these tests are about spending attempts, not buying them.
        tier: 'single',
        amountCents: attempts * 500,
      },
      idempotencyKey: key,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    this.state.keys.add(key);
  }

  addListing(slug: string, engineId: number, row: { productId: string; source?: string; email?: string }): void {
    this.listings.set(`${slug}:${engineId}`, {
      productId: row.productId,
      source: row.source ?? 'paid',
      submittedByEmail: row.email ?? 'payer@example.com',
    });
  }

  balance(accountId: string): number {
    return fold(this.state.entries, accountId);
  }

  /** Ledger rows only, so a test can say "nothing was written" precisely. */
  get entryCount(): number {
    return this.state.entries.length;
  }

  get consumes(): AttemptEntry[] {
    return this.state.entries.filter((entry) => entry.reason.kind === 'consume');
  }

  bindings(): DeliveryBindings {
    const self = this;
    return {
      findListing({ categorySlug, engineId }): Promise<{
        productId: string;
        source: string;
        submittedByEmail: string | null;
      } | null> {
        return Promise.resolve(self.listings.get(`${categorySlug}:${engineId}`) ?? null);
      },
      ledgerFor({ accountId, publicSlug, productCount }): AttemptsLedger {
        void accountId;
        return new AttemptsLedger(self.#store(), self.#withTx(publicSlug, productCount));
      },
    };
  }

  #store(): AttemptsStore {
    const self = this;
    return {
      append(): Promise<AppendResult> {
        return Promise.reject(
          new Error('the delivery path may consume an attempt and may never grant one (brief §2.2)'),
        );
      },
      balance(accountId: string): Promise<number> {
        return Promise.resolve(self.balance(accountId));
      },
    };
  }

  #withTx(publicSlug: string, productCount: number): WithDeliveryTx {
    const self = this;
    return async <T>(body: (tx: DeliveryTx) => Promise<T>): Promise<T> => {
      const before = snapshot(self.state);

      const tx: DeliveryTx = {
        writeVerdict(verdict: VerdictWrite): Promise<void> {
          if (self.#failAt === 'writeVerdict') return Promise.reject(new Error('writeVerdict failed'));
          // Append-only, and idempotent on a replay: the same run derives the
          // same verdict id, and every unique that could swallow the insert means
          // "already issued".
          if (!self.state.verdicts.some((row) => row.publicSlug === publicSlug)) {
            self.state.verdicts.push({ publicSlug, productCount, verdict });
          }
          return Promise.resolve();
        },
        markDelivered(input: { runId: string; verdictId: string; deliveredAt: Date }): Promise<void> {
          if (self.#failAt === 'markDelivered') return Promise.reject(new Error('markDelivered failed'));
          // `jobs_delivery_immutable` refuses every UPDATE of a delivered job, so
          // the second pass must be a no-op rather than a rewrite.
          if (!self.state.delivered.has(input.runId)) {
            self.state.delivered.set(input.runId, input.deliveredAt);
          }
          return Promise.resolve();
        },
        appendAttemptEntry(entry: AttemptEntry): Promise<AppendResult> {
          if (self.#failAt === 'appendAttemptEntry') {
            return Promise.reject(new Error('appendAttemptEntry failed'));
          }
          self.appendCalls.push(entry);

          if (self.state.keys.has(entry.idempotencyKey)) {
            return Promise.resolve({ outcome: 'duplicate', balance: fold(self.state.entries, entry.accountId) });
          }
          // `attempts_consume_requires_delivery`, in the fake.
          if (entry.reason.kind === 'consume' && !self.state.delivered.has(entry.reason.runId)) {
            return Promise.reject(
              new Error(
                `attempt consumes job ${entry.reason.runId}, which has not been delivered (brief §2.3)`,
              ),
            );
          }
          const next = fold(self.state.entries, entry.accountId) + entry.delta;
          if (next < 0) {
            return Promise.reject(
              new InsufficientAttemptsError(entry.accountId, fold(self.state.entries, entry.accountId)),
            );
          }
          self.state.entries.push(entry);
          self.state.keys.add(entry.idempotencyKey);
          return Promise.resolve({ outcome: 'appended', balance: next });
        },
      };

      try {
        const result = await body(tx);
        // `verdicts_require_delivered_job`, checked at COMMIT exactly as the
        // constraint trigger is: `AttemptsLedger.deliver` writes the verdict
        // BEFORE the delivered flag on purpose, and an immediate check would
        // reject an ordering the payments package chose deliberately.
        for (const row of self.state.verdicts) {
          if (!self.state.delivered.has(row.verdict.runId)) {
            throw new Error(
              `verdict ${row.publicSlug} names job ${row.verdict.runId}, which has not been delivered`,
            );
          }
        }
        return result;
      } catch (error) {
        self.state.entries = before.entries;
        self.state.keys = before.keys;
        self.state.verdicts = before.verdicts;
        self.state.delivered = before.delivered;
        throw error;
      }
    };
  }
}

/** A `BoardInvalidator` that records the slugs it was asked to drop. */
export class RecordingInvalidator implements BoardInvalidator {
  readonly slugs: string[] = [];

  invalidateBoard(slug: string): Promise<void> {
    this.slugs.push(slug);
    return Promise.resolve();
  }
}
