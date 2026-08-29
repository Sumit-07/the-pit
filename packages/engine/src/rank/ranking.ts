/**
 * Assembling the `ranking.json` document — `01 §6.6`, plus `demand_status`
 * (`DECISIONS.md` S3/S11).
 *
 * `rankCategory` performs NO I/O. It returns the `Ranking` object; the
 * orchestrator (Task 7) serializes it. Keeping this a pure function is what
 * makes a ranking reproducible offline: given the stored raw rows, anyone can
 * re-derive every number on the board without a model, a key, or a network.
 */

import { DEMAND_W, MERIT_W, UNIQ_LAMBDA, UNIQ_NEUTRAL } from '../config/constants.js';
import type {
  CategoryType,
  ClusterId,
  ClusterSummary,
  DemandLogEntry,
  FlaggedInjection,
  JurorWeights,
  Metric,
  Persona,
  Product,
  RankedProduct,
  RankedProductCluster,
  Ranking,
  ScoreLogEntry,
  UniquenessResult,
} from '../types.js';
import { blend, finalOrder, meritOrder, ranksFrom } from './blend.js';
import { computeComposite } from './composite.js';
import { clusterMembers, reduceDemand } from './demand.js';
import { juryHealth } from './health.js';
import { buildScorecards } from './scorecard.js';
import { clampScore } from './stats.js';

/**
 * Stand-in cluster for a product the uniqueness pass returned nothing for — a
 * retrofit run, or a pass that dropped a row. It is a cluster of one with no
 * label and neutral scarcity, so the product takes no uniqueness tilt and gets
 * no demand entry, exactly like a genuine solo cluster.
 */
const UNCLUSTERED_ID: ClusterId = 'unclustered';

export interface RankCategoryInput {
  category: string;
  type: CategoryType;
  /** From the installed jury. Source: `01 §4` Step 2. */
  prompt_version: string;
  /** From the uniqueness pass. Source: `01 §4` Step 5. */
  uniqueness_version: string;
  /** From the customer panel. Source: `01 §4` Step 5. */
  demand_version: string;
  /** Every usable product in the category, from ingest. */
  products: readonly Product[];
  /** The rubric, authoritative for metric names and their order. `01 §4` Step 6. */
  metrics: readonly Metric[];
  /** The installed jury, authoritative for weights. `01 §4` Step 6. */
  jury: readonly JurorWeights[];
  /** The customer panel roster, echoed into the document. */
  personas: readonly Persona[];
  scoreLog: readonly ScoreLogEntry[];
  uniqueness?: UniquenessResult | null;
  demandLog?: readonly DemandLogEntry[] | null;
  flaggedInjections?: readonly FlaggedInjection[];
}

/** Build the whole `ranking.json` document from stored raw rows. `01 §6`. */
export function rankCategory(input: RankCategoryInput): Ranking {
  const productIds = input.products.map((product) => product.id);
  const metricNames = input.metrics.map((metric) => metric.name);

  const composite = computeComposite(input.scoreLog, input.jury, productIds);
  const { demandRaw, detail } = reduceDemand(input.demandLog, input.uniqueness);

  const uniquenessById = new Map<number, number>();
  const clusterIdByProduct = new Map<number, ClusterId>();
  const reasonByProduct = new Map<number, string>();
  for (const row of input.uniqueness?.products ?? []) {
    uniquenessById.set(row.id, clampScore(row.uniqueness_score, UNIQ_NEUTRAL));
    reasonByProduct.set(row.id, row.reason);
    if (typeof row.cluster_id === 'string' && row.cluster_id !== '') {
      clusterIdByProduct.set(row.id, row.cluster_id);
    }
  }

  const members = clusterMembers(input.uniqueness);
  // The membership map is the authority on which cluster a product is in, so the
  // `member_ids` retrofit path (`01 §6.2`) reaches the board rows too.
  for (const [clusterId, memberIds] of members) {
    for (const id of memberIds) if (!clusterIdByProduct.has(id)) clusterIdByProduct.set(id, clusterId);
  }

  const labels = new Map<ClusterId, string>();
  for (const cluster of input.uniqueness?.clusters ?? []) labels.set(cluster.cluster_id, cluster.label);

  const blended = blend({ productIds, composite, demandRaw, uniqueness: uniquenessById });
  const blendedById = new Map(blended.map((row) => [row.id, row]));

  const finalRanks = ranksFrom(finalOrder(blended));
  const meritRanks = ranksFrom(meritOrder(blended));

  const scorecards = buildScorecards(input.scoreLog, metricNames, productIds);
  const productsById = new Map(input.products.map((product) => [product.id, product]));

  let tiebreakCount = 0;
  const ranking: RankedProduct[] = [...finalRanks.keys()]
    .map((id) => {
      const product = productsById.get(id);
      const row = blendedById.get(id);
      if (product === undefined || row === undefined) throw new Error(`rankCategory: lost product ${id}`);

      const rank = finalRanks.get(id) ?? 0;
      const tiebroken = (meritRanks.get(id) ?? 0) !== rank;
      if (tiebroken) tiebreakCount += 1;

      const clusterId = clusterIdByProduct.get(id);
      const cluster: RankedProductCluster =
        clusterId === undefined
          ? {
              id: UNCLUSTERED_ID,
              label: '',
              size: 1,
              uniqueness: row.uniqueness,
              reason: reasonByProduct.get(id) ?? '',
            }
          : {
              id: clusterId,
              label: labels.get(clusterId) ?? '',
              size: members.get(clusterId)?.length ?? 1,
              uniqueness: row.uniqueness,
              reason: reasonByProduct.get(id) ?? '',
            };

      const ranked: RankedProduct = {
        id,
        name: product.name,
        url: product.url,
        rank,
        composite: row.composite,
        core: row.core,
        demand_status: row.demand_status,
        tiebroken,
        scorecard: scorecards.get(id) ?? [],
        cluster,
      };
      if (row.demand !== undefined) ranked.demand = row.demand;
      const demandDetail = detail.get(id);
      if (demandDetail !== undefined) ranked.demand_detail = demandDetail;
      return ranked;
    })
    // `finalRanks` already iterates in final order; sorting on the assigned rank
    // makes the board's order a property of `rank` itself rather than of Map
    // iteration semantics.
    .sort((a, b) => a.rank - b.rank);

  const clusters: ClusterSummary[] = [...members.entries()]
    .map(([cluster_id, memberIds]) => ({
      cluster_id,
      label: labels.get(cluster_id) ?? '',
      size: memberIds.length,
    }))
    .sort((a, b) => b.size - a.size || (a.cluster_id < b.cluster_id ? -1 : a.cluster_id > b.cluster_id ? 1 : 0));

  const health = juryHealth({
    scorecards,
    composites: blended.map((row) => row.composite),
    // Exactly the population `blend` standardizes demand over, so
    // `demand_discrimination` describes the axis the board was actually ranked on.
    demandRaw: productIds.filter((id) => demandRaw.has(id)).map((id) => demandRaw.get(id) ?? 0),
    tiebreakCount,
  });

  return {
    category: input.category,
    prompt_version: input.prompt_version,
    uniqueness_version: input.uniqueness_version,
    demand_version: input.demand_version,
    type: input.type,
    weights: { merit: MERIT_W, demand: DEMAND_W, uniqueness_lambda: UNIQ_LAMBDA },
    personas: [...input.personas],
    metrics: [...input.metrics],
    clusters,
    ranking,
    health,
    flaggedInjections: [...(input.flaggedInjections ?? [])],
  };
}
