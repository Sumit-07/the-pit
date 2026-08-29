/**
 * The whole Postgres schema for The Pit.
 *
 * `drizzle-kit generate` reads this file (see `drizzle.config.ts`), so a table
 * that is not re-exported here does not exist as far as migrations are concerned.
 *
 * The layering, which is the one thing to hold on to when reading it:
 *
 *   frozen panels     categories, jury_versions, persona_versions
 *   the population    products
 *   RAW PANEL OUTPUT  score_rows, cluster_members, demand_votes   <- source of truth
 *                     clusters
 *   derived           snapshots, rankings                          <- rebuildable
 *   the money path    orders, attempts
 *   surfaces          jobs, tokens, mob_votes, flagged_injections
 *
 * `02 §7` and `brief` Part 7 fix that third row: incremental placement and exact
 * recomputation both need the raw inputs, and the score log is the integrity
 * record if a ranking is ever disputed. Everything in the `derived` row can be
 * dropped and rebuilt; nothing in the `raw` row can be recovered from anything
 * else.
 */

export {
  attemptKind,
  categoryType,
  demandPick,
  demandStatus,
  injectionStage,
  jobKind,
  jobStatus,
  orderStatus,
  productSource,
  productStatus,
} from './enums.js';

export { categories, juryVersions, personaVersions } from './categories.js';
export { products } from './products.js';
export { jobs } from './jobs.js';
export { clusterMembers, clusters, demandVotes, scoreRows } from './raw.js';
export { rankings, snapshots } from './boards.js';
export { attempts, orders } from './commerce.js';
export { tokens } from './auth.js';
export { mobVotes } from './mob.js';
export { flaggedInjections } from './moderation.js';
