/**
 * Turn stored raw rows back into the engine's inputs.
 *
 * This is the other half of the claim the schema is built on. `02 §7` says
 * Postgres stores the raw score log, cluster assignments and demand votes
 * "rather than only the reduced ranking" because "incremental placement and exact
 * recomputation both require the raw inputs", and `brief` Part 7 calls the score
 * log the integrity record if a ranking is disputed. Neither sentence means
 * anything unless the rows can actually be read back into the shapes
 * `rankCategory` consumes — so that conversion is code, and
 * `test/seed/round-trip.test.ts` runs it over both seeded boards and asserts the
 * result is the published board, number for number.
 *
 * Pure and database-free: it takes row objects. The same function serves a
 * `SELECT` in the recompute worker and the in-memory output of `buildSeedRows`,
 * because a stored row and a row about to be stored are the same shape.
 *
 * ## Ordering is part of the output
 *
 * `rankCategory` is order-insensitive in its arithmetic — a z-score does not care
 * which order the scores arrived in — but not in its PRESENTATION: the merged
 * scorecard lists deductions in score-log order, and the board's `metrics` array
 * fixes the row order. So the rows are sorted back into the order the panels
 * produced them: jurors in jury order, products by `engine_id`, metrics in rubric
 * order. Without that the recomputed document ranks identically and still fails a
 * byte comparison, which would make the round-trip test unable to tell a real
 * regression from a shuffled array.
 */

import type {
  DemandChoice,
  DemandLogEntry,
  Deduction,
  MetricScore,
  Product,
  ScoreLogEntry,
  ScoreRow,
  UniquenessResult,
} from '@the-pit/engine';

import type { clusterMembers, clusters, demandVotes, products, scoreRows } from '../schema/index.js';

/** The stored rows one category's recomputation reads. */
export interface StoredRows {
  products: readonly (typeof products.$inferInsert)[];
  scoreRows: readonly (typeof scoreRows.$inferInsert)[];
  clusters: readonly (typeof clusters.$inferInsert)[];
  clusterMembers: readonly (typeof clusterMembers.$inferInsert)[];
  demandVotes: readonly (typeof demandVotes.$inferInsert)[];
}

/** Everything `rankCategory` needs that is not the frozen jury or panel. */
export interface RehydratedInputs {
  products: Product[];
  scoreLog: ScoreLogEntry[];
  uniqueness: UniquenessResult;
  demandLog: DemandLogEntry[];
}

/** The presentation order to restore. Both come from the installed jury. */
export interface RehydrateOrder {
  /** `JurorMandate.role`, in jury order. */
  jurorRoles: readonly string[];
  /** `RubricMetric.name`, in rubric order. */
  metricNames: readonly string[];
}

export function rehydrate(rows: StoredRows, order: RehydrateOrder): RehydratedInputs {
  const engineIdByUuid = new Map<string, number>();
  for (const product of rows.products) {
    if (product.id === undefined) {
      throw new RangeError('rehydrate: a product row has no id; it cannot be joined to its scores');
    }
    engineIdByUuid.set(product.id, product.engineId);
  }

  const engineId = (uuid: string): number => {
    const id = engineIdByUuid.get(uuid);
    if (id === undefined) throw new RangeError(`rehydrate: no product with id ${uuid}`);
    return id;
  };

  const productList: Product[] = rows.products
    .map((row) => ({
      id: row.engineId,
      name: row.name,
      description: row.description,
      url: row.url,
      normalized_url: row.normalizedUrl,
      // `orig_rank` is the source sheet's position. It is not stored: nothing in
      // `01 §6` reads it, and `Product.id` — which every stored row keys on — is
      // already the ingest order it was derived from. Reproduced as `id + 1` so
      // the shape is total; a caller that needs the sheet's own rank must read
      // `products.json`.
      orig_rank: row.engineId + 1,
    }))
    .sort((a, b) => a.id - b.id);

  return {
    products: productList,
    scoreLog: buildScoreLog(rows.scoreRows, engineId, order),
    uniqueness: buildUniqueness(rows, engineId),
    demandLog: buildDemandLog(rows, engineId),
  };
}

// --- score log ----------------------------------------------------------------

function buildScoreLog(
  stored: readonly (typeof scoreRows.$inferInsert)[],
  engineId: (uuid: string) => number,
  order: RehydrateOrder,
): ScoreLogEntry[] {
  const metricRank = new Map(order.metricNames.map((name, index) => [name, index]));

  /** juror role -> product id -> metric name -> the stored cell. */
  const byJuror = new Map<string, Map<number, Map<string, MetricScore>>>();
  const promptVersions = new Map<string, string>();

  for (const row of stored) {
    const juror = byJuror.get(row.jurorRole) ?? new Map<number, Map<string, MetricScore>>();
    byJuror.set(row.jurorRole, juror);
    promptVersions.set(row.jurorRole, row.promptVersion);

    const id = engineId(row.productId);
    const metrics = juror.get(id) ?? new Map<string, MetricScore>();
    juror.set(id, metrics);

    metrics.set(row.metric, {
      name: row.metric,
      score: row.score,
      deductions: (row.deductions ?? []) as Deduction[],
    });
  }

  const roles = [...order.jurorRoles].filter((role) => byJuror.has(role));
  // A juror in the log but not on the installed jury still has to appear:
  // dropping it would silently rewrite the z-norm's population.
  for (const role of byJuror.keys()) if (!roles.includes(role)) roles.push(role);

  return roles.map((role) => {
    const juror = byJuror.get(role) ?? new Map<number, Map<string, MetricScore>>();
    const scores: ScoreRow[] = [...juror.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, metrics]) => ({
        id,
        metrics: [...metrics.values()].sort(
          (a, b) => (metricRank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (metricRank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
        ),
      }));

    return { juror_role: role, prompt_version: promptVersions.get(role) ?? '', scores };
  });
}

// --- clustering ---------------------------------------------------------------

function buildUniqueness(rows: StoredRows, engineId: (uuid: string) => number): UniquenessResult {
  const keyByClusterId = new Map<string, string>();
  const labelByClusterId = new Map<string, string>();
  for (const cluster of rows.clusters) {
    if (cluster.id === undefined) throw new RangeError('rehydrate: a cluster row has no id');
    keyByClusterId.set(cluster.id, cluster.clusterKey);
    labelByClusterId.set(cluster.id, cluster.label);
  }

  const members = [...rows.clusterMembers].sort((a, b) => engineId(a.productId) - engineId(b.productId));

  const memberIds = new Map<string, number[]>();
  const products: UniquenessResult['products'] = [];

  for (const member of members) {
    const key = keyByClusterId.get(member.clusterId);
    if (key === undefined) throw new RangeError(`rehydrate: no cluster with id ${member.clusterId}`);

    const id = engineId(member.productId);
    products.push({ id, uniqueness_score: member.uniquenessScore, cluster_id: key, reason: member.reason });

    const list = memberIds.get(key);
    if (list === undefined) memberIds.set(key, [id]);
    else list.push(id);
  }

  const clusterList = rows.clusters.map((cluster) => ({
    cluster_id: cluster.clusterKey,
    label: cluster.label,
    member_ids: memberIds.get(cluster.clusterKey) ?? [],
  }));

  return { clusters: clusterList, products };
}

// --- demand -------------------------------------------------------------------

/**
 * Rebuild one `DemandChoice` per (persona, cluster) from the one, two or three
 * rows it was stored as. The `none` rows are the ones that only exist because the
 * enum has a third member; see `build.ts`'s header for what is lost without them.
 */
function buildDemandLog(rows: StoredRows, engineId: (uuid: string) => number): DemandLogEntry[] {
  const keyByClusterId = new Map<string, string>();
  for (const cluster of rows.clusters) {
    if (cluster.id !== undefined) keyByClusterId.set(cluster.id, cluster.clusterKey);
  }

  /** persona -> cluster key -> the choice being assembled. */
  const byPersona = new Map<string, Map<string, DemandChoice>>();

  for (const vote of rows.demandVotes) {
    const clusterKey = keyByClusterId.get(vote.clusterId);
    if (clusterKey === undefined) throw new RangeError(`rehydrate: no cluster with id ${vote.clusterId}`);

    const clusters = byPersona.get(vote.personaName) ?? new Map<string, DemandChoice>();
    byPersona.set(vote.personaName, clusters);

    const choice = clusters.get(clusterKey) ?? { cluster_id: clusterKey, reason: vote.reason };
    clusters.set(clusterKey, choice);

    if (vote.pick === 'none') {
      choice.none = true;
      continue;
    }
    const id = vote.productId === null || vote.productId === undefined ? undefined : engineId(vote.productId);
    if (id === undefined) continue;

    if (vote.pick === 'first') {
      choice.first_pick = id;
      if (vote.strength !== null && vote.strength !== undefined) choice.strength = vote.strength;
    } else {
      choice.second_pick = id;
    }
  }

  return [...byPersona.entries()].map(([persona, clusters]) => ({
    persona,
    choices: [...clusters.values()],
  }));
}
