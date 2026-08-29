/**
 * Demand reduction — `01 §6.2` (`reduce_demand`, `rank_final.py:129`).
 *
 * The customer panel returns forced choices, never scores and never ranks
 * (Global Constraint 1). This module turns those choices into one 0-1 number per
 * product:
 *
 * ```
 * total_votes = sum of votes over members
 * capture     = |picked_personas| / P        # P = personas that returned choices
 * share       = votes[pid] / total_votes     # 0 if total_votes == 0
 * breadth     = share * capture
 * intensity   = mean(top-2 of strengths[pid]) / 100
 * demand_raw  = BREADTH_W * breadth + INTENSITY_W * intensity
 * ```
 *
 * The blend is intensity-leaning by design (0.6 vs 0.4): a niche favourite one
 * or two personas love strongly still climbs without broad capture.
 */

import {
  BREADTH_W,
  FIRST_PICK_W,
  INTENSITY_W,
  SECOND_PICK_W,
  STRENGTH_DEFAULT,
  TOP_STRENGTHS,
} from '../config/constants.js';
import type { ClusterId, DemandDetail, DemandLogEntry, DemandPick, UniquenessResult } from '../types.js';
import { RAW_SCORE_MAX, clampScore, mean } from './stats.js';

/** `01 §6.2` output: `demand_raw` per product, and the per-product `detail`. */
export interface DemandReduction {
  /**
   * `demand_raw` keyed by product id. A product is ABSENT from this map, not
   * zero, when the customer panel never convened on its cluster. `blend` keys
   * the `DECISIONS.md` S3 merit-only renormalization on exactly that absence, so
   * the difference between "absent" and "0" is load-bearing.
   */
  demandRaw: Map<number, number>;
  /** The `{demand, breadth, intensity, capture, share, picks}` breakdown per product. */
  detail: Map<number, DemandDetail>;
}

/**
 * Cluster membership as `01 §6.2` resolves it: from `uniqueness.products[].cluster_id`,
 * else from `uniqueness.clusters[].member_ids`.
 *
 * The fallback is PER PRODUCT, not all-or-nothing. `members_ids` fills in only
 * the products the per-product field did not place, so a model-generated result
 * that sets `cluster_id` on some rows and lists the rest only in `member_ids`
 * still puts every product in its cluster.
 *
 * Resolving it as a whole-map switch instead — take `products[]` if it placed
 * anything at all, otherwise `member_ids` — would silently drop the unplaced
 * products out of their cluster. They would then get no `demand_raw` entry, so
 * `blend` would rank them merit-only and label them `solo_cluster` when the
 * Floor had in fact convened on their cluster, their peers' `cluster.size` would
 * under-count, and the `ranking.clusters` roster would be wrong. All without an
 * error.
 *
 * The per-product field wins on a conflict because it is the one the uniqueness
 * pass writes per row; `member_ids` is also the retrofit path for a run
 * clustered before that field existed (`01 §4` Step 5).
 */
export function clusterMembers(
  uniqueness: UniquenessResult | null | undefined,
): Map<ClusterId, number[]> {
  const members = new Map<ClusterId, number[]>();
  if (!uniqueness) return members;

  // A product belongs to exactly one cluster. `placed` enforces that across both
  // sources, so it is also the duplicate guard within a single `member_ids` list.
  const placed = new Set<number>();
  const add = (clusterId: ClusterId, productId: number): void => {
    if (placed.has(productId)) return;
    placed.add(productId);
    const list = members.get(clusterId);
    if (list === undefined) members.set(clusterId, [productId]);
    else list.push(productId);
  };

  for (const product of uniqueness.products ?? []) {
    if (typeof product.cluster_id !== 'string' || product.cluster_id === '') continue;
    add(product.cluster_id, product.id);
  }

  for (const cluster of uniqueness.clusters ?? []) {
    for (const id of cluster.member_ids ?? []) add(cluster.cluster_id, id);
  }
  return members;
}

/**
 * Reduce the customer panel's forced choices to `demand_raw` + `detail`.
 *
 * No demand log or no clusters returns empty maps — `01 §6.2` calls this
 * "graceful: no signal", and every product then ranks on merit alone at full
 * weight (`DECISIONS.md` S3).
 *
 * A cluster the panel returned NO choices for is skipped entirely, so its
 * members get no `demand_raw` entry. That is the solo-cluster case: `01 §5.3`
 * only convenes the panel on clusters with >= 2 members, so a cluster of one is
 * never asked about. It is deliberately different from a cluster where every
 * persona answered `none` — there the panel DID convene and found nobody wanted
 * anything, which is a real signal of 0 and does produce entries.
 */
export function reduceDemand(
  demandLog: readonly DemandLogEntry[] | null | undefined,
  uniqueness: UniquenessResult | null | undefined,
): DemandReduction {
  const demandRaw = new Map<number, number>();
  const detail = new Map<number, DemandDetail>();
  if (!demandLog || demandLog.length === 0) return { demandRaw, detail };

  const members = clusterMembers(uniqueness);
  if (members.size === 0) return { demandRaw, detail };

  const personaCount = demandLog.length;

  for (const [clusterId, memberIds] of members) {
    if (memberIds.length === 0) continue;
    const memberSet = new Set(memberIds);

    const votes = new Map<number, number>();
    const strengths = new Map<number, number[]>();
    const picks = new Map<number, DemandPick[]>();
    const pickedPersonas = new Set<string>();
    let choicesForCluster = 0;

    for (const entry of demandLog) {
      for (const choice of entry.choices ?? []) {
        if (choice.cluster_id !== clusterId) continue;
        choicesForCluster += 1;
        if (choice.none === true) continue;

        const first = choice.first_pick;
        if (typeof first !== 'number' || !memberSet.has(first)) continue;

        votes.set(first, (votes.get(first) ?? 0) + FIRST_PICK_W);

        const strength = clampScore(choice.strength, STRENGTH_DEFAULT);
        const firstStrengths = strengths.get(first);
        if (firstStrengths === undefined) strengths.set(first, [strength]);
        else firstStrengths.push(strength);

        addPick(picks, first, {
          persona: entry.persona,
          pick: 'first',
          strength,
          reason: choice.reason,
        });

        const second = choice.second_pick;
        // `second === first` would hand one persona 1.5 votes for one product.
        // `01 §5.3` asks for a runner-up, so a repeat of the first pick is a
        // malformed answer, not a stronger one.
        if (typeof second === 'number' && second !== first && memberSet.has(second)) {
          votes.set(second, (votes.get(second) ?? 0) + SECOND_PICK_W);
          // No strength is recorded for a runner-up: `01 §6.2` appends the
          // persona's conviction only to its FIRST pick, so intensity stays a
          // measure of what a buyer actually chose.
          addPick(picks, second, { persona: entry.persona, pick: 'second', reason: choice.reason });
        }

        pickedPersonas.add(entry.persona);
      }
    }

    if (choicesForCluster === 0) continue;

    let totalVotes = 0;
    for (const id of memberIds) totalVotes += votes.get(id) ?? 0;
    const capture = pickedPersonas.size / personaCount;

    for (const id of memberIds) {
      const share = totalVotes > 0 ? (votes.get(id) ?? 0) / totalVotes : 0;
      const breadth = share * capture;
      const top = [...(strengths.get(id) ?? [])].sort((a, b) => b - a).slice(0, TOP_STRENGTHS);
      const intensity = top.length === 0 ? 0 : mean(top) / RAW_SCORE_MAX;
      const demand = BREADTH_W * breadth + INTENSITY_W * intensity;

      demandRaw.set(id, demand);
      detail.set(id, { demand, breadth, intensity, capture, share, picks: picks.get(id) ?? [] });
    }
  }

  return { demandRaw, detail };
}

function addPick(picks: Map<number, DemandPick[]>, id: number, pick: DemandPick): void {
  const list = picks.get(id);
  if (list === undefined) picks.set(id, [pick]);
  else list.push(pick);
}
