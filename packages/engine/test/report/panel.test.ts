import { describe, expect, it } from 'vitest';

import {
  discriminationOverFullPanel,
  jurorCorrelations,
  jurorDeductions,
  jurorDistributions,
  panelCompleteness,
} from '../../src/report/panel.js';
import type { JurorWeights, ScoreLogEntry } from '../../src/types.js';

/**
 * The panel statistics, over a score log small enough to compute entirely by hand.
 *
 * ## The worked example every test below shares
 *
 * Three products (ids 0, 1, 2), ONE metric `M` weighted 1, two jurors:
 *
 *   Juror A  scores 10, 20, 60
 *   Juror B  scores 60, 20, 10
 *
 * Both have mean 30 and the same deviations up to a permutation, so both have the
 * same population std:
 *
 *   dA = [-20, -10, 30]   sum dA^2 = 400 + 100 + 900 = 1400
 *   popstd = sqrt(1400 / 3) = sqrt(466.6667) = 21.6024690
 *
 *   zA = [-0.9258201, -0.4629100,  1.3887301]
 *   zB = [ 1.3887301, -0.4629100, -0.9258201]
 *
 * With one metric at weight 1 and one juror in the log, `computeComposite`
 * returns exactly those z-vectors, so the per-juror composites the correlation
 * matrix reads ARE zA and zB.
 */

const METRICS = ['M'];
const PRODUCT_IDS = [0, 1, 2];

const JURY: JurorWeights[] = [
  { role: 'A', weights: { M: 1 } },
  { role: 'B', weights: { M: 1 } },
];

/** One juror's entry with the given per-product scores and matching deductions. */
function entry(role: string, scores: readonly number[]): ScoreLogEntry {
  return {
    juror_role: role,
    prompt_version: 'v1',
    scores: PRODUCT_IDS.map((id, index) => {
      const score = scores[index] ?? 0;
      return {
        id,
        metrics: [
          {
            name: 'M',
            score,
            // `01 §5.1`: deductions sum to exactly 100 - score.
            deductions: score === 100 ? [] : [{ points: 100 - score, reason: 'thin' }],
          },
        ],
      };
    }),
  };
}

const LOG: ScoreLogEntry[] = [entry('A', [10, 20, 60]), entry('B', [60, 20, 10])];

describe('panelCompleteness', () => {
  it('counts a whole panel as complete', () => {
    const result = panelCompleteness({
      scoreLog: LOG,
      jury: JURY,
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });

    // 2 jurors x 3 products x 1 metric = 6 cells, all present.
    expect(result.jurors_present).toBe(2);
    expect(result.jurors_expected).toBe(2);
    expect(result.cells_expected).toBe(6);
    expect(result.cells_present).toBe(6);
    expect(result.cells_substituted).toBe(0);
    expect(result.missing_roles).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('names a juror that is not in the score log at all', () => {
    const result = panelCompleteness({
      scoreLog: [entry('A', [10, 20, 60])],
      jury: JURY,
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });

    // The divisor `computeComposite` uses is 1, not the installed 2.
    expect(result.jurors_present).toBe(1);
    expect(result.jurors_expected).toBe(2);
    expect(result.missing_roles).toEqual(['B']);
    // Expected cells count the jurors PRESENT: 1 x 3 x 1 = 3, all filled.
    expect(result.cells_expected).toBe(3);
    expect(result.cells_present).toBe(3);
    expect(result.complete).toBe(false);
  });

  it('counts a cell the juror answered but left unscored as substituted', () => {
    const partial: ScoreLogEntry = {
      juror_role: 'B',
      prompt_version: 'v1',
      // Product 2 is missing entirely; product 1 carries no `M` row.
      scores: [
        { id: 0, metrics: [{ name: 'M', score: 60, deductions: [{ points: 40, reason: 'thin' }] }] },
        { id: 1, metrics: [] },
      ],
    };

    const result = panelCompleteness({
      scoreLog: [entry('A', [10, 20, 60]), partial],
      jury: JURY,
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });

    // 2 jurors x 3 x 1 = 6 expected. A fills 3; B fills 1 and leaves 2.
    expect(result.cells_expected).toBe(6);
    expect(result.cells_present).toBe(4);
    expect(result.cells_substituted).toBe(2);
    expect(result.complete).toBe(false);
  });

  it('flags a score log role the installed jury does not define', () => {
    const result = panelCompleteness({
      scoreLog: [entry('A', [10, 20, 60]), entry('Z', [50, 50, 50])],
      jury: JURY,
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });
    expect(result.unexpected_roles).toEqual(['Z']);
  });
});

describe('discriminationOverFullPanel', () => {
  it('is the reported value scaled by present/expected', () => {
    // A 5-of-6 run: the composites were divided by 5, so normalizing over the
    // installed 6 multiplies by 5/6. 0.6 x 5/6 = 0.5 exactly — the case that
    // decides whether `01 §6.5`'s floor is cleared.
    const completeness = {
      jurors_present: 5,
      jurors_expected: 6,
      missing_roles: ['F'],
      unexpected_roles: [],
      cells_expected: 0,
      cells_present: 0,
      cells_substituted: 0,
      complete: false,
    };
    expect(discriminationOverFullPanel(0.6, completeness)).toBeCloseTo(0.5, 12);
  });

  it('leaves a complete panel unchanged', () => {
    const completeness = {
      jurors_present: 6,
      jurors_expected: 6,
      missing_roles: [],
      unexpected_roles: [],
      cells_expected: 0,
      cells_present: 0,
      cells_substituted: 0,
      complete: true,
    };
    expect(discriminationOverFullPanel(0.42, completeness)).toBe(0.42);
  });

  it('is a 1.2x inflation on a 5-of-6 run, in the direction that flatters the panel', () => {
    // Stated the other way round: what a 5-juror run REPORTS is 6/5 = 1.2 times
    // what a full-panel normalization of the same five contributions would give.
    const completeness = {
      jurors_present: 5,
      jurors_expected: 6,
      missing_roles: [],
      unexpected_roles: [],
      cells_expected: 0,
      cells_present: 0,
      cells_substituted: 0,
      complete: false,
    };
    const reported = 0.6;
    expect(reported / discriminationOverFullPanel(reported, completeness)).toBeCloseTo(1.2, 12);
  });
});

describe('jurorDistributions', () => {
  const distributions = jurorDistributions({
    scoreLog: LOG,
    productIds: PRODUCT_IDS,
    metricNames: METRICS,
  });

  it('produces one row per juror per metric, in score-log then rubric order', () => {
    expect(distributions.map((d) => `${d.role}/${d.metric}`)).toEqual(['A/M', 'B/M']);
  });

  it('matches the hand-computed distribution for juror A', () => {
    const a = distributions[0];
    // Scores [10, 20, 60]: mean 30, popstd sqrt(1400/3) = 21.6024690.
    // median of [10, 20, 60] is the middle value, 20.
    // p25: ceil(0.25 * 3) = 1 -> index 0 -> 10.
    // p75: ceil(0.75 * 3) = 3 -> index 2 -> 60.
    expect(a?.n).toBe(3);
    expect(a?.missing).toBe(0);
    expect(a?.min).toBe(10);
    expect(a?.p25).toBe(10);
    expect(a?.median).toBe(20);
    expect(a?.p75).toBe(60);
    expect(a?.max).toBe(60);
    expect(a?.mean).toBeCloseTo(30, 12);
    expect(a?.spread).toBeCloseTo(21.6024690, 6);
  });

  it('bands the scores in fives of twenty points', () => {
    // 10 -> band 0 (0-19), 20 -> band 1 (20-39), 60 -> band 3 (60-79).
    expect(distributions[0]?.bands).toEqual([1, 1, 0, 1, 0]);
    // Juror B has the same three scores, so the same bands.
    expect(distributions[1]?.bands).toEqual([1, 1, 0, 1, 0]);
  });

  it('puts a perfect 100 in the top band rather than a sixth one', () => {
    const [only] = jurorDistributions({
      scoreLog: [entry('A', [100, 100, 100])],
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });
    expect(only?.bands).toEqual([0, 0, 0, 0, 3]);
  });

  it('counts a missing cell rather than substituting a 50 into the distribution', () => {
    // The whole point of computing over returned cells: a juror that answered
    // for one product has mean 10, not the (10 + 50 + 50)/3 = 36.7 a substituted
    // table would report.
    const [only] = jurorDistributions({
      scoreLog: [
        {
          juror_role: 'A',
          prompt_version: 'v1',
          scores: [{ id: 0, metrics: [{ name: 'M', score: 10, deductions: [{ points: 90, reason: 'x' }] }] }],
        },
      ],
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });
    expect(only?.n).toBe(1);
    expect(only?.missing).toBe(2);
    expect(only?.mean).toBe(10);
  });
});

describe('jurorDeductions', () => {
  it('totals points and counts for each juror', () => {
    const report = jurorDeductions({ scoreLog: LOG, productIds: PRODUCT_IDS, metricNames: METRICS });

    // Juror A scored 10, 20, 60 -> deductions 90 + 80 + 40 = 210, three of them.
    // Juror B scored 60, 20, 10 -> deductions 40 + 80 + 90 = 210, three of them.
    expect(report.jurors.map((juror) => [juror.role, juror.points, juror.count])).toEqual([
      ['A', 210, 3],
      ['B', 210, 3],
    ]);
    expect(report.jurors[0]?.cells_touched).toBe(3);
    expect(report.jurors[0]?.points_per_touched_cell).toBe(70); // 210 / 3
    expect(report.median_points).toBe(210);
    expect(report.threshold).toBe(105); // half the median
    expect(report.dead_weight_roles).toEqual([]);
  });

  it('flags a juror under half the panel median as dead weight', () => {
    // Totals 210, 210, 50. sorted [50, 210, 210] -> median 210 -> cut at 105.
    // 50 < 105, so C is dead weight; the other two are not.
    const report = jurorDeductions({
      scoreLog: [...LOG, entry('C', [90, 90, 90])],
      productIds: PRODUCT_IDS,
      metricNames: METRICS,
    });

    expect(report.jurors.find((juror) => juror.role === 'C')?.points).toBe(30); // 10 + 10 + 10
    expect(report.median_points).toBe(210);
    expect(report.threshold).toBe(105);
    expect(report.dead_weight_roles).toEqual(['C']);
  });

  it('finds the two dead jurors in a six-juror panel', () => {
    // Deduction totals 300, 270, 240, 210, 60, 15 by construction below.
    // sorted [15, 60, 210, 240, 270, 300] -> median (210 + 240)/2 = 225,
    // cut at 112.5. Under it: 60 and 15.
    const log = [
      entry('J1', [0, 0, 0]), // 100 x 3 = 300
      entry('J2', [10, 10, 10]), // 90 x 3 = 270
      entry('J3', [20, 20, 20]), // 80 x 3 = 240
      entry('J4', [30, 30, 30]), // 70 x 3 = 210
      entry('J5', [80, 80, 80]), // 20 x 3 = 60
      entry('J6', [95, 95, 95]), // 5 x 3 = 15
    ];
    const report = jurorDeductions({ scoreLog: log, productIds: PRODUCT_IDS, metricNames: METRICS });

    expect(report.jurors.map((juror) => juror.points)).toEqual([300, 270, 240, 210, 60, 15]);
    expect(report.median_points).toBe(225);
    expect(report.threshold).toBe(112.5);
    expect(report.dead_weight_roles).toEqual(['J5', 'J6']);
  });

  it('ignores rows for products and metrics outside the category', () => {
    const stray: ScoreLogEntry = {
      juror_role: 'A',
      prompt_version: 'v1',
      scores: [
        { id: 0, metrics: [{ name: 'M', score: 10, deductions: [{ points: 90, reason: 'x' }] }] },
        // A product no longer in the category, and a metric not in the rubric.
        { id: 99, metrics: [{ name: 'M', score: 0, deductions: [{ points: 100, reason: 'x' }] }] },
        { id: 1, metrics: [{ name: 'Gone', score: 0, deductions: [{ points: 100, reason: 'x' }] }] },
      ],
    };
    const report = jurorDeductions({ scoreLog: [stray], productIds: PRODUCT_IDS, metricNames: METRICS });
    expect(report.jurors[0]?.points).toBe(90);
  });
});

describe('jurorCorrelations', () => {
  it('correlates the per-juror composites, hand-computed', () => {
    // With one metric at weight 1 and one juror per vector, `computeComposite`
    // returns the per-metric z-score, so the vectors are zA and zB above.
    //
    //   zA = dA / s,  zB = dB / s,  s^2 = 1400/3
    //   dA = [-20, -10,  30]
    //   dB = [ 30, -10, -20]
    //
    //   sum dA*dB = (-20)(30) + (-10)(-10) + (30)(-20) = -600 + 100 - 600 = -1100
    //   sum zA*zB = -1100 / (1400/3) = -3300/1400 = -33/14
    //
    // Both vectors are z-scores, so each has mean 0 and sum of squares n = 3:
    //   r = (-33/14) / 3 = -11/14 = -0.7857142857
    const report = jurorCorrelations({ scoreLog: LOG, jury: JURY, productIds: PRODUCT_IDS });

    expect(report.roles).toEqual(['A', 'B']);
    expect(report.matrix[0]?.[0]).toBe(1);
    expect(report.matrix[1]?.[1]).toBe(1);
    expect(report.matrix[0]?.[1]).toBeCloseTo(-11 / 14, 12);
    expect(report.matrix[0]?.[1]).toBeCloseTo(-0.7857142857, 9);
    // Symmetric.
    expect(report.matrix[1]?.[0]).toBeCloseTo(report.matrix[0]?.[1] ?? 0, 12);
  });

  it('lists each unordered pair once and reports its mean', () => {
    const report = jurorCorrelations({ scoreLog: LOG, jury: JURY, productIds: PRODUCT_IDS });
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]?.a).toBe('A');
    expect(report.pairs[0]?.b).toBe('B');
    expect(report.mean_pair_correlation).toBeCloseTo(-11 / 14, 12);
    expect(report.max_pair?.r).toBeCloseTo(-11 / 14, 12);
    expect(report.flagged).toEqual([]);
  });

  it('flags two jurors who say the same thing', () => {
    // B2 gives the same ORDER as A with different numbers, so r = 1 exactly
    // while no two raw scores match. That is the case the 0.9 threshold is for:
    // two jurors who are one juror with a doubled vote.
    const jury: JurorWeights[] = [
      { role: 'A', weights: { M: 1 } },
      { role: 'B2', weights: { M: 1 } },
    ];
    const report = jurorCorrelations({
      scoreLog: [entry('A', [10, 20, 60]), entry('B2', [30, 40, 80])],
      jury,
      productIds: PRODUCT_IDS,
    });

    expect(report.matrix[0]?.[1]).toBeCloseTo(1, 12);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0]?.r).toBeCloseTo(1, 12);
  });

  it('reports a juror that scored everything alike as uncorrelated rather than NaN', () => {
    // Flat scores give popstd 0, so `standardize` returns all zeros and the
    // composite vector is constant. A NaN here would blank a matrix cell and
    // read as "no data" when the truth is the loudest possible finding.
    const jury: JurorWeights[] = [
      { role: 'A', weights: { M: 1 } },
      { role: 'FLAT', weights: { M: 1 } },
    ];
    const report = jurorCorrelations({
      scoreLog: [entry('A', [10, 20, 60]), entry('FLAT', [50, 50, 50])],
      jury,
      productIds: PRODUCT_IDS,
    });

    expect(report.matrix[0]?.[1]).toBe(0);
    expect(Number.isNaN(report.matrix[0]?.[1] ?? NaN)).toBe(false);
  });

  it('has no pairs and no max when only one juror answered', () => {
    const report = jurorCorrelations({
      scoreLog: [entry('A', [10, 20, 60])],
      jury: JURY,
      productIds: PRODUCT_IDS,
    });
    expect(report.pairs).toEqual([]);
    expect(report.max_pair).toBeUndefined();
    expect(report.mean_pair_correlation).toBe(0);
  });

  it('weights metrics the way the composite does', () => {
    // Two metrics, one juror weighted entirely onto M2 and another entirely onto
    // M1. Their composites are then z(M2) and z(M1), which here are opposite
    // orders, so r = -1. A correlation over raw score vectors would not see this.
    const jury: JurorWeights[] = [
      { role: 'M1only', weights: { M1: 1, M2: 0 } },
      { role: 'M2only', weights: { M1: 0, M2: 1 } },
    ];
    const twoMetric = (role: string, m1: readonly number[], m2: readonly number[]): ScoreLogEntry => ({
      juror_role: role,
      prompt_version: 'v1',
      scores: PRODUCT_IDS.map((id, index) => ({
        id,
        metrics: [
          { name: 'M1', score: m1[index] ?? 0, deductions: [{ points: 100 - (m1[index] ?? 0), reason: 'x' }] },
          { name: 'M2', score: m2[index] ?? 0, deductions: [{ points: 100 - (m2[index] ?? 0), reason: 'x' }] },
        ],
      })),
    });

    const report = jurorCorrelations({
      scoreLog: [
        twoMetric('M1only', [10, 20, 60], [60, 20, 10]),
        twoMetric('M2only', [10, 20, 60], [60, 20, 10]),
      ],
      jury,
      productIds: PRODUCT_IDS,
    });

    // M1only's composite is z([10, 20, 60]); M2only's is z([60, 20, 10]).
    // Those are the zA / zB vectors above, so r = -11/14, NOT -1 — the two
    // jurors saw identical raw tables and still disagree because their weights
    // point at different metrics.
    expect(report.matrix[0]?.[1]).toBeCloseTo(-11 / 14, 12);
  });
});
