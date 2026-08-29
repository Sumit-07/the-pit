/**
 * GOLDEN FIXTURE — the whole `ranking.json` document, `01 §6.6`, plus
 * `demand_status` (`DECISIONS.md` S3/S11) and the health block of `01 §6.5`.
 *
 * One end-to-end board, hand-computed from the raw rows through every stage.
 * Nothing here was produced by running the implementation.
 *
 * `rankCategory` does no I/O: it returns the object, and the orchestrator
 * serializes it. That is what makes a ranking reproducible offline -- every
 * number below is re-derivable from the stored raw rows with no model, no key
 * and no network.
 */

import { describe, expect, it } from 'vitest';

import { rankCategory } from '../../src/rank/ranking.js';
import type {
  DemandLogEntry,
  JurorWeights,
  Metric,
  Persona,
  Product,
  ScoreLogEntry,
  UniquenessResult,
} from '../../src/types.js';

const PRECISION = 9;

const PRODUCTS: Product[] = [0, 1, 2, 3].map((id) => ({
  id,
  name: `Product ${id}`,
  description: `description ${id}`,
  url: `https://p${id}.example`,
  normalized_url: `p${id}.example`,
  orig_rank: id + 1,
}));

const METRICS: Metric[] = [{ name: 'M', description: 'the only metric' }];

const JURY: JurorWeights[] = [
  { role: 'harsh', weights: { M: 1.0 } },
  { role: 'lenient', weights: { M: 1.0 } },
];

/*
 * MERIT -- the verified anchor of `01 §6.1`, reused end to end.
 *   harsh   [90, 80, 70, 60] -> mean 75, popstd sqrt(500/4) = 11.1803398875
 *   lenient [100, 90, 80, 70] -> mean 85, popstd 11.1803398875
 *   both z  = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
 *   composite = (z + z)/2 = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
 */
const SCORE_LOG: ScoreLogEntry[] = [
  {
    juror_role: 'harsh',
    prompt_version: 'jury-v1',
    scores: [
      { id: 0, metrics: [{ name: 'M', score: 90, deductions: [{ points: 10, reason: 'thin docs' }] }] },
      { id: 1, metrics: [{ name: 'M', score: 80, deductions: [{ points: 20, reason: 'no free tier' }] }] },
      { id: 2, metrics: [{ name: 'M', score: 70, deductions: [{ points: 30, reason: 'dated ui' }] }] },
      { id: 3, metrics: [{ name: 'M', score: 60, deductions: [{ points: 40, reason: 'no integrations' }] }] },
    ],
  },
  {
    juror_role: 'lenient',
    prompt_version: 'jury-v1',
    scores: [
      { id: 0, metrics: [{ name: 'M', score: 100, deductions: [] }] },
      { id: 1, metrics: [{ name: 'M', score: 90, deductions: [{ points: 10, reason: 'pricey' }] }] },
      { id: 2, metrics: [{ name: 'M', score: 80, deductions: [{ points: 20, reason: 'slow' }] }] },
      { id: 3, metrics: [{ name: 'M', score: 70, deductions: [{ points: 30, reason: 'thin' }] }] },
    ],
  },
];

/** Products 0-2 share an idea; product 3 is alone, so the Floor never convenes on it. */
const UNIQUENESS: UniquenessResult = {
  clusters: [
    { cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1, 2] },
    { cluster_id: 'c2', label: 'One of a kind', member_ids: [3] },
  ],
  products: [
    { id: 0, uniqueness_score: 50, cluster_id: 'c1', reason: 'familiar' },
    { id: 1, uniqueness_score: 50, cluster_id: 'c1', reason: 'familiar' },
    { id: 2, uniqueness_score: 50, cluster_id: 'c1', reason: 'familiar' },
    { id: 3, uniqueness_score: 90, cluster_id: 'c2', reason: 'no close analog' },
  ],
};

/*
 * DEMAND -- 2 personas over cluster c1 only.
 *   Q1: first 1, strength 100
 *   Q2: first 1, second 0, strength 80
 *
 *   votes: p0 = 0.5 (runner-up), p1 = 2.0, p2 = 0     total_votes = 2.5
 *   picked_personas = {Q1, Q2} = 2, P = 2  ->  capture = 1
 *   share:     p0 = 0.5/2.5 = 0.2   p1 = 2.0/2.5 = 0.8   p2 = 0
 *   breadth:   p0 = 0.2            p1 = 0.8             p2 = 0
 *   intensity: p0 no strength -> 0
 *              p1 top-2 of [100, 80] -> mean 90 -> 0.9
 *              p2 -> 0
 *   demand_raw p0 = 0.4*0.2 + 0.6*0   = 0.08
 *              p1 = 0.4*0.8 + 0.6*0.9 = 0.32 + 0.54 = 0.86
 *              p2 = 0
 *   product 3 has NO entry: c2 is a cluster of one (`01 §5.3`).
 */
const DEMAND_LOG: DemandLogEntry[] = [
  { persona: 'Q1', choices: [{ cluster_id: 'c1', first_pick: 1, strength: 100, reason: 'the one' }] },
  {
    persona: 'Q2',
    choices: [{ cluster_id: 'c1', first_pick: 1, second_pick: 0, strength: 80, reason: 'nearly tied' }],
  },
];

const PERSONAS: Persona[] = [
  { name: 'Q1', description: 'power user', needs: ['depth'], price_sensitivity: 'low' },
  { name: 'Q2', description: 'switcher', needs: ['price'], price_sensitivity: 'high' },
];

const ranking = rankCategory({
  category: 'Developer Tools',
  type: 'b2b',
  prompt_version: 'jury-v1',
  uniqueness_version: 'uniq-v1',
  demand_version: 'demand-v1',
  products: PRODUCTS,
  metrics: METRICS,
  jury: JURY,
  personas: PERSONAS,
  scoreLog: SCORE_LOG,
  uniqueness: UNIQUENESS,
  demandLog: DEMAND_LOG,
  flaggedInjections: [{ source: 'harsh', reason: 'ignore previous', matched: 'ignore previous' }],
});

const rowOf = (id: number) => ranking.ranking.find((row) => row.id === id);

describe('rankCategory — GOLDEN: merit', () => {
  it('carries the anchor composites', () => {
    expect(rowOf(0)?.composite).toBeCloseTo(1.3416407865, PRECISION);
    expect(rowOf(1)?.composite).toBeCloseTo(0.4472135955, PRECISION);
    expect(rowOf(2)?.composite).toBeCloseTo(-0.4472135955, PRECISION);
    expect(rowOf(3)?.composite).toBeCloseTo(-1.3416407865, PRECISION);
  });
});

describe('rankCategory — GOLDEN: demand', () => {
  it('carries demand_raw for the clustered products only', () => {
    expect(rowOf(0)?.demand).toBeCloseTo(0.08, PRECISION);
    expect(rowOf(1)?.demand).toBeCloseTo(0.86, PRECISION);
    expect(rowOf(2)?.demand).toBe(0);
    expect(rowOf(3)?.demand).toBeUndefined();
    expect(rowOf(3)?.demand_detail).toBeUndefined();
  });

  it('carries the demand_detail breakdown', () => {
    const detail = rowOf(1)?.demand_detail;
    expect(detail?.demand).toBeCloseTo(0.86, PRECISION);
    expect(detail?.breadth).toBeCloseTo(0.8, PRECISION);
    expect(detail?.intensity).toBeCloseTo(0.9, PRECISION);
    expect(detail?.capture).toBe(1);
    expect(detail?.share).toBe(0.8);
    expect(detail?.picks).toEqual([
      { persona: 'Q1', pick: 'first', strength: 100, reason: 'the one' },
      { persona: 'Q2', pick: 'first', strength: 80, reason: 'nearly tied' },
    ]);
    expect(rowOf(0)?.demand_detail?.picks).toEqual([
      { persona: 'Q2', pick: 'second', reason: 'nearly tied' },
    ]);
  });
});

describe('rankCategory — GOLDEN: core and the final order', () => {
  /*
   * z_merit = composite / popstd(composite).
   *   sumsq = 1.8 + 0.2 + 0.2 + 1.8 = 4; var = 4/4 = 1; popstd = 1 exactly,
   *   so z_merit == composite here.
   *
   * z_demand over the products that HAVE a demand entry, [0.08, 0.86, 0]:
   *   mean   = 0.94/3 = 0.3133333333
   *   devs   = [-0.2333333333, 0.5466666667, -0.3133333333]
   *   sumsq  = 0.0544444444 + 0.2988444444 + 0.0981777778 = 0.4514666667
   *   var    = 0.4514666667/3 = 0.1504888889
   *   popstd = 0.3879289740
   *   z_demand = [-0.6014846762, 1.4091926700, -0.8077079938]
   *
   * core (0.65/0.35 for the scored products, merit alone for the solo one):
   *   p0 = 0.65*1.3416407865 + 0.35*(-0.6014846762)
   *      = 0.8720665112 - 0.2105196367 =  0.6615468745
   *   p1 = 0.65*0.4472135955 + 0.35*1.4091926700
   *      = 0.2906888371 + 0.4932174345 =  0.7839062716
   *   p2 = 0.65*(-0.4472135955) + 0.35*(-0.8077079938)
   *      = -0.2906888371 - 0.2826977978 = -0.5733866349
   *   p3 = z_merit[3]                    = -1.3416407865      (DECISIONS.md S3)
   *
   * rank_key = core + 0.075*(U - 50)/50
   *   p0, p1, p2 at U = 50 -> no tilt
   *   p3 at U = 90         -> +0.075*40/50 = +0.06 -> -1.2816407865
   *
   * FINAL order by -rank_key: 1 (0.7839), 0 (0.6615), 2 (-0.5734), 3 (-1.2816)
   * MERIT order by -composite: 0, 1, 2, 3
   * -> products 0 and 1 swapped, so both are `tiebroken`; tiebreak_count = 2.
   */
  it('computes core', () => {
    expect(rowOf(0)?.core).toBeCloseTo(0.6615468745, PRECISION);
    expect(rowOf(1)?.core).toBeCloseTo(0.7839062716, PRECISION);
    expect(rowOf(2)?.core).toBeCloseTo(-0.5733866349, PRECISION);
    expect(rowOf(3)?.core).toBeCloseTo(-1.3416407865, PRECISION);
  });

  it('orders the board by rank_key and numbers ranks from 1', () => {
    expect(ranking.ranking.map((row) => row.id)).toEqual([1, 0, 2, 3]);
    expect(ranking.ranking.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
  });

  it('flags exactly the products demand and uniqueness moved off pure merit', () => {
    expect(rowOf(1)?.tiebroken).toBe(true);
    expect(rowOf(0)?.tiebroken).toBe(true);
    expect(rowOf(2)?.tiebroken).toBe(false);
    expect(rowOf(3)?.tiebroken).toBe(false);
  });

  it('sets demand_status on every row', () => {
    expect(rowOf(0)?.demand_status).toBe('scored');
    expect(rowOf(1)?.demand_status).toBe('scored');
    // p2 was in the cluster and every persona passed it over. That is a real
    // demand signal of 0, NOT a missing one -- it stays on the 0.65/0.35 blend.
    expect(rowOf(2)?.demand_status).toBe('scored');
    expect(rowOf(3)?.demand_status).toBe('solo_cluster');
  });

  it('ranks the solo product on merit alone, not on 0.65*z_merit', () => {
    expect(rowOf(3)?.core).toBeCloseTo(rowOf(3)?.composite as number, PRECISION);
    expect(rowOf(3)?.core).not.toBeCloseTo(0.65 * -1.3416407865, 6);
  });
});

describe('rankCategory — GOLDEN: scorecard, `01 §6.6`', () => {
  /*
   * Cross-juror mean and population std of the raw scores, per (product, metric).
   *   p0: {90, 100} -> mean 95, devs +/-5, popstd 5
   *   p1: {80,  90} -> mean 85, popstd 5
   *   p2: {70,  80} -> mean 75, popstd 5
   *   p3: {60,  70} -> mean 65, popstd 5
   */
  it('reports the cross-juror mean and spread per metric', () => {
    expect(rowOf(0)?.scorecard).toEqual([
      { metric: 'M', score: 95, spread: 5, deductions: [{ points: 10, reason: 'thin docs', role: 'harsh' }] },
    ]);
    expect(rowOf(3)?.scorecard[0]?.score).toBe(65);
    expect(rowOf(3)?.scorecard[0]?.spread).toBe(5);
  });

  it('tags every deduction with the juror role that took it', () => {
    expect(rowOf(1)?.scorecard[0]?.deductions).toEqual([
      { points: 20, reason: 'no free tier', role: 'harsh' },
      { points: 10, reason: 'pricey', role: 'lenient' },
    ]);
  });
});

describe('rankCategory — GOLDEN: cluster views, `01 §6.6`', () => {
  it('embeds the per-row cluster with its own uniqueness and reason', () => {
    expect(rowOf(0)?.cluster).toEqual({
      id: 'c1',
      label: 'Note takers',
      size: 3,
      uniqueness: 50,
      reason: 'familiar',
    });
    expect(rowOf(3)?.cluster).toEqual({
      id: 'c2',
      label: 'One of a kind',
      size: 1,
      uniqueness: 90,
      reason: 'no close analog',
    });
  });

  it('summarizes clusters at the top level, sorted by size', () => {
    expect(ranking.clusters).toEqual([
      { cluster_id: 'c1', label: 'Note takers', size: 3 },
      { cluster_id: 'c2', label: 'One of a kind', size: 1 },
    ]);
  });
});

describe('rankCategory — GOLDEN: health, `01 §6.5`', () => {
  /*
   * discrimination = popstd of the composites
   *   composites = [1.3416407865, 0.4472135955, -0.4472135955, -1.3416407865]
   *   mean 0; squares 1.8 + 0.2 + 0.2 + 1.8 = 4; var 4/4 = 1; popstd = 1 exactly.
   *
   * demand_discrimination = popstd of demand_raw [0.08, 0.86, 0]
   *   = 0.3879289740   (derived above)
   *
   * avg_metric_spread = mean over (product, metric) of the cross-juror popstd
   *   = mean(5, 5, 5, 5) = 5
   *
   * tiebreak_count = 2 (products 0 and 1 swapped)
   */
  it('reports the four health statistics', () => {
    expect(ranking.health.discrimination).toBeCloseTo(1, PRECISION);
    expect(ranking.health.demand_discrimination).toBeCloseTo(0.3879289740, PRECISION);
    expect(ranking.health.avg_metric_spread).toBeCloseTo(5, PRECISION);
    expect(ranking.health.tiebreak_count).toBe(2);
  });
});

describe('rankCategory — GOLDEN: document envelope, `01 §6.6`', () => {
  it('echoes the versions, type, roster and rubric', () => {
    expect(ranking.category).toBe('Developer Tools');
    expect(ranking.type).toBe('b2b');
    expect(ranking.prompt_version).toBe('jury-v1');
    expect(ranking.uniqueness_version).toBe('uniq-v1');
    expect(ranking.demand_version).toBe('demand-v1');
    expect(ranking.personas).toEqual(PERSONAS);
    expect(ranking.metrics).toEqual(METRICS);
    expect(ranking.flaggedInjections).toEqual([
      { source: 'harsh', reason: 'ignore previous', matched: 'ignore previous' },
    ]);
  });

  it('echoes the frozen blend weights', () => {
    expect(ranking.weights).toEqual({ merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 });
  });

  it('carries every product exactly once, with its name and url', () => {
    expect(ranking.ranking).toHaveLength(4);
    expect(rowOf(2)?.name).toBe('Product 2');
    expect(rowOf(2)?.url).toBe('https://p2.example');
  });

  it('is serializable as-is: the object IS ranking.json', () => {
    // Task 7 owns writing the file; this task owns the document. Round-tripping
    // it proves there is nothing in here a JSON writer would drop.
    const roundTripped = JSON.parse(JSON.stringify(ranking)) as typeof ranking;
    expect(roundTripped.ranking.map((row) => row.id)).toEqual([1, 0, 2, 3]);
    expect(roundTripped.ranking.map((row) => row.demand_status)).toEqual([
      'scored',
      'scored',
      'scored',
      'solo_cluster',
    ]);
  });
});

describe('rankCategory — degraded runs still produce a board', () => {
  const base = {
    category: 'Developer Tools',
    type: 'b2b' as const,
    prompt_version: 'jury-v1',
    uniqueness_version: '',
    demand_version: '',
    products: PRODUCTS,
    metrics: METRICS,
    jury: JURY,
    personas: [],
    scoreLog: SCORE_LOG,
  };

  it('ranks on pure merit when the uniqueness pass and the Floor never ran', () => {
    // Every product is then `solo_cluster` (S11: a delivery, not a failure) and
    // core == composite, so the board is the merit order.
    const merit = rankCategory(base);
    expect(merit.ranking.map((row) => row.id)).toEqual([0, 1, 2, 3]);
    expect(merit.ranking.every((row) => row.demand_status === 'solo_cluster')).toBe(true);
    expect(merit.health.tiebreak_count).toBe(0);
    expect(merit.health.demand_discrimination).toBe(0);
    expect(merit.clusters).toEqual([]);
  });

  it('gives an unclustered product a neutral stand-in cluster and no tilt', () => {
    const merit = rankCategory(base);
    expect(merit.ranking[0]?.cluster).toEqual({
      id: 'unclustered',
      label: '',
      size: 1,
      uniqueness: 50,
      reason: '',
    });
  });

  it('produces a flat, finite board when no juror returned anything', () => {
    const empty = rankCategory({ ...base, scoreLog: [] });
    expect(empty.ranking.map((row) => row.id)).toEqual([0, 1, 2, 3]);
    expect(empty.ranking.every((row) => row.composite === 0 && row.core === 0)).toBe(true);
    expect(empty.ranking.every((row) => row.scorecard.length === 0)).toBe(true);
    expect(empty.health).toEqual({
      avg_metric_spread: 0,
      discrimination: 0,
      demand_discrimination: 0,
      tiebreak_count: 0,
    });
  });
});
