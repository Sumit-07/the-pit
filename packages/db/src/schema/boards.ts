/**
 * `snapshots` and `rankings` — the DERIVED artifacts.
 *
 * Neither is a source of truth. `02 §9`: "`ranking.json` is a *derived artifact*
 * pushed to the bucket, always reproducible by running the ported `rank_final`
 * over the rows." Everything here can be dropped and rebuilt from `score_rows`,
 * `cluster_members` and `demand_votes` plus the jury's weight vector; nothing
 * here may be edited in place to change a published number.
 *
 * They exist because `02 §1` splits reads from writes: "thousands of visitors
 * browsing static rankings should never touch a model", and `brief` Part 3 —
 * "Boards are **CDN snapshots**, regenerated on placement. Reads never touch a
 * model." A board read is one indexed scan of `rankings`, or a CDN hit on the
 * JSON in `snapshots.document`.
 *
 * The split between the two tables is version-addressability. `brief` Part 3, on
 * changing the panel: "keep old snapshots permanently addressable at dated URLs
 * so issued verdict cards still resolve, label boards by jury version". A
 * snapshot is therefore immutable and identified by the four versions that
 * produced it; `rankings` holds its rows.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { categories } from './categories.js';
import { demandStatus } from './enums.js';
import { clusters } from './raw.js';
import { products } from './products.js';

/**
 * One published board: the whole `ranking.json` document (`01 §6.6`) plus the
 * versions it was computed under.
 *
 * `document` is stored rather than only pointed at because `brief` Part 7
 * requires "backups of the score log — it's the integrity record if anyone
 * disputes a ranking", and a verdict card is a claim about a board at an instant.
 * A CDN object can be purged; the row is what makes the claim answerable.
 */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The population version this board IS. `brief §1.3`'s
     * `category_snapshot_version`; bumps on every placement and every nightly
     * rebuild (`brief` Part 3), which is exactly the cadence at which a new
     * snapshot row appears.
     */
    categorySnapshotVersion: text('category_snapshot_version').notNull(),

    /** The jury (`Ranking.prompt_version`). `brief` Part 3: boards are labelled by it. */
    promptVersion: text('prompt_version').notNull(),

    /** The customer panel (`Ranking.demand_version` / `PersonaPanel.persona_version`). */
    personaVersion: text('persona_version').notNull(),

    /** The clustering generation (`Ranking.uniqueness_version`). */
    uniquenessVersion: text('uniqueness_version').notNull(),

    /**
     * How many products the board ranked. `brief` Part 5: "The verdict card is
     * stamped with a timestamp and product count precisely because the board
     * moves." The stamp has to come from the snapshot, not from a live count.
     */
    productCount: integer('product_count').notNull(),

    /** The full `Ranking` document, verbatim. */
    document: jsonb('document').notNull(),

    /** `Health` — `discrimination` and `avg_metric_spread` are `brief` Part 3's drift alarms. */
    health: jsonb('health').notNull(),

    /** The dated, permanently addressable CDN path (`brief` Part 3). Null until published. */
    url: text('url'),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One board per population version. Two snapshots claiming the same
     * `category_snapshot_version` would make `brief §1.3`'s preview cache key
     * ambiguous — the key would name a board and get two different answers.
     */
    unique('snapshots_category_version_uk').on(t.categoryId, t.categorySnapshotVersion),

    /** Target for `rankings`' composite FK, so a ranked row cannot escape its board's category. */
    unique('snapshots_id_category_uk').on(t.id, t.categoryId),

    index('snapshots_category_created_idx').on(t.categoryId, t.createdAt),
    index('snapshots_prompt_version_idx').on(t.categoryId, t.promptVersion),

    check('snapshots_product_count_non_negative', sql`${t.productCount} >= 0`),
    check('snapshots_url_only_when_published', sql`(${t.url} is null) = (${t.publishedAt} is null)`),
  ],
);

/**
 * One product's row on one snapshot — `RankedProduct` reduced to the numbers the
 * board sorts and filters by. The prose (scorecard, deduction ledger, persona
 * picks) stays in `snapshots.document` and, authoritatively, in the raw tables.
 *
 * `brief §1.2` is the reason this is per-snapshot rather than per-product:
 * "appending a product shifts population mean/std so **every existing z-score
 * changes** … Do not build anything that assumes rank stability between
 * placements." A rank is only ever true of one board, so it is stored on one
 * board.
 */
export const rankings = pgTable(
  'rankings',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    /**
     * CASCADE: these rows ARE the snapshot's body, and a derived artifact may be
     * rebuilt. The foreign key is declared once, as the composite
     * `rankings_snapshot_fk` below — a second single-column one would be the same
     * constraint checked twice on every insert.
     */
    snapshotId: uuid('snapshot_id').notNull(),

    categoryId: uuid('category_id').notNull(),
    productId: uuid('product_id').notNull(),

    /** 1-based board position. */
    rank: integer('rank').notNull(),

    /** `RankedProduct.composite` — the pure merit composite, before demand. */
    composite: doublePrecision('composite').notNull(),

    /** `RankedProduct.demand` — reduced `demand_raw`. Null exactly on a solo cluster. */
    demand: doublePrecision('demand'),

    /** `DECISIONS.md` S3/S11: whether the Floor convened at all. */
    demandStatus: demandStatus('demand_status').notNull(),

    /** The blended score the row is ranked by, after the `UNIQ_LAMBDA` tilt. */
    core: doublePrecision('core').notNull(),

    /** True when demand + scarcity moved the row off its pure-merit position. */
    tiebroken: boolean('tiebroken').notNull(),

    /** The cluster the product was judged inside. Null if the pass never ran. */
    clusterId: uuid('cluster_id').references(() => clusters.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'rankings_snapshot_fk',
      columns: [t.snapshotId, t.categoryId],
      foreignColumns: [snapshots.id, snapshots.categoryId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),

    foreignKey({
      name: 'rankings_product_fk',
      columns: [t.productId, t.categoryId],
      foreignColumns: [products.id, products.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    /** A product appears once on a board. */
    unique('rankings_snapshot_product_uk').on(t.snapshotId, t.productId),

    /**
     * And a position is held by one product. This is the constraint that makes a
     * half-written board impossible to publish: `rank_final` emits a dense
     * 1..n permutation, so a duplicated or skipped rank means the write was
     * partial or the ordering was recomputed against a different population.
     */
    unique('rankings_snapshot_rank_uk').on(t.snapshotId, t.rank),

    index('rankings_snapshot_rank_idx').on(t.snapshotId, t.rank),
    index('rankings_product_idx').on(t.productId, t.createdAt),

    check('rankings_rank_positive', sql`${t.rank} >= 1`),

    /**
     * `DECISIONS.md` S3: a solo-cluster product has no demand entry at all and is
     * ranked on merit renormalized to weight 1.0 — it is NOT a product with
     * `z_demand = 0`. Storing a demand number beside `solo_cluster` would erase
     * the distinction the verdict page has to explain.
     */
    check('rankings_demand_matches_status', sql`(${t.demandStatus} = 'scored') = (${t.demand} is not null)`),
  ],
);
