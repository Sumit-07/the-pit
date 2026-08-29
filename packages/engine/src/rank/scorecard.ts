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
 * Every juror in the score log contributes a value to every row, taken from the
 * SAME clamped table `computeComposite` reads: a juror that returned no score
 * for this metric contributes a substituted `SCORE_CLAMP_DEFAULT`, because that
 * is what it contributed to the rank. `01 §6`'s preamble is explicit that the
 * board and the health stats share their arithmetic "so they always agree", and
 * that `_clamp(x, 0, 100, default=50)` guards *every* raw score.
 *
 * The alternative — averaging only the jurors that answered — publishes a
 * scorecard the rank cannot be re-derived from. With six jurors, one omission on
 * a metric the other five scored 85 would print 85 on a board whose composite
 * used 50. `the-pit-build-brief.md` Part 7 calls the score log the integrity
 * record if anyone disputes a ranking, and that re-derivability is the product.
 *
 * The substitution is never silent: `substituted_roles` names every juror whose
 * cell was filled in, so a consumer discloses "this juror did not return a
 * score" instead of presenting a fabricated 50 as a juror's opinion.
 *
 * A score log with no jurors at all produces no scorecard rows — there is nobody
 * to substitute for, and the composite counts no jurors either.
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

    if (jurors.length > 0) {
      for (const name of metricNames) {
        const scores: number[] = [];
        const deductions: ScorecardDeduction[] = [];
        const substituted: string[] = [];

        for (const juror of jurors) {
          const metric = juror.rows.get(id)?.get(name);
          const raw = metric?.score;
          // The exact condition under which `clampScore` falls back, so
          // `substituted_roles` names every cell the default filled in — a row
          // the juror never returned and a row it returned as garbage alike.
          if (typeof raw !== 'number' || !Number.isFinite(raw)) substituted.push(juror.role);
          scores.push(clampScore(raw, SCORE_CLAMP_DEFAULT));
          for (const deduction of metric?.deductions ?? []) {
            deductions.push({ points: deduction.points, reason: deduction.reason, role: juror.role });
          }
        }

        entries.push({
          metric: name,
          score: mean(scores),
          spread: popStd(scores),
          deductions,
          juror_count: jurors.length,
          substituted_roles: substituted,
        });
      }
    }

    scorecards.set(id, entries);
  }

  return scorecards;
}
