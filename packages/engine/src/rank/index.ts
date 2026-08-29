/**
 * The ranking math — `01 §6`, with the `DECISIONS.md` S3 correction to §6.3.
 *
 * Every function here is pure and does no I/O. No model call produces or sees a
 * rank (Global Constraint 1); all of it is arithmetic over stored raw rows.
 */

export type { BlendInput, BlendedProduct } from './blend.js';
export { blend, finalOrder, meritOrder, ranksFrom } from './blend.js';
// `chunkItems` is deliberately NOT re-exported. It chunks a list in the order it
// arrives, and `Product.id` order IS the incoming leaderboard, so a caller that
// chunks with it and hands the result to `buildScoreRequest` gets rank-contiguous
// comparison sets — the defect `src/panels/ordering.ts` exists to close. The
// prompts still look correct, so nothing downstream would announce the mistake.
// `orderedChunks` (`src/panels/ordering.ts`) is the only supported way to chunk
// products for a panel; it orders first and then calls `chunkItems` internally.
export { balancedChunks, partitionSizes } from './chunk.js';
export { computeComposite, normalizeWeights } from './composite.js';
export type { DemandReduction } from './demand.js';
export { clusterMembers, reduceDemand } from './demand.js';
export type { JuryHealthInput } from './health.js';
export { juryHealth } from './health.js';
export type { RankCategoryInput } from './ranking.js';
export { rankCategory } from './ranking.js';
export type { MergedJuror } from './score-log.js';
export { mergeScoreLog } from './score-log.js';
export { buildScorecards } from './scorecard.js';
export { RAW_SCORE_MAX, RAW_SCORE_MIN, clampScore, mean, popStd, standardize } from './stats.js';
