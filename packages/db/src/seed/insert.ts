/**
 * Write one category's `SeedRows` into a database, in one transaction.
 *
 * Order is dependency order, and it is not negotiable: the composite foreign keys
 * on `score_rows`, `cluster_members`, `demand_votes` and `rankings` all check a
 * `(id, category_id)` pair, so a child inserted before its parent fails rather
 * than dangling. That is the point of them.
 *
 * `onConflictDoNothing` on every statement plus the deterministic ids from
 * `ids.ts` make re-running the seed a no-op instead of a duplicate-key crash or,
 * worse, a second copy of the category under fresh uuids.
 *
 * One transaction per category, not one for the whole seed: two categories are
 * independent (`01 §9` rule 2 — never a cross-category anything), and a failure
 * in the second should not roll back the first.
 */

import type { Database } from '../client.js';
import {
  accounts,
  categories,
  clusterMembers,
  clusters,
  demandVotes,
  flaggedInjections,
  juryVersions,
  personaVersions,
  products,
  rankings,
  scoreRows,
  snapshots,
  verdicts,
} from '../schema/index.js';
import type { SeedRows } from './build.js';

/** How many rows go in one `INSERT`. A 48-product board is ~1,440 score rows. */
const BATCH = 500;

/** Counts written, for the CLI to print. */
export interface SeedCounts {
  products: number;
  scoreRows: number;
  clusters: number;
  clusterMembers: number;
  demandVotes: number;
  rankings: number;
  flaggedInjections: number;
  verdicts: number;
  accounts: number;
}

export async function insertSeedRows(db: Database, rows: SeedRows): Promise<SeedCounts> {
  return db.transaction(async (tx) => {
    // Accounts first: `verdicts.account_id` points at them, and a paid listing's
    // payer has to exist before the listing's verdict page can name them. Empty
    // for the two seeded boards, which are unclaimed (`brief` Part 7).
    if (rows.accounts.length > 0) await tx.insert(accounts).values(rows.accounts).onConflictDoNothing();

    await tx.insert(categories).values(rows.category).onConflictDoNothing();
    await tx.insert(juryVersions).values(rows.juryVersion).onConflictDoNothing();
    await tx.insert(personaVersions).values(rows.personaVersion).onConflictDoNothing();

    for (const batch of chunk(rows.products)) await tx.insert(products).values(batch).onConflictDoNothing();
    for (const batch of chunk(rows.clusters)) await tx.insert(clusters).values(batch).onConflictDoNothing();
    for (const batch of chunk(rows.clusterMembers)) await tx.insert(clusterMembers).values(batch).onConflictDoNothing();
    for (const batch of chunk(rows.scoreRows)) await tx.insert(scoreRows).values(batch).onConflictDoNothing();
    for (const batch of chunk(rows.demandVotes)) await tx.insert(demandVotes).values(batch).onConflictDoNothing();

    await tx.insert(snapshots).values(rows.snapshot).onConflictDoNothing();
    for (const batch of chunk(rows.rankings)) await tx.insert(rankings).values(batch).onConflictDoNothing();
    for (const batch of chunk(rows.flaggedInjections)) {
      await tx.insert(flaggedInjections).values(batch).onConflictDoNothing();
    }

    // Last, and after `products`: a verdict names the listing it judges, and its
    // own table refuses UPDATE, so a re-run must collide on the primary key and
    // do nothing rather than attempt to correct anything.
    for (const batch of chunk(rows.verdicts)) await tx.insert(verdicts).values(batch).onConflictDoNothing();

    return {
      products: rows.products.length,
      scoreRows: rows.scoreRows.length,
      clusters: rows.clusters.length,
      clusterMembers: rows.clusterMembers.length,
      demandVotes: rows.demandVotes.length,
      rankings: rows.rankings.length,
      flaggedInjections: rows.flaggedInjections.length,
      verdicts: rows.verdicts.length,
      accounts: rows.accounts.length,
    };
  });
}

function* chunk<T>(rows: readonly T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += BATCH) yield rows.slice(i, i + BATCH);
}
