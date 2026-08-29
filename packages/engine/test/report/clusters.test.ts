import { describe, expect, it } from 'vitest';

import { DEMAND_W, UNIQ_LAMBDA } from '../../src/config/constants.js';
import { clusterReport, demandCoverage, noveltyReport, summarize } from '../../src/report/clusters.js';
import type { DemandStatus, RankedProduct } from '../../src/types.js';

/**
 * Clusters, scarcity, and the S2/S3 interaction, over a four-product board small
 * enough to compute by hand.
 *
 * The shared board:
 *
 *   id  composite  core   status        cluster  size  uniqueness  rank
 *    0     2.0     1.0    scored        cA        2       100        1
 *    1     1.0     0.5    scored        cA        2        50        2
 *    2     0.0     0.0    solo_cluster  cB        1        20        3
 *    3    -1.0    -0.5    solo_cluster  cC        1        80        4
 *
 * z_merit = standardize([2, 1, 0, -1]):
 *   mean 0.5, deviations [1.5, 0.5, -0.5, -1.5]
 *   popstd = sqrt((2.25 + 0.25 + 0.25 + 2.25) / 4) = sqrt(1.25) = 1.1180340
 *   z_merit = [1.3416408, 0.4472136, -0.4472136, -1.3416408]
 *
 * tilt = UNIQ_LAMBDA * (uniqueness - 50) / 50 = 0.075 * (u - 50) / 50:
 *   u=100 -> +0.075   u=50 -> 0   u=20 -> -0.045   u=80 -> +0.045
 */

interface RowSpec {
  id: number;
  composite: number;
  core: number;
  status: DemandStatus;
  cluster: string;
  size: number;
  uniqueness: number;
  rank: number;
  demand?: number;
}

function row(spec: RowSpec): RankedProduct {
  const ranked: RankedProduct = {
    id: spec.id,
    name: `P${spec.id}`,
    url: `https://example.com/${spec.id}`,
    rank: spec.rank,
    composite: spec.composite,
    demand_status: spec.status,
    core: spec.core,
    tiebroken: false,
    scorecard: [],
    cluster: { id: spec.cluster, label: spec.cluster, size: spec.size, uniqueness: spec.uniqueness, reason: '' },
  };
  if (spec.demand !== undefined) ranked.demand = spec.demand;
  return ranked;
}

const BOARD: RankedProduct[] = [
  row({ id: 0, composite: 2, core: 1.0, status: 'scored', cluster: 'cA', size: 2, uniqueness: 100, rank: 1, demand: 0.6 }),
  row({ id: 1, composite: 1, core: 0.5, status: 'scored', cluster: 'cA', size: 2, uniqueness: 50, rank: 2, demand: 0.2 }),
  row({ id: 2, composite: 0, core: 0.0, status: 'solo_cluster', cluster: 'cB', size: 1, uniqueness: 20, rank: 3 }),
  row({ id: 3, composite: -1, core: -0.5, status: 'solo_cluster', cluster: 'cC', size: 1, uniqueness: 80, rank: 4 }),
];

describe('summarize', () => {
  it('is all zeros with n = 0 for an empty list', () => {
    expect(summarize([])).toEqual({ n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0, spread: 0 });
  });

  it('matches a hand-computed spread', () => {
    // [10, 20, 30, 40]: mean 25; deviations [-15, -5, 5, 15];
    // sum sq = 225 + 25 + 25 + 225 = 500; /4 = 125; sqrt = 11.1803399.
    // median = (20 + 30)/2 = 25. p25 = index ceil(1)-1 = 0 -> 10.
    // p75 = index ceil(3)-1 = 2 -> 30.
    expect(summarize([40, 10, 30, 20])).toEqual({
      n: 4,
      min: 10,
      p25: 10,
      median: 25,
      p75: 30,
      max: 40,
      mean: 25,
      spread: Math.sqrt(125),
    });
  });
});

describe('clusterReport', () => {
  const report = clusterReport(BOARD);

  it('counts clusters and products from the board rows', () => {
    // cA holds 2, cB holds 1, cC holds 1.
    expect(report.clusters).toBe(3);
    expect(report.products).toBe(4);
    expect(report.largest_cluster).toBe(2);
  });

  it('builds the size histogram ascending', () => {
    // Two clusters of size 1 (2 products), one of size 2 (2 products).
    expect(report.histogram).toEqual([
      { size: 1, clusters: 2, products: 2 },
      { size: 2, clusters: 1, products: 2 },
    ]);
  });

  it('reports the solo-cluster count and percentage', () => {
    expect(report.solo_clusters).toBe(2);
    expect(report.solo_cluster_fraction).toBeCloseTo(2 / 3, 12); // 2 of 3 clusters
    expect(report.solo_status_products).toBe(2);
    expect(report.solo_status_fraction).toBe(0.5); // 2 of 4 products
  });

  it('counts products with no demand entry by STATUS, not by cluster size', () => {
    // A two-member cluster the panel never answered about also has no demand
    // entry (`01 §6.2`), and S3 keys on the entry, not on the size. Here both
    // members of a size-2 cluster carry `solo_cluster`.
    const skipped = clusterReport([
      row({ id: 0, composite: 1, core: 1, status: 'solo_cluster', cluster: 'cA', size: 2, uniqueness: 50, rank: 1 }),
      row({ id: 1, composite: 0, core: 0, status: 'solo_cluster', cluster: 'cA', size: 2, uniqueness: 50, rank: 2 }),
    ]);
    expect(skipped.solo_clusters).toBe(0); // no cluster has one member
    expect(skipped.solo_status_products).toBe(2); // but nobody has a demand entry
  });

  it('counts rows the uniqueness pass returned nothing for', () => {
    const dropped = clusterReport([
      row({ id: 0, composite: 1, core: 1, status: 'solo_cluster', cluster: 'unclustered', size: 1, uniqueness: 50, rank: 1 }),
      ...BOARD,
    ]);
    expect(dropped.unclustered_products).toBe(1);
  });

  it('handles an empty board without dividing by zero', () => {
    const empty = clusterReport([]);
    expect(empty.clusters).toBe(0);
    expect(empty.solo_cluster_fraction).toBe(0);
    expect(empty.solo_status_fraction).toBe(0);
  });
});

describe('noveltyReport — the S2/S3 interaction', () => {
  const report = noveltyReport(BOARD);

  it('reports the scarcity distribution of solo-status products specifically', () => {
    // Solo: uniqueness 20 and 80 -> mean 50, popstd 30.
    expect(report.scarcity_solo.n).toBe(2);
    expect(report.scarcity_solo.min).toBe(20);
    expect(report.scarcity_solo.max).toBe(80);
    expect(report.scarcity_solo.mean).toBe(50);
    expect(report.scarcity_solo.spread).toBe(30);

    // Scored: 100 and 50 -> mean 75, popstd 25.
    expect(report.scarcity_scored.mean).toBe(75);
    expect(report.scarcity_scored.spread).toBe(25);
  });

  it('computes the S2 tilt as 0.075 * (u - 50) / 50', () => {
    // Solo: u=20 -> 0.075 * (-30)/50 = -0.045 ; u=80 -> 0.075 * 30/50 = +0.045
    expect(report.tilt_solo.min).toBeCloseTo(-0.045, 12);
    expect(report.tilt_solo.max).toBeCloseTo(0.045, 12);
    expect(report.tilt_solo.mean).toBeCloseTo(0, 12);

    // Scored: u=100 -> +0.075 ; u=50 -> 0 ; mean 0.0375
    expect(report.tilt_scored.max).toBeCloseTo(0.075, 12);
    expect(report.tilt_scored.mean).toBeCloseTo(0.0375, 12);
  });

  it('bounds the tilt at UNIQ_LAMBDA and states it as a fraction of one core std', () => {
    // popstd(core over [1.0, 0.5, 0.0, -0.5]): mean 0.25,
    // deviations [0.75, 0.25, -0.25, -0.75], sum sq = 1.25, /4 = 0.3125,
    // sqrt = 0.5590170.
    expect(report.max_tilt).toBe(UNIQ_LAMBDA);
    expect(report.core_spread).toBeCloseTo(0.5590170, 6);
    // 0.075 / 0.5590170 = 0.1341641
    expect(report.max_tilt_as_core_spread).toBeCloseTo(0.1341641, 6);
  });

  it('measures the S3 gain as DEMAND_W x z_merit over solo products', () => {
    // z_merit for ids 2 and 3 is -0.4472136 and -1.3416408.
    //   0.35 * -0.4472136 = -0.15652476
    //   0.35 * -1.3416408 = -0.46957428
    //   mean = -0.31304952
    expect(report.s3_gain_solo.n).toBe(2);
    expect(report.s3_gain_solo.max).toBeCloseTo(DEMAND_W * -0.4472136, 6);
    expect(report.s3_gain_solo.min).toBeCloseTo(DEMAND_W * -1.3416408, 6);
    expect(report.mean_s3_gain_solo).toBeCloseTo(-0.31304952, 7);
  });

  it('reports a mean S3 gain of ~0 when solo products sit either side of the mean', () => {
    // The two-directional property, stated as a test. Solo products at z_merit
    // +1.3416408 and -1.3416408 give gains +0.46957 and -0.46957, mean 0 — so
    // "novelty credited twice" is FALSE even though each individual gain is large.
    const balanced: RankedProduct[] = [
      row({ id: 0, composite: 2, core: 1, status: 'solo_cluster', cluster: 'a', size: 1, uniqueness: 50, rank: 1 }),
      row({ id: 1, composite: 1, core: 0.5, status: 'scored', cluster: 'b', size: 2, uniqueness: 50, rank: 2, demand: 0.5 }),
      row({ id: 2, composite: 0, core: 0, status: 'scored', cluster: 'b', size: 2, uniqueness: 50, rank: 3, demand: 0.1 }),
      row({ id: 3, composite: -1, core: -0.5, status: 'solo_cluster', cluster: 'c', size: 1, uniqueness: 50, rank: 4 }),
    ];
    expect(noveltyReport(balanced).mean_s3_gain_solo).toBeCloseTo(0, 12);
  });

  it('finds no movement when the tilt does not reorder the board', () => {
    // The shared board's `core` order already matches its `rank` order.
    expect(report.moved_by_tilt).toBe(0);
    expect(report.max_positions_moved_by_tilt).toBe(0);
  });

  it('counts the products the tilt actually moved, and how far', () => {
    // core 0.50 with u=100 -> rank_key 0.575  (ranked 1st)
    // core 0.52 with u=0   -> rank_key 0.445  (ranked 2nd)
    // Without the tilt, 0.52 would be first. Two rows swap, one position each.
    const swapped: RankedProduct[] = [
      row({ id: 1, composite: 1, core: 0.5, status: 'solo_cluster', cluster: 'b', size: 1, uniqueness: 100, rank: 1 }),
      row({ id: 0, composite: 2, core: 0.52, status: 'solo_cluster', cluster: 'a', size: 1, uniqueness: 0, rank: 2 }),
    ];
    const moved = noveltyReport(swapped);
    expect(moved.moved_by_tilt).toBe(2);
    expect(moved.max_positions_moved_by_tilt).toBe(1);
    expect(moved.moved_by_tilt_solo).toBe(2);
  });
});

describe('demandCoverage', () => {
  it('counts the products that received a demand entry', () => {
    const coverage = demandCoverage(BOARD);
    expect(coverage.products).toBe(4);
    expect(coverage.with_demand).toBe(2);
    expect(coverage.without_demand).toBe(2);
    expect(coverage.fraction_with_demand).toBe(0.5);
    expect(coverage.clusters_with_demand).toBe(1); // both scored rows are in cA
  });

  it('summarizes demand_raw over the products that have one', () => {
    // [0.6, 0.2]: mean 0.4, popstd 0.2, median (0.2 + 0.6)/2 = 0.4.
    const coverage = demandCoverage(BOARD);
    expect(coverage.demand_raw.n).toBe(2);
    expect(coverage.demand_raw.mean).toBeCloseTo(0.4, 12);
    expect(coverage.demand_raw.spread).toBeCloseTo(0.2, 12);
  });

  it('flags EXACTLY TWO products with demand as the degenerate case', () => {
    // `01 §6.3` re-standardizes demand over the products that have an entry, so
    // a population of two always standardizes to exactly -1 and +1: demand then
    // contributes a fixed +/-DEMAND_W to core whatever the personas said.
    expect(demandCoverage(BOARD).degenerate_two).toBe(true);
    expect(demandCoverage(BOARD).degenerate_one).toBe(false);
    expect(demandCoverage(BOARD).no_demand_at_all).toBe(false);
  });

  it('flags exactly one product with demand, where the term vanishes entirely', () => {
    const one = demandCoverage([
      row({ id: 0, composite: 1, core: 1, status: 'scored', cluster: 'a', size: 2, uniqueness: 50, rank: 1, demand: 0.5 }),
      row({ id: 1, composite: 0, core: 0, status: 'solo_cluster', cluster: 'b', size: 1, uniqueness: 50, rank: 2 }),
    ]);
    expect(one.degenerate_one).toBe(true);
    expect(one.degenerate_two).toBe(false);
    // Population std of a single value is 0, so z_demand is 0 for that product.
    expect(one.demand_raw.spread).toBe(0);
  });

  it('flags a board where the Floor never convened at all', () => {
    const none = demandCoverage([
      row({ id: 0, composite: 1, core: 1, status: 'solo_cluster', cluster: 'a', size: 1, uniqueness: 50, rank: 1 }),
    ]);
    expect(none.no_demand_at_all).toBe(true);
    expect(none.with_demand).toBe(0);
  });

  it('does not flag a healthy demand population', () => {
    const healthy = demandCoverage([
      ...BOARD,
      row({ id: 4, composite: 0.5, core: 0.3, status: 'scored', cluster: 'cD', size: 2, uniqueness: 50, rank: 5, demand: 0.4 }),
      row({ id: 5, composite: 0.4, core: 0.2, status: 'scored', cluster: 'cD', size: 2, uniqueness: 50, rank: 6, demand: 0.3 }),
    ]);
    expect(healthy.with_demand).toBe(4);
    expect(healthy.degenerate_two).toBe(false);
    expect(healthy.clusters_with_demand).toBe(2);
  });
});
