/**
 * `jobs` — one evaluation, from enqueue to delivery.
 *
 * `02 §9` sketched it as `(id, kind, category_id, product_id, status, cost_cents,
 * result_json, created_at, finished_at)` and called it "the audit + cost ledger".
 * Three things the brief added since:
 *
 * 1. **`delivered_at` is the money event.** `brief §2.3`: an attempt is consumed
 *    "only on delivery — decrement in the same transaction that writes the
 *    verdict and marks it delivered. Not on job start, not on pipeline
 *    completion." The trigger in `migrations/0001_ledger_guards.sql` refuses a
 *    `consume` row whose job has a null `delivered_at`, so the ordering inside
 *    that transaction is enforced rather than remembered.
 * 2. **The version stamps.** `PhaseVersions` in the engine refuses to resume a
 *    phase across a version bump, because the stored answer was produced under a
 *    rubric, a panel or a population that no longer exists. A resumable status
 *    page (`brief` Part 6) needs those versions on the job, not on the category,
 *    which has since moved on.
 * 3. **`retry_count`.** `brief §2.3`: failures are free retries, capped at 3 per
 *    attempt, "otherwise a user can burn compute by killing the connection
 *    repeatedly."
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { categories } from './categories.js';
import { jobKind, jobStatus } from './enums.js';
import { products } from './products.js';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    kind: jobKind('kind').notNull(),
    status: jobStatus('status').notNull(),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** Null for a `preview` job, which persists no product (`DECISIONS.md` S13). */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** Null on `preview` (no login, `brief §2.6`) and on admin `full_run`s. */
    accountEmail: text('account_email'),

    /**
     * `brief §2.2`: "Idempotency key on job creation so a double-clicked submit
     * doesn't buy twice." Unique, so the second click loses the insert rather
     * than the race.
     */
    idempotencyKey: text('idempotency_key'),

    /**
     * The versions this job's phases were produced under. Non-null on every job:
     * a job that cannot say which rubric, panel and population it ran against
     * cannot be resumed safely and cannot be audited at all.
     *
     * `category_snapshot_version` is `brief §1.3`'s name for what the engine
     * stamps as `RunMeta.category_version`.
     */
    promptVersion: text('prompt_version').notNull(),
    personaVersion: text('persona_version').notNull(),
    categorySnapshotVersion: text('category_snapshot_version').notNull(),
    /** `ENGINE_VERSION` — the build that rendered the prompts. */
    engineVersion: text('engine_version').notNull(),

    /**
     * `PersistedPhase` envelopes, keyed by phase name. `src/run/store.ts` in the
     * engine: "Persist each phase result as it lands; never batch-commit at the
     * end", because `brief §2.3`'s free retry is only free if the phases that
     * already succeeded are on disk before the next one runs.
     */
    phases: jsonb('phases').notNull().default(sql`'{}'::jsonb`),

    /** The delivered verdict payload, or a preview band. Null until it exists. */
    result: jsonb('result'),

    /** `PhaseFailure.code` from the engine, flattened for querying. */
    failureCode: text('failure_code'),
    /**
     * `brief §2.3`'s classification, carried beside the code so the retry policy
     * never has to re-derive it from prose. Null while the job has not failed.
     */
    retryable: boolean('retryable'),

    /** Free retries so far. `brief §2.3` caps them at 3, then routes to support. */
    retryCount: integer('retry_count').notNull().default(0),

    /** `CostLedger.total.cost_usd` in whole cents, for the per-submission ceiling (`02 §8`). */
    costCents: integer('cost_cents').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    /**
     * The instant the verdict was handed over. THE precondition for consuming an
     * attempt (`brief §2.3`), enforced by `attempts_consume_requires_delivery`.
     */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    unique('jobs_idempotency_key_uk').on(t.idempotencyKey),

    // The status page and the worker both poll "what is outstanding here".
    index('jobs_category_status_idx').on(t.categoryId, t.status, t.createdAt),
    index('jobs_account_email_idx').on(t.accountEmail, t.createdAt),
    index('jobs_product_idx').on(t.productId),

    check('jobs_retry_count_cap', sql`${t.retryCount} between 0 and 3`),
    check('jobs_cost_non_negative', sql`${t.costCents} >= 0`),
    check('jobs_email_lowercase', sql`${t.accountEmail} is null or ${t.accountEmail} = lower(${t.accountEmail})`),

    // A delivered job is a succeeded job. Nothing else may carry a delivery time,
    // because that timestamp is what unlocks the attempt decrement.
    check('jobs_delivered_only_when_succeeded', sql`${t.deliveredAt} is null or ${t.status} = 'succeeded'`),

    // `brief §2.6` and `DECISIONS.md` S13: the free preview persists no product.
    // A `preview` job holding a product id would mean the dead preview→place
    // funnel had been rebuilt.
    check('jobs_preview_has_no_product', sql`${t.kind} <> 'preview' or ${t.productId} is null`),

    // A placement is a paid submission: it has a product to place and a payer to
    // bill (`brief §2.1`).
    check(
      'jobs_placement_has_product_and_account',
      sql`${t.kind} <> 'placement' or (${t.productId} is not null and ${t.accountEmail} is not null)`,
    ),
  ],
);
