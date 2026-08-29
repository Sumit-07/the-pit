/**
 * The per-product scorecard rows of `01 §6.6`:
 * `{metric, score (cross-juror mean), spread (cross-juror std), deductions:[{points, reason, role}]}`.
 *
 * This is the "scorecard, not raw scores" design invariant of `01 §1`: a buyer
 * sees what each metric cost and why, tagged with the juror role that took the
 * deduction, rather than an opaque number.
 *
 * `01 §6` requires the board and the health stats to share this arithmetic, so
 * `avg_metric_spread` in `01 §6.5` is the mean of exactly the `spread` values
 * computed here.
 */

import { SCORE_CLAMP_DEFAULT } from '../config/constants.js';
import type { ScoreLogEntry, ScorecardDeduction, ScorecardEntry } from '../types.js';
import { mergeScoreLog } from './score-log.js';
import { clampScore, mean, popStd } from './stats.js';

/**
 * Build every product's scorecard, one row per rubric metric, in rubric order.
 *
 * A (product, metric) pair NO juror returned is omitted rather than shown as a
 * default. That is deliberately different from `computeComposite`, which must
 * substitute 50.0 for a missing score because every juror needs a value on every
 * product to z-normalize across the set. The scorecard is the published record
 * of what the jury actually said, so it reports only what was actually returned;
 * inventing a 50 there would put a number in a customer's hands that no juror
 * ever wrote. `avg_metric_spread` follows the scorecard, so a metric nobody
 * scored contributes no disagreement rather than a fabricated zero.
 */
export function buildScorecards(
  scoreLog: readonly ScoreLogEntry[],
  metricNames: readonly string[],
  productIds: readonly number[],
): Map<number, ScorecardEntry[]> {
  const jurors = mergeScoreLog(scoreLog);
  const scorecards = new Map<number, ScorecardEntry[]>();

  for (const id of productIds) {
    const entries: ScorecardEntry[] = [];

    for (const name of metricNames) {
      const scores: number[] = [];
      const deductions: ScorecardDeduction[] = [];

      for (const juror of jurors) {
        const metric = juror.rows.get(id)?.get(name);
        if (metric === undefined) continue;
        scores.push(clampScore(metric.score, SCORE_CLAMP_DEFAULT));
        for (const deduction of metric.deductions ?? []) {
          deductions.push({ points: deduction.points, reason: deduction.reason, role: juror.role });
        }
      }

      if (scores.length === 0) continue;
      entries.push({ metric: name, score: mean(scores), spread: popStd(scores), deductions });
    }

    scorecards.set(id, entries);
  }

  return scorecards;
}
