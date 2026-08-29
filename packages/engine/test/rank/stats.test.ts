/**
 * The statistical primitives `01 §6` is built from.
 *
 * Global Constraint 7: POPULATION standard deviation (divide by N), never
 * sample std. The two differ by `sqrt(N/(N-1))` -- 1.2% on a 44-product
 * category -- which is small enough never to look wrong and large enough to move
 * a rank, so it gets a test that names the wrong answer explicitly.
 */

import { describe, expect, it } from 'vitest';

import { RAW_SCORE_MAX, RAW_SCORE_MIN, clampScore, mean, popStd, standardize } from '../../src/rank/stats.js';

const PRECISION = 12;

describe('popStd — population, not sample', () => {
  it('divides by N', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9]: mean 5; devs [-3,-1,-1,-1,0,0,2,4]
    // sumsq = 9+1+1+1+0+0+4+16 = 32; population var = 32/8 = 4; popstd = 2
    expect(popStd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, PRECISION);
    // The sample std of the same list is sqrt(32/7) = 2.1380899353. If this ever
    // starts passing, every z-score in the engine is inflated by 6.9%.
    expect(popStd([2, 4, 4, 4, 5, 5, 7, 9])).not.toBeCloseTo(2.1380899353, 6);
  });

  it('is 0 for identical values and for a single value', () => {
    expect(popStd([7, 7, 7])).toBe(0);
    expect(popStd([7])).toBe(0);
  });

  it('is 0 for an empty list rather than NaN', () => {
    // `demand_discrimination` reads this when no customer panel ran.
    expect(popStd([])).toBe(0);
  });
});

describe('mean', () => {
  it('averages', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('is 0 for an empty list, so an empty spread list contributes nothing', () => {
    expect(mean([])).toBe(0);
  });
});

describe('standardize', () => {
  it('produces z-scores with mean 0 and population std 1', () => {
    const z = standardize([10, 20, 30, 40]);
    expect(mean(z)).toBeCloseTo(0, PRECISION);
    expect(popStd(z)).toBeCloseTo(1, PRECISION);
  });

  it('returns all zeros when popstd is 0, never NaN', () => {
    // `01 §6.1`: popstd == 0 -> z = 0. A unanimous axis carries no information.
    expect(standardize([5, 5, 5])).toEqual([0, 0, 0]);
    expect(standardize([5])).toEqual([0]);
  });

  it('returns an empty list for an empty input', () => {
    expect(standardize([])).toEqual([]);
  });

  it('is invariant to a constant shift — the whole point of z-normalizing', () => {
    const base = standardize([90, 80, 70, 60]);
    const shifted = standardize([90, 80, 70, 60].map((score) => score - 25));
    base.forEach((value, index) => expect(shifted[index]).toBeCloseTo(value, PRECISION));
  });
});

describe('clampScore — `01 §6` `_clamp(x, 0, 100, default=...)`', () => {
  it('passes an in-range value through', () => {
    expect(clampScore(73, 50)).toBe(73);
    expect(clampScore(RAW_SCORE_MIN, 50)).toBe(0);
    expect(clampScore(RAW_SCORE_MAX, 50)).toBe(100);
  });

  it('pulls an out-of-range value back onto the scale', () => {
    expect(clampScore(140, 50)).toBe(100);
    expect(clampScore(-20, 50)).toBe(0);
  });

  it('substitutes the fallback for anything that is not a finite number', () => {
    expect(clampScore(undefined, 50)).toBe(50);
    expect(clampScore(null, 50)).toBe(50);
    expect(clampScore(Number.NaN, 50)).toBe(50);
    expect(clampScore(Number.POSITIVE_INFINITY, 50)).toBe(50);
  });

  it('takes the fallback the call site names, not a hardcoded one', () => {
    // UNIQ_NEUTRAL is also 50, but STRENGTH_DEFAULT and SCORE_CLAMP_DEFAULT are
    // separate constants and a future change to one must not silently move the
    // others.
    expect(clampScore(undefined, 12)).toBe(12);
  });
});
