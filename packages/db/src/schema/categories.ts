/**
 * `categories`, `jury_versions`, `persona_versions` — the frozen, human-approved
 * panels and the category that points at the pair currently installed.
 *
 * `02 §8` is the reason these are versioned tables rather than columns on a
 * category: "A jury/panel is generated and approved *offline* … and stored,
 * versioned, in Postgres. A submission is scored against the frozen set; it **can
 * never trigger jury or persona regeneration.** Only an admin action bumps a
 * version." And `brief` Part 3 requires the old versions to survive the bump —
 * "keep old snapshots permanently addressable at dated URLs so issued verdict
 * cards still resolve, label boards by jury version" — so a version is a row, and
 * bumping is an insert.
 */

import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { categoryType } from './enums.js';

/**
 * One product category. `01 §9` rule 2's standing constraint — one category at a
 * time, never a cross-category leaderboard — is why almost every other table in
 * this schema carries a `category_id`.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `categorySlug()` from `@the-pit/engine` — the identity the run artifacts,
     * the CDN path and every seed are keyed by. Unique because it is the public
     * URL segment.
     */
    slug: text('slug').notNull(),

    /** The display name, e.g. "Health, Fitness & Wellness". */
    name: text('name').notNull(),

    type: categoryType('type').notNull(),

    /**
     * The installed jury (`jury_versions.version`). Non-null: `brief §1.3` keys
     * the preview cache on it, and `01 §4` Step 2 bumps it on any rubric or
     * mandate edit precisely so caches invalidate.
     *
     * Deliberately NOT a foreign key to `jury_versions`. That edge and
     * `jury_versions.category_id` form a cycle, and a cycle makes the first
     * insert of a brand-new category impossible without a deferred constraint —
     * friction on the admin path in exchange for nothing, since the version
     * strings are written by the same admin transaction that writes the row.
     * `test/schema/versions.test.ts` asserts the column is present and NOT NULL,
     * which is the property `brief §1.3` actually depends on.
     */
    promptVersion: text('prompt_version').notNull(),

    /** The installed customer panel (`persona_versions.version`). Same reasoning. */
    personaVersion: text('persona_version').notNull(),

    /**
     * The population's version — `brief §1.3`'s `category_snapshot_version`, the
     * engine's `RunMeta.category_version`.
     *
     * Bumps on every placement and every nightly rebuild (`brief` Part 3),
     * because `brief §1.2` is explicit that appending a product shifts the
     * population mean and std and therefore moves every existing z-score. A
     * preview cached without it serves a rank that was true against a board that
     * no longer exists. `DECISIONS.md` S10 records that this makes the key rarely
     * hit; that is a cost problem, and the alternative is a correctness one.
     */
    categorySnapshotVersion: text('category_snapshot_version').notNull(),

    /**
     * Where the published board sits behind the CDN (`02 §4`). Null until the
     * category has been snapshotted once. The authoritative history is
     * `snapshots`; this is the pointer the homepage follows.
     */
    snapshotUrl: text('snapshot_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('categories_slug_uk').on(t.slug),
    unique('categories_name_uk').on(t.name),
    // The slug is a URL segment and a filesystem path under `cjr/runs/`; anything
    // outside this alphabet means someone bypassed `categorySlug()`.
    check('categories_slug_shape', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/**
 * One approved jury: the rubric and the six mandates, exactly the artifact
 * `01 §4` Step 2 writes once APPROVAL GATE 1 has fired. `02 §9` sketched
 * `(category_id, version, metrics_json, jurors_json, approved_by, created_at)`.
 *
 * Append-only by intent: a juror swap is a new row, never an UPDATE. `brief`
 * Part 3 calls that a season change — a new weight vector, a new composite, a
 * reshuffled board — and the old row is what lets a verdict card issued under it
 * still resolve.
 */
export const juryVersions = pgTable(
  'jury_versions',
  {
    categoryId: uuid('category_id')
      .notNull()
      // RESTRICT, not CASCADE. `brief` Part 7 calls the score log "the integrity
      // record if anyone disputes a ranking"; a jury nobody can read is a score
      // log nobody can interpret, so deleting a category must fail loudly rather
      // than quietly take the evidence with it.
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** The value `categories.prompt_version` points at, and `Jury.prompt_version`. */
    version: text('version').notNull(),

    /** `RubricMetric[]` — name, description and the four `01 §4` Step 2 anchors. */
    metrics: jsonb('metrics').notNull(),

    /** `JurorMandate[]` — six of them (`DECISIONS.md` S1), each with its weight vector. */
    jurors: jsonb('jurors').notNull(),

    /**
     * Who fired APPROVAL GATE 1. `02 §8` replaces the skill's interactive gate
     * with "frozen, human-approved" panels; a gate with no recorded approver is
     * not a gate.
     */
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'jury_versions_pk', columns: [t.categoryId, t.version] }),
    // `01 §4` Step 2 requires 3-6 metrics and `DECISIONS.md` S1 requires exactly
    // six jurors. The per-element rules (weights keyed by the metric names, every
    // field non-empty) belong to `validateJury` in the engine, which is the only
    // thing that constructs a `Jury`; these two are the cardinality claims a
    // hand-edited row could break without any code noticing.
    check('jury_versions_metrics_count', sql`jsonb_array_length(${t.metrics}) between 3 and 6`),
    check('jury_versions_jurors_count', sql`jsonb_array_length(${t.jurors}) = 6`),
  ],
);

/**
 * One approved customer panel — `01 §4` Step 3's artifact past APPROVAL GATE 2.
 * `02 §9`: `(category_id, version, personas_json, approved_by, created_at)`.
 */
export const personaVersions = pgTable(
  'persona_versions',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** The value `categories.persona_version` points at, and `PersonaPanel.persona_version`. */
    version: text('version').notNull(),

    /** `Persona[]` — name, description, needs, price sensitivity. */
    personas: jsonb('personas').notNull(),

    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'persona_versions_pk', columns: [t.categoryId, t.version] }),
    // `01 §4` Step 3 / `validate_personas`: 4-8 personas.
    check('persona_versions_personas_count', sql`jsonb_array_length(${t.personas}) between 4 and 8`),
    // No index on `category_id` alone: the primary key's leading column is
    // already `category_id`, so a second btree would be dead weight on every
    // write.
  ],
);
