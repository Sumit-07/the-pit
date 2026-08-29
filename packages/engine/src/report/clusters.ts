/**
 * Clusters, scarcity, and the two places novelty touches a rank.
 *
 * `DECISIONS.md` S2 keeps `01 §6.3`'s uniqueness tilt (`UNIQ_LAMBDA`, a bounded
 * +/-0.075 on `core`) and S3 renormalizes a product with no demand entry to
 * merit-only rather than `MERIT_W x z_merit`. A product in a solo cluster gets
 * both, so the reviewer's question — is novelty credited twice, and by how much —
 * cannot be answered from either decision alone. It is answered here, by measuring
 * both effects in the same units (`core`) over a real board:
 *
 * - `tilt` — the S2 term, `UNIQ_LAMBDA x (uniqueness - UNIQ_NEUTRAL) / 50`,
 *   bounded to +/-`UNIQ_LAMBDA` by construction.
 * - `s3_gain` — the S3 term, `DEMAND_W x z_merit`, which is what a solo product
 *   gains (or loses) by being renormalized to merit alone.
 *
 * S3 is two-directional by design: a strong solo product gains `DEMAND_W x
 * z_merit` and a weak one loses exactly that much. So the test for a hidden
 * novelty bonus is not "is `s3_gain` non-zero" — it is **whether the MEAN signed
 * `s3_gain` over solo-cluster products is near zero**. A positive mean means solo
 * products are, as a group, being lifted; that is the number this module exists
 * to produce, and `mean_s3_gain_solo` is it.
 *
 * Everything is recomputed from `ranking.json` rows by the same arithmetic
 * `src/rank/blend.ts` uses, so the report cannot disagree with the board.
 */

import { DEMAND_W, MERIT_W, UNIQ_LAMBDA, UNIQ_NEUTRAL } from '../config/constants.js';
import { mean, popStd, standardize } from '../rank/stats.js';
import type { RankedProduct } from '../types.js';
import { median, quantile } from './stats.js';

/**
 * Half the 0-100 scarcity range, so `UNIQ_LAMBDA` is the full swing at either
 * end. The same structural divisor `src/rank/blend.ts` names `UNIQ_TILT_DIVISOR`,
 * repeated rather than exported because it is part of `01 §6.3`'s formula written
 * out, not a shared tunable — and a report that imported the board's private
 * constant could no longer independently check the board's arithmetic.
 */
const UNIQ_TILT_DIVISOR = 50;

/** A summary of one set of numbers, for printing. */
export interface Spread {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  /** Population std (Global Constraint 7). */
  spread: number;
}

/** Summarize a list. Empty input is all zeros with `n = 0`. */
export function summarize(values: readonly number[]): Spread {
  if (values.length === 0) {
    return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0, spread: 0 };
  }
  return {
    n: values.length,
    min: Math.min(...values),
    p25: quantile(values, 0.25),
    median: median(values),
    p75: quantile(values, 0.75),
    max: Math.max(...values),
    mean: mean(values),
    spread: popStd(values),
  };
}

/** One bar of the cluster-size histogram. */
export interface ClusterSizeBar {
  size: number;
  clusters: number;
  products: number;
}

/** How the category grouped, and who got no demand signal as a result. */
export interface ClusterReport {
  clusters: number;
  products: number;
  /** Ascending by cluster size. */
  histogram: ClusterSizeBar[];
  /** Clusters holding exactly one product. */
  solo_clusters: number;
  /** `solo_clusters / clusters`, 0 when there are none. */
  solo_cluster_fraction: number;
  /**
   * Products with no demand entry. Counted from `demand_status`, not from
   * cluster size: a cluster of two the panel never answered about also lands here
   * (`01 §6.2`), and it is the demand status, not the size, that S3 keys on.
   */
  solo_status_products: number;
  /** `solo_status_products / products`. */
  solo_status_fraction: number;
  /** Largest cluster in the category. */
  largest_cluster: number;
  /**
   * Products the uniqueness pass returned nothing for, which `rankCategory` puts
   * in the `unclustered` stand-in. Non-zero means the clustering pass dropped
   * rows, which is a different problem from a category of genuinely novel things.
   */
  unclustered_products: number;
}

/** Cluster sizes and the solo-cluster count, from the board's own rows. */
export function clusterReport(rows: readonly RankedProduct[]): ClusterReport {
  const sizes = new Map<string, number>();
  for (const row of rows) sizes.set(row.cluster.id, (sizes.get(row.cluster.id) ?? 0) + 1);

  const counts = new Map<number, ClusterSizeBar>();
  for (const size of sizes.values()) {
    const bar = counts.get(size) ?? { size, clusters: 0, products: 0 };
    bar.clusters += 1;
    bar.products += size;
    counts.set(size, bar);
  }

  const solo = [...sizes.values()].filter((size) => size === 1).length;
  const soloStatus = rows.filter((row) => row.demand_status === 'solo_cluster').length;

  return {
    clusters: sizes.size,
    products: rows.length,
    histogram: [...counts.values()].sort((a, b) => a.size - b.size),
    solo_clusters: solo,
    solo_cluster_fraction: sizes.size === 0 ? 0 : solo / sizes.size,
    solo_status_products: soloStatus,
    solo_status_fraction: rows.length === 0 ? 0 : soloStatus / rows.length,
    largest_cluster: sizes.size === 0 ? 0 : Math.max(...sizes.values()),
    unclustered_products: rows.filter((row) => row.cluster.id === 'unclustered').length,
  };
}

/**
 * The S2/S3 interaction, measured. See the module header for why the headline
 * number is `mean_s3_gain_solo` rather than any individual product's gain.
 */
export interface NoveltyReport {
  /** Scarcity of the products with no demand entry — the ones S3 renormalizes. */
  scarcity_solo: Spread;
  /** Scarcity of everybody else, for contrast. */
  scarcity_scored: Spread;
  /** The S2 tilt on solo products, in `core` units. Bounded to +/-`UNIQ_LAMBDA`. */
  tilt_solo: Spread;
  /** The S2 tilt on everybody else. */
  tilt_scored: Spread;
  /** `UNIQ_LAMBDA`: the largest tilt the formula can produce, either way. */
  max_tilt: number;
  /** Population std of `core` across the board — what the tilt is small relative to. */
  core_spread: number;
  /** `max_tilt / core_spread`: the tilt as a fraction of one population std. */
  max_tilt_as_core_spread: number;
  /**
   * Mean signed S3 gain over solo products, in `core` units. Near zero means S3
   * is the two-directional amplifier it claims to be; clearly positive means solo
   * products are being lifted as a group, on top of their tilt.
   */
  mean_s3_gain_solo: number;
  /** The same in each direction, so a near-zero mean of large opposites is visible. */
  s3_gain_solo: Spread;
  /** Products whose final rank differs from their rank with the tilt removed. */
  moved_by_tilt: number;
  /** The largest number of positions the tilt moved anybody. */
  max_positions_moved_by_tilt: number;
  /** Of `moved_by_tilt`, how many were solo-cluster products. */
  moved_by_tilt_solo: number;
}

/**
 * Measure both novelty terms and how far the tilt actually moved the board.
 *
 * The no-tilt counterfactual re-sorts by `(-core, -composite, id)` — `01 §6.4`'s
 * final sort with the `rank_key` key dropped — so the difference between the two
 * orders is attributable to the tilt and to nothing else.
 */
export function noveltyReport(rows: readonly RankedProduct[]): NoveltyReport {
  const zMerit = standardize(rows.map((row) => row.composite));
  const tiltOf = (row: RankedProduct): number =>
    (UNIQ_LAMBDA * (row.cluster.uniqueness - UNIQ_NEUTRAL)) / UNIQ_TILT_DIVISOR;

  const solo = rows.filter((row) => row.demand_status === 'solo_cluster');
  const scored = rows.filter((row) => row.demand_status === 'scored');

  const s3Gains = rows.flatMap((row, index) =>
    row.demand_status === 'solo_cluster' ? [DEMAND_W * (zMerit[index] ?? 0)] : [],
  );

  const noTiltOrder = [...rows]
    .sort((a, b) => b.core - a.core || b.composite - a.composite || a.id - b.id)
    .map((row) => row.id);
  const noTiltRank = new Map(noTiltOrder.map((id, index) => [id, index + 1]));

  let moved = 0;
  let movedSolo = 0;
  let maxPositions = 0;
  for (const row of rows) {
    const positions = Math.abs((noTiltRank.get(row.id) ?? row.rank) - row.rank);
    if (positions === 0) continue;
    moved += 1;
    if (row.demand_status === 'solo_cluster') movedSolo += 1;
    if (positions > maxPositions) maxPositions = positions;
  }

  const coreSpread = popStd(rows.map((row) => row.core));

  return {
    scarcity_solo: summarize(solo.map((row) => row.cluster.uniqueness)),
    scarcity_scored: summarize(scored.map((row) => row.cluster.uniqueness)),
    tilt_solo: summarize(solo.map(tiltOf)),
    tilt_scored: summarize(scored.map(tiltOf)),
    max_tilt: UNIQ_LAMBDA,
    core_spread: coreSpread,
    max_tilt_as_core_spread: coreSpread === 0 ? 0 : UNIQ_LAMBDA / coreSpread,
    mean_s3_gain_solo: mean(s3Gains),
    s3_gain_solo: summarize(s3Gains),
    moved_by_tilt: moved,
    max_positions_moved_by_tilt: maxPositions,
    moved_by_tilt_solo: movedSolo,
  };
}

/**
 * Whether the demand axis carries any information — and whether it is in the
 * degenerate state `01 §6.3`'s re-standardization can produce.
 *
 * `01 §6.3` standardizes `demand_raw` over the products that have an entry. With
 * exactly TWO such products, a population z of two values is always exactly
 * `-1` and `+1` whatever the votes were: one product gets `+DEMAND_W` on `core`
 * and the other `-DEMAND_W`, a fixed 0.7-wide gap manufactured out of a single
 * persona's preference. With exactly ONE, the population std is 0, so `z` is 0
 * and the demand term vanishes entirely while the product still keeps only
 * `MERIT_W` of its merit — the one case where a scored product is strictly worse
 * off than a solo one.
 *
 * Neither is fixable without departing from `01 §6.3`, so the ruling was to
 * measure whether the case is reachable in real data rather than assume it is not.
 */
export interface DemandCoverage {
  products: number;
  /** Products with a `demand_raw` entry. */
  with_demand: number;
  /** Products with none — solo clusters and clusters the panel skipped. */
  without_demand: number;
  fraction_with_demand: number;
  /** Distinct clusters at least one product with a demand entry belongs to. */
  clusters_with_demand: number;
  /** True at `with_demand === 2`: `z_demand` is exactly +/-1 regardless of votes. */
  degenerate_two: boolean;
  /** True at `with_demand === 1`: `z_demand` is 0, so demand contributes nothing. */
  degenerate_one: boolean;
  /** True at `with_demand === 0`: the Floor never convened on anybody. */
  no_demand_at_all: boolean;
  /** `demand_raw` across the products that have one. Zero spread means no signal. */
  demand_raw: Spread;
}

/** How many products received a demand entry, and whether that is enough. */
export function demandCoverage(rows: readonly RankedProduct[]): DemandCoverage {
  const scored = rows.filter((row) => row.demand_status === 'scored');
  const clusters = new Set(scored.map((row) => row.cluster.id));

  return {
    products: rows.length,
    with_demand: scored.length,
    without_demand: rows.length - scored.length,
    fraction_with_demand: rows.length === 0 ? 0 : scored.length / rows.length,
    clusters_with_demand: clusters.size,
    degenerate_two: scored.length === 2,
    degenerate_one: scored.length === 1,
    no_demand_at_all: scored.length === 0,
    demand_raw: summarize(scored.map((row) => row.demand ?? 0)),
  };
}

/** The blend weights, echoed so a reader can check the arithmetic above. */
export const BLEND_WEIGHTS = Object.freeze({
  merit: MERIT_W,
  demand: DEMAND_W,
  uniqueness_lambda: UNIQ_LAMBDA,
  uniqueness_neutral: UNIQ_NEUTRAL,
});
