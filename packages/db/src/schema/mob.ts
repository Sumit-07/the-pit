/**
 * `mob_votes` — real visitors doing the Floor's job.
 *
 * `brief` Part 4: "**The Mob** — Real visitors doing the **identical task** to the
 * Floor … Same forced choice, same cluster, same schema — so synthetic demand and
 * real demand are directly comparable per cluster. Costs zero model calls. No
 * competitor has this dataset."
 *
 * "Same schema" is taken literally: this table's `pick` column is the SAME
 * `demand_pick` enum as `demand_votes`, and `strength` carries the same 0-100
 * conviction with the same first-pick-only rule. A per-cluster comparison is
 * therefore a union of two tables rather than a translation between two vocabularies,
 * and `brief` Part 4's divergence marker ("a marker on rows where Mob and Floor
 * disagree, with a running count") is one query.
 *
 * The Mob does NOT affect rank. It has no `persona_version`, it writes nothing
 * into `rankings`, and `01 §9` rule 1's arithmetic never reads it. It is a
 * separate board.
 *
 * Two of Part 4's three rules are behavioural and live in the serving code, not
 * here:
 *
 * - "Never serve someone duels from their own category" — a property of which
 *   cluster is offered to which visitor. There is no link from a `voter_id` to a
 *   submission for the database to check.
 * - "Vote before seeing the Floor's verdict, or you're measuring anchoring" — a
 *   property of the page. Deliberately not stored as a `saw_verdict` flag: a
 *   column that is always `false` documents an intention and enforces nothing,
 *   and a vote cast after the reveal must simply never be written.
 *
 * The third — one visitor, one answer per cluster — is enforceable and enforced.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { demandPick } from './enums.js';
import { clusters } from './raw.js';
import { products } from './products.js';

export const mobVotes = pgTable(
  'mob_votes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    categoryId: uuid('category_id').notNull(),
    clusterId: uuid('cluster_id').notNull(),

    /** Null exactly when `pick = 'none'`, as on the Floor. */
    productId: uuid('product_id'),

    pick: demandPick('pick').notNull(),

    /** Optional conviction, 0-100, first pick only — the Floor's `strength` field. */
    strength: integer('strength'),

    /**
     * Optional. A persona always explains itself (`01 §5.3` makes `reason`
     * required); a visitor is under no such obligation, and demanding one would
     * cost more votes than the prose is worth.
     */
    reason: text('reason'),

    /**
     * An opaque per-visitor identifier from a signed cookie. Not an account:
     * `brief` Part 4's Mob needs no login, and `brief §2.6`'s free surfaces are
     * explicitly "No login."
     */
    voterId: text('voter_id').notNull(),

    /**
     * A keyed hash of the source address, for the per-IP rate limiting `brief
     * §2.6` requires on the free tier. The address itself is never stored.
     */
    voterIpHash: text('voter_ip_hash'),

    /** The clustering generation voted against — `brief §1.5`'s key, as on the Floor. */
    uniquenessVersion: text('uniqueness_version').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'mob_votes_cluster_fk',
      columns: [t.clusterId, t.categoryId],
      foreignColumns: [clusters.id, clusters.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    foreignKey({
      name: 'mob_votes_product_fk',
      columns: [t.productId, t.categoryId],
      foreignColumns: [products.id, products.categoryId],
    })
      .onDelete('restrict')
      .onUpdate('cascade'),

    /**
     * One visitor, one answer per slot per cluster — the same constraint the
     * Floor has. Without it a single voter with a refresh key can manufacture a
     * divergence between the Mob and the Floor, which is the one dataset here
     * that has any value.
     */
    unique('mob_votes_one_per_slot_uk').on(t.clusterId, t.voterId, t.pick, t.uniquenessVersion),

    index('mob_votes_cluster_idx').on(t.clusterId, t.createdAt),
    index('mob_votes_product_idx').on(t.productId),
    index('mob_votes_voter_idx').on(t.voterId, t.createdAt),

    check('mob_votes_none_has_no_product', sql`(${t.pick} = 'none') = (${t.productId} is null)`),
    check('mob_votes_strength_only_on_first', sql`${t.pick} = 'first' or ${t.strength} is null`),
    check('mob_votes_strength_range', sql`${t.strength} is null or ${t.strength} between 0 and 100`),
  ],
);
