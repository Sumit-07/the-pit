/**
 * The statistical primitives the Phase 1 report needs and `src/rank/stats.ts`
 * does not have: a median, a Pearson correlation, and a Spearman rank
 * correlation with proper tie handling.
 *
 * They live here rather than beside `mean` and `popStd` because nothing in
 * `src/rank/` may depend on them: `01 §6` computes no correlation, and a
 * primitive sitting in the ranking module invites a future edit that lets a
 * report statistic leak into a rank. Everything in this file is descriptive.
 *
 * Global Constraint 7 still applies — `pearson` centres on the arithmetic mean
 * and divides by POPULATION sums of squares, the same convention `popStd` and
 * `standardize` use. A sample correlation would differ only by a factor that
 * cancels in the ratio, but the intermediate quantities would no longer match
 * the ones `01 §6` is written against.
 *
 * ## The zero-variance convention
 *
 * A constant vector carries no information, so its correlation with anything is
 * reported as 0 rather than NaN. That is the same choice `standardize` makes
 * (`popstd == 0 -> z = 0`, `01 §6.1`) and for the same reason: a NaN would
 * propagate silently through a matrix and render as an empty cell, which reads
 * as "no data" when the truth is "this juror gave every product the same score"
 * — an extremely loud finding that must not be swallowed.
 */

/**
 * The median. Even-length input takes the mean of the two middle values, the
 * standard convention; empty input is 0, matching `mean`.
 *
 * Used for the dead-weight rule, which is stated against the panel MEDIAN
 * (`docs/plans/phase-1-engine.md` Task 8) precisely because a mean would be
 * dragged down by the dead juror the rule is trying to find.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The `q`-quantile by NEAREST RANK: the value at position `ceil(q * n)` in the
 * sorted list, 1-based. No interpolation, so every value reported is a value a
 * juror actually returned.
 *
 * Deliberately a different convention from `median` above, and the two can
 * disagree by one position on an even-length input. That is accepted because
 * each is the right tool for its job: the dead-weight threshold is a derived
 * cut-point and wants the interpolating median, while a printed quartile of a
 * juror's scores should be a score that juror actually gave.
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(q)) throw new RangeError(`quantile: q must be finite, got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(q * sorted.length) - 1;
  const clamped = Math.min(Math.max(index, 0), sorted.length - 1);
  return sorted[clamped] ?? 0;
}

/**
 * Pearson product-moment correlation over the population.
 *
 * ```
 * r = sum((x - mean x)(y - mean y)) / sqrt(sum((x - mean x)^2) * sum((y - mean y)^2))
 * ```
 *
 * Returns 0 when either input is constant (see the header) and when either is
 * empty. `NaN` is never returned.
 *
 * @throws when the two inputs are different lengths — that is a caller bug that
 *   would otherwise produce a plausible-looking number from mismatched rows.
 */
export function pearson(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length) {
    throw new RangeError(`pearson: length mismatch (${x.length} vs ${y.length})`);
  }
  if (x.length === 0) return 0;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < x.length; i += 1) {
    sumX += x[i] ?? 0;
    sumY += y[i] ?? 0;
  }
  const meanX = sumX / x.length;
  const meanY = sumY / y.length;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = (x[i] ?? 0) - meanX;
    const dy = (y[i] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX === 0 || varianceY === 0) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * Ascending ranks with ties averaged — 1 for the smallest value.
 *
 * `[5, 4, 4, 2, 1]` becomes `[5, 3.5, 3.5, 2, 1]`: the two 4s occupy positions 3
 * and 4, so both take 3.5. Averaging is what keeps a Spearman correlation
 * unbiased in the presence of ties; assigning both the first free position would
 * shift the whole tail and inflate the correlation.
 *
 * Returned in INPUT order, so the result lines up element-for-element with the
 * vector it was derived from.
 */
export function rankAverages(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value || a.index - b.index);

  const ranks = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < indexed.length) {
    let end = position + 1;
    while (end < indexed.length && indexed[end]?.value === indexed[position]?.value) end += 1;
    // Positions `position+1 .. end` are 1-based; their mean is the shared rank.
    const shared = (position + 1 + end) / 2;
    for (let i = position; i < end; i += 1) {
      const entry = indexed[i];
      if (entry !== undefined) ranks[entry.index] = shared;
    }
    position = end;
  }
  return ranks;
}

/**
 * Spearman rank correlation: Pearson over the average ranks of each input.
 *
 * Defined this way rather than through the `1 - 6*sum(d^2)/(n(n^2-1))` shortcut
 * because that shortcut is only correct when there are NO ties, and silently
 * returns a wrong number when there are. The report uses this on merit
 * composites, where ties are unlikely, and on `orig_rank`, where they should be
 * impossible — but "should be impossible" is not a reason to use a formula that
 * fails quietly if it happens.
 *
 * +1 means the two orderings agree perfectly, -1 that one reverses the other,
 * 0 that they are unrelated.
 */
export function spearman(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length) {
    throw new RangeError(`spearman: length mismatch (${x.length} vs ${y.length})`);
  }
  return pearson(rankAverages(x), rankAverages(y));
}
