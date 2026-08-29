/**
 * The ranking math — `01 §6`, with the `DECISIONS.md` S3 correction to §6.3.
 *
 * Every function here is pure and does no I/O. No model call produces or sees a
 * rank (Global Constraint 1); all of it is arithmetic over stored raw rows.
 */

export type { BlendInput, BlendedProduct } from './blend.js';
export { blend, finalOrder, meritOrder, ranksFrom } from './blend.js';
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
