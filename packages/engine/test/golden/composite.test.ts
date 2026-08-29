/**
 * GOLDEN FIXTURES — merit composite, `01 §6.1`.
 *
 * Every expected number below was computed BY HAND from `01 §6.1` and the
 * arithmetic is written out in the comment above it. None of it was produced by
 * running the implementation: a fixture generated from the code under test only
 * proves the code agrees with itself, which is worth nothing when the whole
 * product is the correctness of these numbers.
 *
 * Population std throughout (divide by N) — Global Constraint 7.
 */

import { describe, expect, it } from 'vitest';

import { computeComposite, normalizeWeights } from '../../src/rank/composite.js';
import type { JurorWeights, ScoreLogEntry } from '../../src/types.js';

const PRECISION = 9;

/** Build one juror's score-log entry from `metric name -> score per product`. */
function entry(
  role: string,
  productIds: readonly number[],
  metrics: Readonly<Record<string, readonly (number | undefined)[]>>,
): ScoreLogEntry {
  return {
    juror_role: role,
    prompt_version: 'v1',
    scores: productIds.map((id, index) => ({
      id,
      metrics: Object.entries(metrics)
        .filter(([, values]) => values[index] !== undefined)
        .map(([name, values]) => ({ name, score: values[index] as number, deductions: [] })),
    })),
  };
}

const IDS = [0, 1, 2, 3];

describe('normalizeWeights — `01 §6.1` `_normalize_weights`', () => {
  it('normalizes to sum 1 over the metric names', () => {
    // {A: 1, B: 3} -> total 4 -> {A: 1/4, B: 3/4}
    expect([...normalizeWeights({ A: 1, B: 3 })]).toEqual([
      ['A', 0.25],
      ['B', 0.75],
    ]);
  });

  it('floors negatives at 0 before normalizing', () => {
    // {A: -1, B: 3} -> cleaned {A: 0, B: 3} -> total 3 -> {A: 0, B: 1}
    expect([...normalizeWeights({ A: -1, B: 3 })]).toEqual([
      ['A', 0],
      ['B', 1],
    ]);
  });

  it('falls back to uniform 1/len when every weight is zero', () => {
    // {A: 0, B: 0, C: 0} -> total 0 -> uniform 1/3 each
    const uniform = [...normalizeWeights({ A: 0, B: 0, C: 0 }).values()];
    expect(uniform).toHaveLength(3);
    for (const weight of uniform) expect(weight).toBeCloseTo(1 / 3, PRECISION);
  });

  it('treats a whole-negative vector as all-zero and goes uniform', () => {
    // {A: -1, B: -2} -> cleaned {A: 0, B: 0} -> total 0 -> uniform 1/2
    expect([...normalizeWeights({ A: -1, B: -2 })]).toEqual([
      ['A', 0.5],
      ['B', 0.5],
    ]);
  });

  it('has nothing to normalize over an empty weight vector', () => {
    expect([...normalizeWeights({})]).toEqual([]);
  });
});

describe('computeComposite — VERIFIED ANCHOR: per-juror z cancels a constant offset', () => {
  /*
   * This is guardrail 3 in `01 §1`, and the case the whole design turns on: a
   * harsh juror and a lenient juror who agree on the ORDER must produce the same
   * ranking contribution. If they did not, a juror's absolute generosity would
   * be worth rank, and rank would be a property of who was asked.
   *
   * 2 jurors, 1 metric `M`, weights {M: 1.0} each, 4 products.
   *
   *   Juror A: [90, 80, 70, 60]
   *     mean   = (90+80+70+60)/4 = 300/4 = 75
   *     devs   = [15, 5, -5, -15]
   *     sumsq  = 225 + 25 + 25 + 225 = 500
   *     var    = 500/4 = 125                    (population: divide by N)
   *     popstd = sqrt(125) = 11.1803398875
   *     z      = [15, 5, -5, -15] / 11.1803398875
   *            = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   *
   *   Juror B: [100, 90, 80, 70]   -- the same board, 10 points more generous
   *     mean   = 340/4 = 85
   *     devs   = [15, 5, -5, -15]                <- IDENTICAL to juror A
   *     popstd = sqrt(500/4) = 11.1803398875     <- IDENTICAL to juror A
   *     z      = same as juror A
   *
   *   composite = (1.0*z_A + 1.0*z_B) / 2 jurors = z_A
   *             = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   */
  const jury: JurorWeights[] = [
    { role: 'harsh', weights: { M: 1.0 } },
    { role: 'lenient', weights: { M: 1.0 } },
  ];
  const scoreLog: ScoreLogEntry[] = [
    entry('harsh', IDS, { M: [90, 80, 70, 60] }),
    entry('lenient', IDS, { M: [100, 90, 80, 70] }),
  ];

  const EXPECTED = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865];

  it('reproduces the anchor composites', () => {
    const composite = computeComposite(scoreLog, jury, IDS);
    IDS.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });

  it('is unchanged when a juror is shifted by a constant', () => {
    /*
     * The 10-point offset between the two jurors is arbitrary. Slide each juror
     * by a different constant -- harsh by -37, lenient by -40 -- and the devs
     * from each juror's own mean are untouched, so the composites are identical.
     * (Both shifts stay inside 0-100; a shift that ran off the end would be
     * clamped, which is a different board, not the same board moved.)
     */
    const shifted: ScoreLogEntry[] = [
      entry('harsh', IDS, { M: [90 - 37, 80 - 37, 70 - 37, 60 - 37] }),
      entry('lenient', IDS, { M: [100 - 40, 90 - 40, 80 - 40, 70 - 40] }),
    ];
    const composite = computeComposite(shifted, jury, IDS);
    IDS.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });

  it('z-normalizes across products, not within a chunk', () => {
    /*
     * A juror scoring more than CHUNK_SIZE products arrives as several score-log
     * entries with the same role (`01 §5.1`). Split juror A's four scores into
     * two 2-product "chunks". Chunk-local z would give each chunk a mean of its
     * own two products -- z = [+1, -1, +1, -1] -- which is a completely different
     * board. Merging first is the only reading of "z-normalize across products".
     */
    const chunked: ScoreLogEntry[] = [
      entry('harsh', [0, 1], { M: [90, 80] }),
      entry('harsh', [2, 3], { M: [70, 60] }),
      entry('lenient', IDS, { M: [100, 90, 80, 70] }),
    ];
    const composite = computeComposite(chunked, jury, IDS);
    IDS.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });
});

describe('computeComposite — popstd == 0', () => {
  it('gives every product z = 0 when a juror scores them all alike', () => {
    /*
     * v = [70, 70, 70, 70] -> mean 70, devs all 0, popstd 0.
     * `01 §6.1`: popstd == 0 -> z = 0. A unanimous metric carries no information
     * and must contribute exactly nothing rather than divide by zero.
     * composite = (1.0 * 0) / 1 juror = 0 for every product.
     */
    const composite = computeComposite(
      [entry('flat', IDS, { M: [70, 70, 70, 70] })],
      [{ role: 'flat', weights: { M: 1.0 } }],
      IDS,
    );
    for (const id of IDS) expect(composite.get(id)).toBe(0);
  });

  it('does not produce NaN when every juror is unanimous', () => {
    const composite = computeComposite(
      [entry('a', IDS, { M: [0, 0, 0, 0] }), entry('b', IDS, { M: [100, 100, 100, 100] })],
      [
        { role: 'a', weights: { M: 1.0 } },
        { role: 'b', weights: { M: 1.0 } },
      ],
      IDS,
    );
    for (const id of IDS) expect(Number.isFinite(composite.get(id))).toBe(true);
  });
});

describe('computeComposite — a missing metric score defaults to 50.0', () => {
  /*
   * 1 juror, 1 metric M, weights {M: 1.0}, 3 products.
   * Product 0 scored 100; product 1 scored 50 explicitly; product 2 returns NO M
   * entry at all -> `01 §6.1` substitutes 50.0.
   *
   *   v      = [100, 50, 50]
   *   mean   = 200/3 = 66.6666666667
   *   devs   = [100/3, -50/3, -50/3] = [33.3333333333, -16.6666666667, -16.6666666667]
   *   sumsq  = (10000 + 2500 + 2500)/9 = 15000/9
   *   var    = 15000/27 = 5000/9 = 555.5555555556
   *   popstd = sqrt(5000)/3 = 23.5702260396
   *   z      = [33.3333333333, -16.6666666667, -16.6666666667] / 23.5702260396
   *          = [1.4142135624, -0.7071067812, -0.7071067812]     (= [sqrt2, -1/sqrt2, -1/sqrt2])
   *   composite = z / 1 juror = z
   *
   * The proof that the default is exactly 50.0 and not something else: product 2
   * lands on the identical composite as product 1, which was scored 50 for real.
   */
  const ids = [0, 1, 2];
  const jury: JurorWeights[] = [{ role: 'solo', weights: { M: 1.0 } }];
  const EXPECTED = [1.4142135624, -0.7071067812, -0.7071067812];

  it('defaults a metric the juror omitted from a returned row', () => {
    const scoreLog: ScoreLogEntry[] = [
      {
        juror_role: 'solo',
        prompt_version: 'v1',
        scores: [
          { id: 0, metrics: [{ name: 'M', score: 100, deductions: [] }] },
          { id: 1, metrics: [{ name: 'M', score: 50, deductions: [] }] },
          { id: 2, metrics: [] }, // row returned, metric M omitted
        ],
      },
    ];
    const composite = computeComposite(scoreLog, jury, ids);
    ids.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
    expect(composite.get(2)).toBeCloseTo(composite.get(1) as number, PRECISION);
  });

  it('defaults a product the juror left out of its rows entirely', () => {
    const scoreLog: ScoreLogEntry[] = [
      {
        juror_role: 'solo',
        prompt_version: 'v1',
        scores: [
          { id: 0, metrics: [{ name: 'M', score: 100, deductions: [] }] },
          { id: 1, metrics: [{ name: 'M', score: 50, deductions: [] }] },
          // no row for product 2 at all
        ],
      },
    ];
    const composite = computeComposite(scoreLog, jury, ids);
    ids.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });

  it('clamps an out-of-range score onto the 0-100 scale before normalizing', () => {
    // `01 §6` `_clamp(x, 0, 100, default=50)`. 250 clamps to 100 and -80 to 0,
    // so this is the v = [100, 50, 0] board, NOT [250, 50, -80].
    const clamped = computeComposite([entry('solo', ids, { M: [250, 50, -80] })], jury, ids);
    const honest = computeComposite([entry('solo', ids, { M: [100, 50, 0] })], jury, ids);
    for (const id of ids) {
      expect(clamped.get(id)).toBeCloseTo(honest.get(id) as number, PRECISION);
    }
    // v = [100, 50, 0] -> mean 50, devs [50, 0, -50], popstd sqrt(5000/3)... but
    // the assertion above is the load-bearing one: clamping happens BEFORE the mean.
  });
});

describe('computeComposite — weights, the uniform fallback, and the mean over jurors', () => {
  /*
   * 2 jurors, 2 metrics, 4 products. One fixture exercising every part of §6.1.
   *
   * Juror A, weights {M1: 3, M2: 1} -> normalized {M1: 0.75, M2: 0.25}
   *   M1 = [100, 75, 50, 25]
   *     mean 62.5; devs [37.5, 12.5, -12.5, -37.5]
   *     sumsq 1406.25 + 156.25 + 156.25 + 1406.25 = 3125; var 3125/4 = 781.25
   *     popstd = sqrt(781.25) = 27.9508497187
   *     z_M1 = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   *   M2 = [25, 50, 75, 100]  -- the exact reverse, so z_M2 = -z_M1
   *   A contributes 0.75*z_M1 + 0.25*(-z_M1) = 0.5*z_M1
   *              = [0.6708203932, 0.2236067977, -0.2236067977, -0.6708203932]
   *
   * Juror B, weights {M1: 0, M2: 0} -> all-zero -> uniform {M1: 0.5, M2: 0.5}
   *   M1 = [60, 60, 60, 60] -> popstd 0 -> z = [0, 0, 0, 0]
   *   M2 = [40, 30, 20, 10]
   *     mean 25; devs [15, 5, -5, -15]; sumsq 500; var 125; popstd 11.1803398875
   *     z_M2 = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   *   B contributes 0.5*0 + 0.5*z_M2
   *              = [0.6708203932, 0.2236067977, -0.2236067977, -0.6708203932]
   *
   * sum over jurors = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   * composite = sum / 2 jurors
   *           = [0.6708203932, 0.2236067977, -0.2236067977, -0.6708203932]
   */
  const jury: JurorWeights[] = [
    { role: 'A', weights: { M1: 3, M2: 1 } },
    { role: 'B', weights: { M1: 0, M2: 0 } },
  ];
  const scoreLog: ScoreLogEntry[] = [
    entry('A', IDS, { M1: [100, 75, 50, 25], M2: [25, 50, 75, 100] }),
    entry('B', IDS, { M1: [60, 60, 60, 60], M2: [40, 30, 20, 10] }),
  ];
  const EXPECTED = [0.6708203932, 0.2236067977, -0.2236067977, -0.6708203932];

  it('applies normalized weights, the uniform fallback, and divides by juror count', () => {
    const composite = computeComposite(scoreLog, jury, IDS);
    IDS.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });

  it('is unchanged when juror A rescales its weights (only the ratio matters)', () => {
    // {M1: 300, M2: 100} normalizes to the same {0.75, 0.25}.
    const rescaled: JurorWeights[] = [
      { role: 'A', weights: { M1: 300, M2: 100 } },
      { role: 'B', weights: { M1: 0, M2: 0 } },
    ];
    const composite = computeComposite(scoreLog, rescaled, IDS);
    IDS.forEach((id, index) => {
      expect(composite.get(id)).toBeCloseTo(EXPECTED[index] as number, PRECISION);
    });
  });
});

describe('computeComposite — degenerate inputs', () => {
  it('returns an empty map for no products', () => {
    expect([...computeComposite([], [], [])]).toEqual([]);
  });

  it('gives every product a composite of 0 when the score log is empty', () => {
    const composite = computeComposite([], [{ role: 'A', weights: { M: 1 } }], IDS);
    for (const id of IDS) expect(composite.get(id)).toBe(0);
  });

  it('refuses a score log carrying a juror the jury does not define', () => {
    expect(() =>
      computeComposite([entry('ghost', IDS, { M: [1, 2, 3, 4] })], [{ role: 'A', weights: { M: 1 } }], IDS),
    ).toThrow(/juror role "ghost"/);
  });

  it('refuses duplicate product ids', () => {
    expect(() => computeComposite([], [], [0, 1, 0])).toThrow(/duplicate product id 0/);
  });
});
