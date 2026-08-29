/**
 * `score_rows`, `clusters`, `cluster_members`, `demand_votes` — the raw panel
 * output, and the source of truth for every number on every board.
 *
 * ## Why these are the source of truth and `rankings` is not
 *
 * `02 §7`: "This is why Postgres stores **raw `scoreLog` rows, cluster
 * assignments, and demand votes** rather than only the reduced ranking:
 * incremental placement and exact recomputation both require the raw inputs."
 * And `brief` Part 7 calls the score log "the integrity record if anyone disputes
 * a ranking."
 *
 * `PHASE-0.md §1` makes the same point from the other side: "No model call ever
 * produces or sees a rank … All ranking arithmetic is pure code, run afterwards
 * over the stored raw rows — which is why a ranking can be recomputed offline,
 * for free." Every derived number — z-scores, the merit composite, `demand_raw`,
 * `core`, the rank itself — is reproducible from these four tables plus the
 * jury's weight vector, and from nothing else. `snapshots` and `rankings` are
 * caches of that computation.
 *
 * The shape of each table is therefore fixed by what the engine needs to read
 * back, not by what a board needs to display:
 *
 * - `score_rows` must reconstruct `ScoreLogEntry[]` — attributed per juror,
 *   because `01 §6.1` z-normalizes **per juror, per metric, across products** and
 *   an unattributed score is useless to that.
 * - `demand_votes` must reconstruct `DemandLogEntry[]` including the `none`
 *   answers, because `capture` in `01 §6.2` counts personas that engaged with a
 *   cluster and a persona who declined is not a persona who was never asked.
 * - `cluster_members` must carry the scarcity score, because `DECISIONS.md` S2
 *   keeps the `UNIQ_LAMBDA` tilt and puts it on the verdict page.
 *
 * ## The denormalized `category_id`
 *
 * All three child tables carry `category_id` beside `product_id`, so a whole
 * category's raw log is one indexed read rather than a join through `products`.
 * The copy cannot drift: the foreign key is composite, against
 * `products(id, category_id)`, so a row whose `category_id` disagrees with its
 * product's is rejected by Postgres rather than by a convention.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { categories } from './categories.js';
import { demandPick } from './enums.js';
import { jobs } from './jobs.js';
import { products } from './products.js';

/**
 * One juror's 0-100 score for one product on one metric, with the deductions
 * that produced it. `02 §9`: `(product_id, juror_role, metric, score,
 * deductions_json, prompt_version)`.
 *
 * One row per (product, juror, metric, prompt_version). Six jurors x five metrics
 * x 48 products is 1440 rows for a seeded category, which is what the Developer
 * Tools board actually contains.
 */
export const scoreRows = pgTable(
  'score_rows',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    productId: uuid('product_id').notNull(),
    categoryId: uuid('category_id').notNull(),

    /** Matches `JurorMandate.role` on the jury named by `prompt_version`. */
    jurorRole: text('juror_role').notNull(),

    /** Matches a `RubricMetric.name` on the same jury. */
    metric: text('metric').notNull(),

    /** The raw 0-100 score, before any z-normalization. `01 §5.1`. */
    score: integer('score').notNull(),

    /**
     * `Deduction[]` — `{points, reason}`, each reason <= 20 words (`01 §5.1`).
     *
     * `01 §5.1` also requires the points to sum to exactly `100 - score`. That
     * invariant is NOT a check constraint: expressing it needs
     * `jsonb_array_elements`, a set-returning function, which Postgres does not
     * allow in a CHECK. It is enforced by `validateScoreResult` in the engine,
     * which every write path goes through, and re-asserted over the seeded rows
     * by `test/seed/from-ranking.test.ts`.
     */
    deductions: jsonb('deductions').notNull().default(sql`'[]'::jsonb`),

    /**
     * The jury this score was produced under. Part of the uniqueness key, not
     * merely recorded: `brief` Part 3 pre-announces a panel change and keeps the
     * old boards addressable, so a re-score under a new jury must be able to sit
     * beside the old one rather than overwrite the evidence.
     */
    promptVersion: text('prompt_version').notNull(),

    /** The run that produced this row. Null for rows imported from a seed file. */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null', onUpdate: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'score_rows_product_fk',
      columns: [t.productId, t.categoryId],
      foreignColumns: [products.id, products.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    // A juror scores each metric of each product exactly once per jury version.
    // A second row would be a duplicate vote silently doubling that juror's
    // weight in the z-norm.
    unique('score_rows_cell_uk').on(t.productId, t.jurorRole, t.metric, t.promptVersion),

    // The recompute read: every raw score in one category at one jury version.
    index('score_rows_category_idx').on(t.categoryId, t.promptVersion),
    index('score_rows_product_idx').on(t.productId),

    // `01 §5.1`: metrics start at 100 and points come off. `01 §6`'s
    // `_clamp(x, 0, 100, default=50)` guards the arithmetic against a malformed
    // response; it is not a licence to STORE one.
    check('score_rows_score_range', sql`${t.score} between 0 and 100`),

    check('score_rows_deductions_is_array', sql`jsonb_typeof(${t.deductions}) = 'array'`),
  ],
);

/**
 * One cluster of products whose core idea is essentially the same (`01 §5.2`).
 *
 * `brief §1.5`, and this is the constraint that shapes the table: "Demand votes
 * are keyed to `cluster_id`. Re-clustering invalidates every stored vote.
 * Clusters are **append-only**: a new product joins an existing cluster or opens
 * a new one. Full re-clustering is an explicit admin operation that clears demand
 * for that category."
 *
 * So a cluster is never rewritten and never deleted. An admin re-cluster inserts
 * a new generation under a new `uniqueness_version` and stamps `retired_at` on
 * the old one; the votes attached to the retired clusters stay on disk as the
 * record of a board that really was published, and simply stop being read.
 *
 * `02 §9` named the model-supplied identifier `cluster_id` on a table whose
 * primary key is also called `id`. Here it is `cluster_key`, because two columns
 * a reader would both call "the cluster id" is how a join gets written against
 * the wrong one.
 */
export const clusters = pgTable(
  'clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** `Cluster.cluster_id` as the uniqueness pass emitted it, e.g. `c5-mobile-ota`. */
    clusterKey: text('cluster_key').notNull(),

    /** `Cluster.label`, truncated to `LABEL_LIMIT` (60 chars, `01 §8`) before storage. */
    label: text('label').notNull(),

    /** The clustering generation this cluster belongs to. */
    uniquenessVersion: text('uniqueness_version').notNull(),

    /** Set by an admin full re-cluster. Retired clusters are kept, never deleted. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('clusters_category_key_uk').on(t.categoryId, t.clusterKey, t.uniquenessVersion),

    /** Target for the composite FKs on `cluster_members`, `demand_votes` and `mob_votes`. */
    unique('clusters_id_category_uk').on(t.id, t.categoryId),

    index('clusters_category_idx').on(t.categoryId, t.uniquenessVersion),

    check('clusters_label_limit', sql`char_length(${t.label}) between 1 and 60`),
    check('clusters_key_limit', sql`char_length(${t.clusterKey}) between 1 and 60`),
  ],
);

/**
 * A product's membership of a cluster, plus its scarcity verdict.
 *
 * The scarcity score lives here rather than on `products` because it is a
 * property of a clustering pass, not of the product: `UniquenessProduct` carries
 * `{id, uniqueness_score, cluster_id, reason}` in one object, and re-clustering
 * produces a new answer for all three. `DECISIONS.md` S2 keeps the
 * `UNIQ_LAMBDA = 0.075` tilt this feeds and requires the verdict page to show the
 * score and its reason, so both have to survive to read time.
 */
export const clusterMembers = pgTable(
  'cluster_members',
  {
    clusterId: uuid('cluster_id').notNull(),
    productId: uuid('product_id').notNull(),
    categoryId: uuid('category_id').notNull(),

    /** `UniquenessProduct.uniqueness_score`: 0-100 scarcity, NOT quality (`01 §5.2`). */
    uniquenessScore: integer('uniqueness_score').notNull(),

    /** Why the pass judged it that rare. Shown on the verdict page (`DECISIONS.md` S2). */
    reason: text('reason').notNull(),

    uniquenessVersion: text('uniqueness_version').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'cluster_members_pk', columns: [t.clusterId, t.productId] }),

    foreignKey({
      name: 'cluster_members_cluster_fk',
      columns: [t.clusterId, t.categoryId],
      foreignColumns: [clusters.id, clusters.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    foreignKey({
      name: 'cluster_members_product_fk',
      columns: [t.productId, t.categoryId],
      foreignColumns: [products.id, products.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    /**
     * A product sits in exactly ONE cluster per clustering generation. `01 §5.2`
     * partitions the category; a product in two clusters would be put to two
     * forced choices and counted twice in `breadth`.
     */
    unique('cluster_members_one_cluster_per_pass_uk').on(t.productId, t.uniquenessVersion),

    index('cluster_members_category_idx').on(t.categoryId, t.uniquenessVersion),

    check('cluster_members_uniqueness_range', sql`${t.uniquenessScore} between 0 and 100`),
  ],
);

/**
 * One synthetic buyer's forced choice inside one cluster — the Floor's raw
 * output. `02 §9`: `(product_id, persona_name, cluster_id, pick, strength,
 * reason, flagged)`.
 *
 * A `DemandChoice` becomes one, two or three rows: a `first` and optionally a
 * `second` sharing the choice's reason, or a single `none` row. That is what lets
 * `DemandLogEntry[]` be rebuilt exactly, which is what `02 §7`'s "exact
 * recomputation" means.
 */
export const demandVotes = pgTable(
  'demand_votes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    categoryId: uuid('category_id').notNull(),
    clusterId: uuid('cluster_id').notNull(),

    /** Null exactly when `pick = 'none'`: nobody in the set was worth adopting. */
    productId: uuid('product_id'),

    /** Matches `Persona.name` on the panel named by `persona_version`. */
    personaName: text('persona_name').notNull(),

    pick: demandPick('pick').notNull(),

    /**
     * The persona's conviction, 0-100. `01 §5.3` attaches it to the first pick
     * only; `DemandPick` documents it as "absent on a runner-up entry", and
     * `01 §6.2` averages a product's top-2 strengths into `intensity`.
     */
    strength: integer('strength'),

    reason: text('reason').notNull(),

    /** `01 §8`'s output alarm matched this reason. Logged, never gating (`DECISIONS.md` S9). */
    flagged: boolean('flagged').notNull().default(false),

    /** The panel this vote came from. `brief §1.3` keys the preview cache on it. */
    personaVersion: text('persona_version').notNull(),

    /** The clustering generation the vote was cast against — `brief §1.5`'s key. */
    uniquenessVersion: text('uniqueness_version').notNull(),

    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null', onUpdate: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'demand_votes_cluster_fk',
      columns: [t.clusterId, t.categoryId],
      foreignColumns: [clusters.id, clusters.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    foreignKey({
      name: 'demand_votes_product_fk',
      columns: [t.productId, t.categoryId],
      foreignColumns: [products.id, products.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    /**
     * `01 §5.3` gives each persona ONE forced choice per cluster: at most one
     * first pick, one runner-up, one refusal. A duplicate would inflate that
     * product's in-cluster vote share, which is 40% of `demand_raw`.
     */
    unique('demand_votes_one_per_slot_uk').on(t.clusterId, t.personaName, t.pick, t.personaVersion),

    index('demand_votes_category_idx').on(t.categoryId, t.personaVersion),
    index('demand_votes_product_idx').on(t.productId),
    index('demand_votes_cluster_idx').on(t.clusterId),

    // A refusal names no product; a pick always does.
    check('demand_votes_none_has_no_product', sql`(${t.pick} = 'none') = (${t.productId} is null)`),

    // Conviction belongs to the first pick. A strength on a runner-up would be
    // averaged into `intensity` as if the persona had chosen it outright.
    check('demand_votes_strength_only_on_first', sql`${t.pick} = 'first' or ${t.strength} is null`),

    check('demand_votes_strength_range', sql`${t.strength} is null or ${t.strength} between 0 and 100`),
  ],
);
