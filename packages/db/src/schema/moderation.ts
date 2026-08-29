/**
 * `flagged_injections` — every prompt-injection match, from both of the two jobs
 * `DECISIONS.md` S9 separated.
 *
 * `02 §9` sketched one table: `(source, product_id, persona_or_role, cluster_id,
 * reason, created_at)`. S9 split the behaviour that fills it in two, and the
 * table needs a discriminator to survive the split:
 *
 * - `stage = 'input'` — the narrow injection-shaped phrase list run over
 *   submitted name and description ("ignore previous", "disregard the above",
 *   "system prompt"). This one GATES: `brief §2.6` holds a flagged submission
 *   rather than serving it, which on the free unmoderated tier is the difference
 *   between an injected result being returned to the internet and being queued.
 * - `stage = 'output'` — `01 §8`'s broad regex over juror, cluster and persona
 *   reasons. This one is an alarm. S9: it "NEVER gates delivery or holds a
 *   preview." Bare `prompt` / `system` / `instructions` were removed from the
 *   input gate precisely because Developer Tools, AI Agents and SEO are full of
 *   legitimate products about prompts and systems — and the 17 output flags on
 *   the seeded Developer Tools board are that prediction coming true.
 *
 * One table with a `stage` column rather than two tables, because they share
 * every other field and one admin board reads both; but without the column the
 * board cannot tell a held customer from a logged curiosity, which is the only
 * distinction that matters when triaging it.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { categories } from './categories.js';
import { injectionStage } from './enums.js';
import { jobs } from './jobs.js';
import { products } from './products.js';
import { clusters } from './raw.js';

export const flaggedInjections = pgTable(
  'flagged_injections',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    stage: injectionStage('stage').notNull(),

    /**
     * `FlaggedInjection.source` from the engine: a juror `role`, `"uniqueness"`,
     * or `"demand"` on the output alarm; `"submission"` on the input gate.
     * `02 §9` called this pair of ideas `source` + `persona_or_role`; the engine
     * emits one string, so one column.
     */
    source: text('source').notNull(),

    /** The reason text that matched. */
    reason: text('reason').notNull(),

    /**
     * The substring the pattern matched — `FlaggedInjection.matched`. Not in
     * `02 §9`. Without it an admin re-runs the regex by hand to find out what
     * tripped, on text that was hostile enough to trip it.
     */
    matched: text('matched').notNull(),

    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    clusterId: uuid('cluster_id').references(() => clusters.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null', onUpdate: 'cascade' }),

    /** Set when an admin has triaged the row. The queue is `reviewed_at is null`. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The admin board: what is waiting, newest first, gating flags first. */
    index('flagged_injections_stage_idx').on(t.stage, t.reviewedAt, t.createdAt),
    index('flagged_injections_category_idx').on(t.categoryId, t.createdAt),
    index('flagged_injections_product_idx').on(t.productId),

    check('flagged_injections_reviewer_recorded', sql`(${t.reviewedAt} is null) = (${t.reviewedBy} is null)`),
  ],
);
