/**
 * `brief §2.3`'s sentence, as one transaction:
 *
 * > "An attempt is consumed **only on delivery** — decrement in the same
 * > transaction that writes the verdict and marks it delivered. Not on job start,
 * > not on pipeline completion."
 *
 * `@the-pit/payments` states that requirement and deliberately cannot satisfy it:
 * `DeliveryTx` is an interface there because two of the three tables belong to
 * this schema, and `AttemptsLedger.deliver` calls the three methods in a fixed
 * order without knowing what a connection is. This module is the implementation
 * — the only one outside a test helper — and every line below is a claim about a
 * constraint in `migrations/`.
 *
 * ## The advisory lock, and why the trigger is not enough
 *
 * `migrations/0001_ledger_guards.sql` says it in its own words:
 *
 * > HONEST LIMIT: under READ COMMITTED, two concurrent transactions can each see
 * > a balance of 1 and each insert a consume, and both commit. This trigger is
 * > defence in depth, not a serialization mechanism. The consuming path must take
 * > a per-account lock first.
 *
 * So the first statement in the transaction — before the verdict, before
 * anything — is `pg_advisory_xact_lock` on the account. It serializes deliveries
 * for ONE account and costs nothing for every other account in the system, and it
 * is released by the commit or the rollback rather than by any code here. Taking
 * it after the verdict write would leave exactly the window it exists to close:
 * two deliveries for one account, each folding a balance of 1, each deciding it
 * may spend.
 *
 * `attempts_no_overdraft` still fires, and still catches the case where somebody
 * forgot the lock. That is the arrangement the migration asks for and not a
 * duplication of it.
 *
 * ## Every write is idempotent, because a delivery is retried
 *
 * An Inngest step is replayed after a connection drop; a worker comes back and
 * finishes the job twice. `consumeIdempotencyKey` is `delivery:run:<runId>`
 * precisely so the ledger answers `duplicate` on the second pass, and the other
 * two writes have to survive the same replay or the transaction dies before it
 * reaches the ledger:
 *
 * - `writeVerdict` is `ON CONFLICT DO NOTHING` with NO target. Four constraints
 *   can legitimately swallow it — the primary key, `verdicts_public_slug_uk`,
 *   `verdicts_one_per_job_uk` and `verdicts_product_attempt_uk` — and every one
 *   of them means "this exact verdict is already issued". Naming one would leave
 *   the other three throwing.
 * - `markDelivered` carries `AND delivered_at IS NULL`. `jobs_delivery_immutable`
 *   refuses every UPDATE of a delivered job, so a second pass MUST match no rows
 *   rather than write the same value again; a `BEFORE ... FOR EACH ROW` trigger
 *   does not fire on a row the WHERE clause excluded.
 *
 * ## The order inside the transaction is the payments package's, not this one's
 *
 * `AttemptsLedger.deliver` writes the verdict, then the delivered flag, then the
 * ledger — "so an implementation that silently loses its transaction fails in the
 * direction that gives the customer a verdict they were not charged for". Both
 * constraint triggers that would object to that sequence
 * (`verdicts_require_delivered_job_trg`, `attempts_consume_requires_delivery_trg`)
 * are DEFERRABLE INITIALLY DEFERRED and judged at COMMIT, by which time all three
 * rows exist. Nothing here reorders them.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { attemptRow, verdictRow, type DeliveredVerdict, type LedgerEntry } from './identity.js';
import { attempts, categories, jobs, products, verdicts } from './schema/index.js';

/** Mirrors `AppendResult` in `@the-pit/payments`. See `payments-store.ts`. */
export type DeliveryAppendOutcome =
  | { readonly outcome: 'appended'; readonly balance: number }
  | { readonly outcome: 'duplicate'; readonly balance: number };

/**
 * Mirrors `DeliveryTx` in `@the-pit/payments`.
 *
 * Re-declared rather than imported for the reason `identity.ts` gives: `apps/web`
 * depends on this package, and this package must not put the payments package
 * into its published type surface. `test/identity.test.ts` asserts assignability
 * in both directions, so a method added over there fails this package's
 * typecheck.
 */
export interface PostgresDeliveryTx {
  writeVerdict(verdict: DeliveredVerdict): Promise<void>;
  markDelivered(input: { runId: string; verdictId: string; deliveredAt: Date }): Promise<void>;
  appendAttemptEntry(entry: LedgerEntry): Promise<DeliveryAppendOutcome>;
}

/** Mirrors `WithDeliveryTx` in `@the-pit/payments`. */
export type WithPostgresDeliveryTx = <T>(body: (tx: PostgresDeliveryTx) => Promise<T>) => Promise<T>;

/** The two facts a `VerdictWrite` cannot carry, plus the account the lock is taken on. */
export interface DeliveryTxOptions {
  /**
   * `accounts.id`. The lock is per account because the balance is per account —
   * `attempt_balance(uuid)` folds exactly these rows — and because two customers
   * delivering at once have nothing to serialize.
   */
  readonly accountId: string;
  /** The public URL for this verdict. `verdictSlug(verdictId)` derives a stable one. */
  readonly publicSlug: string;
  /** `brief` Part 5: stamped on the card beside the timestamp. */
  readonly productCount: number;
}

/** One listing, resolved from the identity a delivered run actually holds. */
export interface DeliveredListing {
  /** `products.id` — `listingId` in `@the-pit/payments`. */
  readonly productId: string;
  /** `products.source`. `'paid'` is what makes the §2.4 rules reachable. */
  readonly source: string;
  /** Null on a seeded row; the payer's address on a paid one. */
  readonly submittedByEmail: string | null;
}

export interface PostgresDeliveryStore {
  /**
   * The `products` row a delivered run placed, by the only identity the run has.
   *
   * A run knows a category slug and the engine's 0-based `Product.id`; it does
   * not know a uuid, because `writeProducts` inserts with
   * `ON CONFLICT DO NOTHING` and the winning row may have been written by an
   * earlier seed under a different id. Reading it back is what stops the verdict
   * naming a product that does not exist — which the foreign key would refuse
   * anyway, three statements into a transaction that has already published a
   * board.
   */
  findListing(input: { categorySlug: string; engineId: number }): Promise<DeliveredListing | null>;
  /** The delivery transaction `AttemptsLedger.deliver` runs inside. */
  withDeliveryTx(options: DeliveryTxOptions): WithPostgresDeliveryTx;
  /** Sum of `delta` for one account, outside any transaction. */
  balance(accountId: string): Promise<number>;
}

/**
 * Anything that can run the balance fold — the connection or a transaction on it.
 *
 * Structural rather than `Database`, because the fold has to run INSIDE the
 * delivery transaction: a balance read on the pool while the transaction holds
 * the lock would report the value the rest of the world can see rather than the
 * one this delivery just wrote.
 */
type BalanceReader = { select: Database['select'] };

async function balanceOf(reader: BalanceReader, accountId: string): Promise<number> {
  const rows = await reader
    .select({ balance: sql<number>`coalesce(sum(${attempts.delta}), 0)::int` })
    .from(attempts)
    .where(eq(attempts.accountId, accountId));
  return Number(rows[0]?.balance ?? 0);
}

export function createPostgresDeliveryStore(db: Database): PostgresDeliveryStore {
  return {
    async findListing(input: { categorySlug: string; engineId: number }): Promise<DeliveredListing | null> {
      const rows = await db
        .select({
          productId: products.id,
          source: products.source,
          submittedByEmail: products.submittedByEmail,
        })
        .from(products)
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .where(and(eq(categories.slug, input.categorySlug), eq(products.engineId, input.engineId)))
        .limit(1);

      const row = rows[0];
      return row === undefined ? null : { ...row, source: String(row.source) };
    },

    withDeliveryTx(options: DeliveryTxOptions): WithPostgresDeliveryTx {
      return async <T>(body: (tx: PostgresDeliveryTx) => Promise<T>): Promise<T> => {
        return db.transaction(async (tx) => {
          // FIRST. See the module header — the overdraft trigger is defence in
          // depth and this is the serialization.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`attempt:${options.accountId}`}))`,
          );

          const handle: PostgresDeliveryTx = {
            async writeVerdict(verdict: DeliveredVerdict): Promise<void> {
              await tx
                .insert(verdicts)
                .values(
                  verdictRow(verdict, {
                    publicSlug: options.publicSlug,
                    productCount: options.productCount,
                  }),
                )
                .onConflictDoNothing();
            },

            async markDelivered(input: {
              runId: string;
              verdictId: string;
              deliveredAt: Date;
            }): Promise<void> {
              await tx
                .update(jobs)
                .set({
                  // `jobs_delivered_only_when_succeeded`: the timestamp and the
                  // status are one fact and are written together.
                  status: 'succeeded',
                  deliveredAt: input.deliveredAt,
                  finishedAt: input.deliveredAt,
                })
                .where(and(eq(jobs.id, input.runId), isNull(jobs.deliveredAt)));
            },

            async appendAttemptEntry(entry: LedgerEntry): Promise<DeliveryAppendOutcome> {
              const written = await tx
                .insert(attempts)
                .values(attemptRow(entry))
                .onConflictDoNothing()
                .returning({ id: attempts.id });

              return {
                outcome: written.length === 0 ? 'duplicate' : 'appended',
                balance: await balanceOf(tx, entry.accountId),
              };
            },
          };

          return body(handle);
        });
      };
    },

    balance(accountId: string): Promise<number> {
      return balanceOf(db, accountId);
    },
  };
}

/**
 * The verdict at one public URL — the whole of what `/v/<slug>` reads.
 *
 * One row, one column, no join. `brief §2.1` splits the surfaces: "verdict URLs
 * are public; attempt balance and history sit behind a session", and this query
 * is what the public half is allowed to do. It does not select `account_id` or
 * `job_id`, so a payload that reaches the page cannot carry the payer's identity
 * into a shared screenshot even by accident.
 */
export interface StoredVerdictRow {
  readonly publicSlug: string;
  readonly payload: unknown;
  readonly productCount: number;
  readonly attemptNumber: number | null;
  readonly deliveredAt: Date;
}

export interface PostgresVerdictStore {
  bySlug(slug: string): Promise<StoredVerdictRow | null>;
}

export function createPostgresVerdictStore(db: Database): PostgresVerdictStore {
  return {
    async bySlug(slug: string): Promise<StoredVerdictRow | null> {
      // `verdicts_public_slug_shape` constrains what a slug can be, so a value
      // that cannot satisfy it cannot name a row. Refusing it here keeps a
      // hand-typed URL from becoming a query at all — the page is public, and
      // "public" means "resolvable by whoever holds the link", not "a search".
      if (slug === '' || slug.length > 128) return null;

      const rows = await db
        .select({
          publicSlug: verdicts.publicSlug,
          payload: verdicts.payload,
          productCount: verdicts.productCount,
          attemptNumber: verdicts.attemptNumber,
          deliveredAt: verdicts.deliveredAt,
        })
        .from(verdicts)
        .where(eq(verdicts.publicSlug, slug))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return null;
      return {
        publicSlug: row.publicSlug,
        payload: row.payload,
        productCount: Number(row.productCount),
        attemptNumber: row.attemptNumber === null ? null : Number(row.attemptNumber),
        deliveredAt:
          row.deliveredAt instanceof Date ? row.deliveredAt : new Date(String(row.deliveredAt)),
      };
    },
  };
}

/**
 * The newest delivered verdicts, across every category. `brief` Part 6's
 * "arriving verdicts", read back.
 *
 * ## A separate factory, and why it is not a method on `PostgresVerdictStore`
 *
 * That store is one method on purpose. Its header states the reason: the public
 * verdict route has no session, and a store reachable from it that could
 * enumerate an account's verdicts would cross the line `brief §2.1` draws —
 * "verdict URLs are public; attempt balance and history sit behind a session".
 * Adding a `list` there would weaken a documented guarantee for a feature that
 * does not need it.
 *
 * This read is a different shape and gets a different name. It takes no account
 * and selects no `account_id` or `job_id`, so it cannot be pointed at a person
 * even by a caller that wanted to: it answers "what came out of the pit most
 * recently", and every row it returns is a page anybody already holds a URL to.
 *
 * ## Ordered by `delivered_at`, and by nothing else
 *
 * `DECISIONS.md` S14: a cross-category feed must not become a cross-category
 * leaderboard, because `01 §9` rule 2 forbids one — scores are z-normalised
 * inside a category, so ordering two categories' rows against each other invents
 * a comparison the engine never made. Time is the one ordering that ranks
 * nothing, so it is the only ordering this query offers. There is no `orderBy`
 * parameter, and adding one would be re-opening a resolved decision in the layer
 * furthest from the surface that shows it.
 *
 * `attempt_number` is in the projection because the page needs to tell a PITCH
 * from a seeded listing: a cold-start row carries NULL there (`brief §2.4` counts
 * pitches, and nobody has pitched an unclaimed row), and its `delivered_at` is a
 * stamp of convenience rather than a moment anything happened. A "NEW" chip
 * driven by the timestamp alone would fire for all of them.
 */
export interface PostgresRecentVerdicts {
  /** The newest `limit` verdicts by `delivered_at`, newest first. */
  recent(limit: number): Promise<StoredVerdictRow[]>;
}

export function createPostgresRecentVerdicts(db: Database): PostgresRecentVerdicts {
  return {
    async recent(limit: number): Promise<StoredVerdictRow[]> {
      // A feed is a handful of cards. Clamping here rather than trusting the
      // caller keeps a mistyped argument from selecting every payload in the
      // table — each one is a whole rendered verdict document.
      const take = Math.max(0, Math.min(50, Math.trunc(limit)));
      if (take === 0) return [];

      const rows = await db
        .select({
          publicSlug: verdicts.publicSlug,
          payload: verdicts.payload,
          productCount: verdicts.productCount,
          attemptNumber: verdicts.attemptNumber,
          deliveredAt: verdicts.deliveredAt,
        })
        .from(verdicts)
        .orderBy(desc(verdicts.deliveredAt))
        .limit(take);

      return rows.map((row) => ({
        publicSlug: row.publicSlug,
        payload: row.payload,
        productCount: Number(row.productCount),
        attemptNumber: row.attemptNumber === null ? null : Number(row.attemptNumber),
        deliveredAt: row.deliveredAt instanceof Date ? row.deliveredAt : new Date(String(row.deliveredAt)),
      }));
    },
  };
}
