import { describe, expect, it } from 'vitest';

import { median, pearson, quantile, rankAverages, spearman } from '../../src/report/stats.js';

/**
 * The report's statistical primitives.
 *
 * House rule on this branch: every statistic has a HAND-COMPUTED expectation, and
 * for the correlations the arithmetic is written out in a comment. A test whose
 * expectation was produced by running the implementation proves only that the
 * code agrees with itself — which is exactly the failure mode a correlation
 * matrix would hide, since a sign error or a sample-vs-population divisor
 * produces a perfectly plausible number.
 */

describe('median', () => {
  it('is 0 for an empty list, matching mean()', () => {
    expect(median([])).toBe(0);
  });

  it('takes the middle value of an odd-length list', () => {
    // sorted [1, 2, 3] -> middle index 1 -> 2
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values of an even-length list', () => {
    // sorted [1, 2, 3, 4] -> (2 + 3) / 2 = 2.5
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('finds the panel median the dead-weight rule is stated against', () => {
    // Six jurors' deduction totals, the shape the rule was written for.
    // sorted [5, 20, 70, 80, 90, 100] -> (70 + 80) / 2 = 75
    expect(median([100, 90, 80, 70, 20, 5])).toBe(75);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('quantile — nearest rank', () => {
  // sorted [10, 20, 30, 40]. index = ceil(q * 4) - 1, clamped to [0, 3].
  const values = [40, 10, 30, 20];

  it('takes ceil(q * n) as a 1-based position', () => {
    expect(quantile(values, 0.25)).toBe(10); // ceil(1.0) = 1 -> index 0
    expect(quantile(values, 0.5)).toBe(20); // ceil(2.0) = 2 -> index 1
    expect(quantile(values, 0.75)).toBe(30); // ceil(3.0) = 3 -> index 2
    expect(quantile(values, 1)).toBe(40); // ceil(4.0) = 4 -> index 3
  });

  it('clamps q = 0 onto the first element rather than index -1', () => {
    expect(quantile(values, 0)).toBe(10);
  });

  it('returns a value that was actually in the list, never an interpolation', () => {
    // sorted [10, 20, 30]: ceil(0.5 * 3) = 2 -> index 1 -> 20.
    // An interpolating quartile would return 20 here too, so the discriminating
    // case is n = 4 above, where p25 is 10 and an interpolator would say 12.5.
    expect(quantile([30, 10, 20], 0.5)).toBe(20);
  });

  it('is 0 for an empty list', () => {
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('pearson', () => {
  it('is exactly 1 for a perfectly increasing relationship', () => {
    expect(pearson([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
  });

  it('is exactly -1 for a perfectly decreasing one', () => {
    expect(pearson([1, 2, 3], [30, 20, 10])).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed case', () => {
    // x = [1, 2, 3, 4]   mean 2.5   dx = [-1.5, -0.5, 0.5, 1.5]
    // y = [2, 4, 5, 9]   mean 5     dy = [  -3,   -1,   0,   4]
    //
    // sum dx*dy = (-1.5)(-3) + (-0.5)(-1) + (0.5)(0) + (1.5)(4)
    //           = 4.5 + 0.5 + 0 + 6 = 11
    // sum dx^2  = 2.25 + 0.25 + 0.25 + 2.25 = 5
    // sum dy^2  = 9 + 1 + 0 + 16 = 26
    //
    // r = 11 / sqrt(5 * 26) = 11 / sqrt(130) = 11 / 11.4017542510 = 0.9647638
    expect(pearson([1, 2, 3, 4], [2, 4, 5, 9])).toBeCloseTo(0.9647638, 6);
  });

  it('reports a constant vector as 0, never NaN', () => {
    // popstd(y) = 0. `standardize` makes the same choice for the same reason
    // (01 §6.1): no information is 0, and a NaN would render as an empty cell
    // that reads as "no data".
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
    expect(Number.isNaN(pearson([1, 2, 3], [5, 5, 5]))).toBe(false);
  });

  it('is 0 for empty input', () => {
    expect(pearson([], [])).toBe(0);
  });

  it('refuses mismatched lengths rather than correlating the overlap', () => {
    expect(() => pearson([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });

  it('is symmetric', () => {
    const x = [1, 2, 3, 4];
    const y = [2, 4, 5, 9];
    expect(pearson(x, y)).toBe(pearson(y, x));
  });
});

describe('rankAverages', () => {
  it('ranks ascending from 1', () => {
    expect(rankAverages([10, 20, 30])).toEqual([1, 2, 3]);
    expect(rankAverages([30, 10, 20])).toEqual([3, 1, 2]);
  });

  it('averages tied ranks', () => {
    // sorted [1, 2, 4, 4, 5]. The two 4s occupy 1-based positions 3 and 4,
    // so both take (3 + 4) / 2 = 3.5.
    expect(rankAverages([5, 4, 4, 2, 1])).toEqual([5, 3.5, 3.5, 2, 1]);
  });

  it('averages a tie spanning the whole list', () => {
    // Positions 1 and 2 -> (1 + 2) / 2 = 1.5 for both.
    expect(rankAverages([7, 7])).toEqual([1.5, 1.5]);
  });

  it('returns ranks in INPUT order so they line up with the source vector', () => {
    expect(rankAverages([100, 1, 50])).toEqual([3, 1, 2]);
  });
});

describe('spearman', () => {
  it('is 1 when the two orderings agree', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
  });

  it('is -1 when one reverses the other', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed case with a tie', () => {
    // x = [1, 2, 3, 4, 5]  -> ranks rx = [1, 2, 3, 4, 5]           mean 3
    // y = [5, 4, 4, 2, 1]  -> ranks ry = [5, 3.5, 3.5, 2, 1]       mean 3
    //
    // dx = [-2, -1,  0,  1,  2]
    // dy = [ 2, 0.5, 0.5, -1, -2]
    //
    // sum dx*dy = -4 + -0.5 + 0 + -1 + -4 = -9.5
    // sum dx^2  = 4 + 1 + 0 + 1 + 4 = 10
    // sum dy^2  = 4 + 0.25 + 0.25 + 1 + 4 = 9.5
    //
    // r = -9.5 / sqrt(10 * 9.5) = -9.5 / sqrt(95) = -sqrt(95) / 10 = -0.9746794
    //
    // Note the shortcut formula 1 - 6*sum(d^2)/(n(n^2-1)) gives -0.975 here,
    // which is WRONG in the presence of ties. That is why `spearman` is defined
    // as Pearson over average ranks rather than through the shortcut.
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 4, 2, 1])).toBeCloseTo(-0.9746794, 7);
  });

  it('is invariant to any monotone transform of either input', () => {
    // The defining property of a rank correlation: squaring positive values
    // changes every Pearson term and no Spearman one.
    const x = [1, 2, 3, 4];
    const y = [2, 4, 5, 9];
    expect(spearman(x, y)).toBeCloseTo(spearman(x, y.map((value) => value * value)), 12);
  });

  it('refuses mismatched lengths', () => {
    expect(() => spearman([1, 2], [1])).toThrow(/length mismatch/);
  });
});
