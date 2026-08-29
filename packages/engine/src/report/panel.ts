/**
 * What the merit panel actually did — the half of the Phase 1 gate that decides
 * whether the jury is a jury at all.
 *
 * Four statistics, in the order they can kill the project:
 *
 * 1. `panelCompleteness` — how many of the installed jurors are in the score log.
 *    Printed BESIDE `discrimination`, because `computeComposite` divides by the
 *    number of distinct roles actually present, so the two numbers cannot be read
 *    apart. See `discriminationOverFullPanel`.
 * 2. `jurorCorrelations` — cross-juror correlation of per-product composites.
 *    `01 §4` Step 2 asks that the jury genuinely disagree, and that is a human
 *    approval gate: no validator can check it. This matrix is the only
 *    quantitative proxy, and six jurors who all say the same thing is the failure
 *    mode that makes the whole product worthless.
 * 3. `jurorDeductions` — who is actually deducting. A juror that barely deducts
 *    is dead weight (`the-pit-agent-prompts.md` Phase 1).
 * 4. `jurorDistributions` — the per-metric score distribution per juror, which is
 *    the descriptive picture behind all three of the above.
 *
 * Everything here is pure arithmetic over a stored score log (Global Constraint
 * 1). No model is called, and nothing produced here is ever fed back into a rank.
 */

import {
  DEAD_WEIGHT_MEDIAN_FRACTION,
  JUROR_CORRELATION_CEILING,
  SCORE_CLAMP_DEFAULT,
} from '../config/constants.js';
import { computeComposite } from '../rank/composite.js';
import { mergeScoreLog } from '../rank/score-log.js';
import { RAW_SCORE_MAX, RAW_SCORE_MIN, clampScore, mean, popStd } from '../rank/stats.js';
import type { JurorWeights, ScoreLogEntry } from '../types.js';
import { median, pearson, quantile } from './stats.js';

/**
 * Width of one bar of the printed score histogram, in raw score points.
 *
 * A presentation choice over the fixed 0-100 scale, in the same class as
 * `UNIQ_TILT_DIVISOR` in `src/rank/blend.ts` and `RAW_SCORE_MIN`/`RAW_SCORE_MAX`
 * in `src/rank/stats.ts`: it shapes a picture, never a rank, so it is a named
 * local rather than an entry in the audited constants table. Five bars of 20
 * points is the coarsest split that still separates "harsh", "middling" and
 * "generous" jurors at a glance.
 */
const SCORE_BAND_WIDTH = 20;

/** Number of histogram bars. `100` lands in the last one, not in a sixth. */
const SCORE_BAND_COUNT = Math.ceil((RAW_SCORE_MAX - RAW_SCORE_MIN) / SCORE_BAND_WIDTH);

// --- Completeness --------------------------------------------------------------

/**
 * Whether the panel that produced this board was the panel that was installed.
 *
 * This exists because `discrimination` is not comparable across runs with
 * different panel sizes. `computeComposite` divides the summed per-juror
 * contributions by `jurors_present`, not by the installed jury size, so a run
 * where one juror never answered reports composites scaled up by
 * `jurors_expected / jurors_present` — exactly 1.2 on a 5-of-6 run — and
 * `discrimination`, a population std of those composites, is scaled by the same
 * factor. A partial panel can therefore lift `discrimination` over `01 §6.5`'s
 * 0.5 floor without a single score changing.
 *
 * That division is the right convention (a juror who did not vote should not
 * dilute the ones who did), so this is not a defect to fix. It is a fact the
 * report has to state, because inferring it from the board is impossible.
 */
export interface PanelCompleteness {
  /** Distinct juror roles in the score log — the divisor `computeComposite` uses. */
  jurors_present: number;
  /** Jurors on the installed jury. */
  jurors_expected: number;
  /** Installed roles with no entry in the score log at all. */
  missing_roles: string[];
  /** Score log roles the installed jury does not define. Should always be empty. */
  unexpected_roles: string[];
  /** `jurors_present x products x metrics` — cells a complete panel would fill. */
  cells_expected: number;
  /** Cells actually carrying a finite score from the juror named on them. */
  cells_present: number;
  /**
   * Cells the board publishes as a substituted `SCORE_CLAMP_DEFAULT` because the
   * juror returned nothing usable. Mirrors `ScorecardEntry.substituted_roles`.
   */
  cells_substituted: number;
  complete: boolean;
}

export interface PanelCompletenessInput {
  scoreLog: readonly ScoreLogEntry[];
  /** The INSTALLED jury, which is authoritative for who should have answered. */
  jury: readonly JurorWeights[];
  productIds: readonly number[];
  metricNames: readonly string[];
}

/** Who answered, and how much of the grid they filled. */
export function panelCompleteness(input: PanelCompletenessInput): PanelCompleteness {
  const jurors = mergeScoreLog(input.scoreLog);
  const presentRoles = new Set(jurors.map((juror) => juror.role));
  const installedRoles = new Set(input.jury.map((juror) => juror.role));

  let present = 0;
  let substituted = 0;
  for (const juror of jurors) {
    for (const id of input.productIds) {
      for (const name of input.metricNames) {
        const raw = juror.rows.get(id)?.get(name)?.score;
        // Exactly the condition `clampScore` falls back on and `buildScorecards`
        // records as a substitution, so the two can never disagree.
        if (typeof raw === 'number' && Number.isFinite(raw)) present += 1;
        else substituted += 1;
      }
    }
  }

  const expected = jurors.length * input.productIds.length * input.metricNames.length;

  return {
    jurors_present: jurors.length,
    jurors_expected: input.jury.length,
    missing_roles: [...installedRoles].filter((role) => !presentRoles.has(role)),
    unexpected_roles: [...presentRoles].filter((role) => !installedRoles.has(role)),
    cells_expected: expected,
    cells_present: present,
    cells_substituted: substituted,
    complete: jurors.length === input.jury.length && substituted === 0,
  };
}

/**
 * What `discrimination` would read if the composites had been normalized over
 * the whole installed panel instead of over the jurors that answered.
 *
 * `discrimination_reported x (jurors_present / jurors_expected)`. On a complete
 * panel the factor is 1 and this returns the input unchanged, which is the point:
 * the reader does not have to remember whether the adjustment applied.
 *
 * Returns the input unchanged when either count is zero — there is nothing to
 * scale by and a 0-of-0 panel has already failed louder tests than this one.
 */
export function discriminationOverFullPanel(discrimination: number, completeness: PanelCompleteness): number {
  const { jurors_present, jurors_expected } = completeness;
  if (jurors_present === 0 || jurors_expected === 0) return discrimination;
  return (discrimination * jurors_present) / jurors_expected;
}

// --- Score distributions -------------------------------------------------------

/** One juror's distribution of raw scores on one metric. */
export interface JurorMetricDistribution {
  role: string;
  metric: string;
  /** Cells this juror actually returned a finite score for. */
  n: number;
  /** Cells it did not, which the board publishes as `SCORE_CLAMP_DEFAULT`. */
  missing: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  /** Population std of this juror's own scores on this metric. */
  spread: number;
  /** Counts in `SCORE_BAND_COUNT` equal bands of the 0-100 scale, low to high. */
  bands: number[];
}

export interface DistributionInput {
  scoreLog: readonly ScoreLogEntry[];
  productIds: readonly number[];
  metricNames: readonly string[];
}

/**
 * Every (juror, metric) distribution, jurors in score-log order and metrics in
 * rubric order.
 *
 * Computed over the cells the juror ACTUALLY RETURNED, not over the substituted
 * table the composite reads. That is the opposite choice from `buildScorecards`,
 * and it is deliberate: a scorecard must describe the table the rank came from,
 * because a customer re-derives their placement from it, whereas this section
 * describes a juror's behaviour. Padding it with fabricated 50s would pull every
 * distribution toward the centre and make a silent juror look like a moderate
 * one. `missing` carries the same information without the distortion.
 */
export function jurorDistributions(input: DistributionInput): JurorMetricDistribution[] {
  const distributions: JurorMetricDistribution[] = [];

  for (const juror of mergeScoreLog(input.scoreLog)) {
    for (const metric of input.metricNames) {
      const scores: number[] = [];
      let missing = 0;

      for (const id of input.productIds) {
        const raw = juror.rows.get(id)?.get(metric)?.score;
        if (typeof raw === 'number' && Number.isFinite(raw)) scores.push(clampScore(raw, SCORE_CLAMP_DEFAULT));
        else missing += 1;
      }

      const bands = new Array<number>(SCORE_BAND_COUNT).fill(0);
      for (const score of scores) {
        const band = Math.min(Math.floor((score - RAW_SCORE_MIN) / SCORE_BAND_WIDTH), SCORE_BAND_COUNT - 1);
        bands[band] = (bands[band] ?? 0) + 1;
      }

      distributions.push({
        role: juror.role,
        metric,
        n: scores.length,
        missing,
        min: scores.length === 0 ? 0 : Math.min(...scores),
        p25: quantile(scores, 0.25),
        median: median(scores),
        p75: quantile(scores, 0.75),
        max: scores.length === 0 ? 0 : Math.max(...scores),
        mean: mean(scores),
        spread: popStd(scores),
        bands,
      });
    }
  }

  return distributions;
}

// --- Deduction rates -----------------------------------------------------------

/** One juror's contribution to the deduction ledger. */
export interface JurorDeductionRate {
  role: string;
  /** Total points this juror deducted, summed over every product and metric. */
  points: number;
  /** How many separate deductions it issued. */
  count: number;
  /** Distinct (product, metric) cells it deducted anything at all on. */
  cells_touched: number;
  /** `points / cells_touched`, or 0 when it touched none. */
  points_per_touched_cell: number;
  /** True when `points` is below `DEAD_WEIGHT_MEDIAN_FRACTION` of the panel median. */
  dead_weight: boolean;
}

/** The panel's deduction ledger and the dead-weight verdict over it. */
export interface DeductionReport {
  jurors: JurorDeductionRate[];
  /** Median of `points` across the jurors present. */
  median_points: number;
  /** `median_points x DEAD_WEIGHT_MEDIAN_FRACTION` — the dead-weight cut. */
  threshold: number;
  dead_weight_roles: string[];
}

/**
 * Per-juror deduction totals, and which jurors fall under half the panel median.
 *
 * `01 §5.1` makes the deduction the unit of a juror's opinion — start at 100 and
 * deduct with reasons — so a juror that deducts almost nothing is not being
 * lenient, it is not participating. Its per-metric z-scores collapse toward zero
 * and it contributes a near-constant column to the composite while still counting
 * in the divisor, which drags `discrimination` down for everyone else.
 *
 * Restricted to `productIds` and `metricNames` so the totals describe the same
 * grid every other statistic here does; a stray row for a product no longer in
 * the category cannot inflate a juror's total.
 */
export function jurorDeductions(input: DistributionInput): DeductionReport {
  const metricSet = new Set(input.metricNames);
  const productSet = new Set(input.productIds);

  const jurors: JurorDeductionRate[] = mergeScoreLog(input.scoreLog).map((juror) => {
    let points = 0;
    let count = 0;
    let cellsTouched = 0;

    for (const [productId, metrics] of juror.rows) {
      if (!productSet.has(productId)) continue;
      for (const [name, metric] of metrics) {
        if (!metricSet.has(name)) continue;
        let cellPoints = 0;
        for (const deduction of metric.deductions) {
          if (!Number.isFinite(deduction.points)) continue;
          cellPoints += deduction.points;
          count += 1;
        }
        if (cellPoints !== 0) cellsTouched += 1;
        points += cellPoints;
      }
    }

    return {
      role: juror.role,
      points,
      count,
      cells_touched: cellsTouched,
      points_per_touched_cell: cellsTouched === 0 ? 0 : points / cellsTouched,
      dead_weight: false,
    };
  });

  const medianPoints = median(jurors.map((juror) => juror.points));
  const threshold = medianPoints * DEAD_WEIGHT_MEDIAN_FRACTION;

  for (const juror of jurors) juror.dead_weight = juror.points < threshold;

  return {
    jurors,
    median_points: medianPoints,
    threshold,
    dead_weight_roles: jurors.filter((juror) => juror.dead_weight).map((juror) => juror.role),
  };
}

// --- Cross-juror correlation ---------------------------------------------------

/** One off-diagonal cell of the correlation matrix. */
export interface JurorPair {
  a: string;
  b: string;
  r: number;
}

/** The cross-juror composite correlation matrix and its verdict. */
export interface CorrelationReport {
  /** Roles in matrix order — score-log order, which is the order jurors answered. */
  roles: string[];
  /** Square, symmetric, 1 on the diagonal. `matrix[i][j]` is `pearson(i, j)`. */
  matrix: number[][];
  /** Every unordered pair once, `a` before `b` in `roles` order. */
  pairs: JurorPair[];
  /** Pairs at or above `JUROR_CORRELATION_CEILING`. Non-empty means redesign mandates. */
  flagged: JurorPair[];
  /** The most correlated pair, or `undefined` when there are fewer than two jurors. */
  max_pair?: JurorPair;
  /** Mean `r` over every pair — how much the panel agrees overall. */
  mean_pair_correlation: number;
}

export interface CorrelationInput {
  scoreLog: readonly ScoreLogEntry[];
  /** The installed jury; authoritative for each juror's metric weights. */
  jury: readonly JurorWeights[];
  productIds: readonly number[];
}

/**
 * Per-juror composites, then the Pearson correlation of every pair.
 *
 * Each juror's composite vector is `computeComposite` run over that juror's rows
 * alone — the same function the board uses, with a one-juror log, so the vectors
 * being correlated are literally the per-juror terms the real composite averages.
 * Reimplementing the weighting here would let the matrix and the board drift.
 *
 * Pearson rather than Spearman: these vectors are already z-scored per metric, so
 * the linear relationship is the meaningful one, and Pearson is the statistic
 * `01 §6` and the plan's 0.9 threshold are naturally read against. Two jurors
 * with `r = 0.95` are, for ranking purposes, one juror with a doubled vote.
 */
export function jurorCorrelations(input: CorrelationInput): CorrelationReport {
  const roles = mergeScoreLog(input.scoreLog).map((juror) => juror.role);

  const vectors = roles.map((role) => {
    const own = input.scoreLog.filter((entry) => entry.juror_role === role);
    const composite = computeComposite(own, input.jury, input.productIds);
    return input.productIds.map((id) => composite.get(id) ?? 0);
  });

  const matrix = vectors.map((left, i) =>
    vectors.map((right, j) => (i === j ? 1 : pearson(left, right))),
  );

  const pairs: JurorPair[] = [];
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      pairs.push({ a: roles[i] ?? '', b: roles[j] ?? '', r: matrix[i]?.[j] ?? 0 });
    }
  }

  const flagged = pairs.filter((pair) => pair.r >= JUROR_CORRELATION_CEILING);
  const maxPair = pairs.reduce<JurorPair | undefined>(
    (best, pair) => (best === undefined || pair.r > best.r ? pair : best),
    undefined,
  );

  const report: CorrelationReport = {
    roles,
    matrix,
    pairs,
    flagged,
    mean_pair_correlation: mean(pairs.map((pair) => pair.r)),
  };
  if (maxPair !== undefined) report.max_pair = maxPair;
  return report;
}
