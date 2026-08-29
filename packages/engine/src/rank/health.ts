/**
 * Panel-quality statistics — `01 §6.5` (`jury_health`, `rank_final.py:234`).
 *
 * These are the numbers that say whether a ranking should be trusted at all:
 * a jury that agrees on everything produces a board with no information in it,
 * however confident the individual scores look.
 */

import type { Health, ScorecardEntry } from '../types.js';
import { mean, popStd } from './stats.js';

export interface JuryHealthInput {
  /** Per-product scorecards from `buildScorecards`; supplies every `spread`. */
  scorecards: ReadonlyMap<number, readonly ScorecardEntry[]>;
  /** Every product's merit composite. */
  composites: readonly number[];
  /** `demand_raw` for the products that have one. */
  demandRaw: readonly number[];
  /** Count of products whose final rank differs from their pure-merit rank (`01 §6.4`). */
  tiebreakCount: number;
}

/**
 * - `discrimination` — population std of the merit composites. Low means the
 *   products score alike, so merit alone is fragile; `01 §6.5` says the board
 *   flags below 0.5. The threshold belongs to the board, not to this function,
 *   which reports the number without judging it.
 * - `demand_discrimination` — population std of `demand_raw`, over the products
 *   that have one. An empty list is 0: no panel ran, so no spread exists.
 * - `avg_metric_spread` — mean over (product, metric) of the cross-juror
 *   population std of raw scores, i.e. how much the jury disagrees per metric.
 *   High disagreement is healthy; near-zero means the six jurors are one juror.
 * - `tiebreak_count` — `01 §6.4`. The name is historical: it counts products
 *   demand + uniqueness moved off their pure-merit position, not duels.
 */
export function juryHealth(input: JuryHealthInput): Health {
  const spreads: number[] = [];
  for (const entries of input.scorecards.values()) {
    for (const entry of entries) spreads.push(entry.spread);
  }

  return {
    avg_metric_spread: mean(spreads),
    discrimination: popStd(input.composites),
    demand_discrimination: popStd(input.demandRaw),
    tiebreak_count: input.tiebreakCount,
  };
}
