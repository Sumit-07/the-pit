/**
 * Blending merit, demand and uniqueness into `core` and `rank_key` — `01 §6.3`,
 * and the final ordering — `01 §6.4`.
 *
 * ```
 * z_merit  = standardize(composite)     # population z across ALL products
 * z_demand = standardize(demand_raw)    # population z across products WITH a demand entry
 * core     = MERIT_W * z_merit + DEMAND_W * z_demand    # products with a demand entry
 * core     = z_merit                                    # products without  (DECISIONS.md S3)
 * rank_key = core + UNIQ_LAMBDA * (uniqueness - UNIQ_NEUTRAL) / 50
 * ```
 *
 * ## The S3 correction to `01 §6.3`
 *
 * `01 §6.3` substitutes `z_demand = 0` for a product with no demand signal, so
 * `core = 0.65 * z_merit`. `DECISIONS.md` S3 supersedes that: renormalize the
 * weights per product instead, giving merit the full 1.0.
 *
 * Why it matters. A z of 0 is not "no opinion", it is *exactly average*. Under
 * the old rule a genuinely novel product — one with no cluster peers, so no
 * panel to convene on it (`01 §5.3`) — was handed an average demand score and
 * pulled toward mid-board precisely for being original, while its merit was
 * simultaneously discounted to 65%.
 *
 * Why it is not a novelty bonus. Renormalizing amplifies merit in BOTH
 * directions: a strong solo product gains `0.35 * z_merit`, and a weak one loses
 * exactly the same. Nothing about writing an idiosyncratic description improves
 * expected rank, which is what Global Constraint 3 requires. If solo products
 * came out uniformly better off, this would be wrong.
 *
 * ## Why z_demand standardizes over the scored products only
 *
 * The population for `z_demand` is the products that HAVE a demand entry. That
 * is what makes `01 §6.3`'s own claim true — that a missing demand signal
 * "neither gains nor loses on the demand axis" — since 0 is then the mean of the
 * distribution. Padding the population with pseudo-zeros for unscored products
 * would drag its mean down and turn every real 0 into a penalty.
 */

import {
  DEMAND_W,
  MERIT_W,
  UNIQ_LAMBDA,
  UNIQ_NEUTRAL,
} from '../config/constants.js';
import type { DemandStatus } from '../types.js';
import { clampScore, standardize } from './stats.js';

/**
 * Half the 0-100 uniqueness range. `01 §6.3` writes the tilt literally as
 * `0.075 * (U - 50) / 50`; this divisor is what maps U in [0, 100] onto
 * [-1, +1] so `UNIQ_LAMBDA` is the full swing at either end. Structural to the
 * formula, not a tunable weight, so it is not in the frozen constants table.
 */
const UNIQ_TILT_DIVISOR = 50;

/** One product's blended position, before ordering. */
export interface BlendedProduct {
  id: number;
  /** Pure merit composite, straight from `01 §6.1`. */
  composite: number;
  /** Population z of `composite` across every product in the category. */
  z_merit: number;
  /** `demand_raw`, absent when the panel never convened on this product's cluster. */
  demand?: number;
  /** Population z of `demand_raw` across the products that have one; absent likewise. */
  z_demand?: number;
  /** Scarcity 0-100, `UNIQ_NEUTRAL` when the uniqueness pass returned nothing. */
  uniqueness: number;
  /** The blended merit + demand score, before the uniqueness tilt. */
  core: number;
  /** `core` plus the bounded uniqueness tilt; the value the board sorts on. */
  rank_key: number;
  demand_status: DemandStatus;
}

export interface BlendInput {
  productIds: readonly number[];
  /** Merit composites from `computeComposite`. */
  composite: ReadonlyMap<number, number>;
  /** `demand_raw` from `reduceDemand`. Absence, not zero, means "no signal". */
  demandRaw: ReadonlyMap<number, number>;
  /** Raw 0-100 scarcity per product; a missing id assumes `UNIQ_NEUTRAL` (no tilt). */
  uniqueness: ReadonlyMap<number, number>;
}

/** `01 §6.3` + `DECISIONS.md` S3. Returns one row per id, in `productIds` order. */
export function blend(input: BlendInput): BlendedProduct[] {
  const { productIds, composite, demandRaw, uniqueness } = input;

  const composites = productIds.map((id) => composite.get(id) ?? 0);
  const zMerit = standardize(composites);

  const scoredIds = productIds.filter((id) => demandRaw.has(id));
  const zDemandValues = standardize(scoredIds.map((id) => demandRaw.get(id) ?? 0));
  const zDemand = new Map<number, number>();
  scoredIds.forEach((id, index) => zDemand.set(id, zDemandValues[index] ?? 0));

  return productIds.map((id, index) => {
    const merit = zMerit[index] ?? 0;
    const scarcity = clampScore(uniqueness.get(id), UNIQ_NEUTRAL);
    const hasDemand = demandRaw.has(id);

    // DECISIONS.md S3: no demand entry -> merit alone at full weight, NOT
    // `MERIT_W * z_merit + DEMAND_W * 0`.
    const core = hasDemand
      ? MERIT_W * merit + DEMAND_W * (zDemand.get(id) ?? 0)
      : merit;

    const row: BlendedProduct = {
      id,
      composite: composites[index] ?? 0,
      z_merit: merit,
      uniqueness: scarcity,
      core,
      rank_key: core + (UNIQ_LAMBDA * (scarcity - UNIQ_NEUTRAL)) / UNIQ_TILT_DIVISOR,
      demand_status: hasDemand ? 'scored' : 'solo_cluster',
    };
    if (hasDemand) {
      row.demand = demandRaw.get(id) ?? 0;
      row.z_demand = zDemand.get(id) ?? 0;
    }
    return row;
  });
}

/**
 * `01 §6.4` final order: sort ids by `(-rank_key, -core, -composite, id)`.
 * The trailing `id` makes the order total, so a run is reproducible offline and
 * defensible if a paying customer disputes their placement.
 */
export function finalOrder(rows: readonly BlendedProduct[]): number[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.rank_key - a.rank_key ||
        b.core - a.core ||
        b.composite - a.composite ||
        a.id - b.id,
    )
    .map((row) => row.id);
}

/** `01 §6.4` pure-merit order: sort ids by `(-composite, id)`. */
export function meritOrder(rows: readonly BlendedProduct[]): number[] {
  return [...rows].sort((a, b) => b.composite - a.composite || a.id - b.id).map((row) => row.id);
}

/** 1-based rank per id from an ordered id list. */
export function ranksFrom(order: readonly number[]): Map<number, number> {
  return new Map(order.map((id, index) => [id, index + 1]));
}
