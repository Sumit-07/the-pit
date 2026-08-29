/**
 * Phase "Placement" — putting ONE new product into a category that is already
 * clustered. `brief §1.5`, and the second of `runIncremental`'s four steps.
 *
 * ## Why this is the Uniqueness phase and not a fourth one
 *
 * It is a different CALL from `01 §5.2`'s clustering pass — `buildAssignRequest`
 * places one product against a FIXED roster instead of deriving a roster — but it
 * is the same phase of the graph. It is what produces this run's cluster
 * assignment, it is what the Customer phase waits on, and it lands in the same
 * `results.meta.phases.uniqueness` slot. So it reports `phase: 'uniqueness'` and
 * returns the same three-armed `PhaseResult` every other phase returns. Giving it
 * a fourth `PhaseName` would fork every consumer of that record — the ledger, the
 * status page, the resume gate — for no gain.
 *
 * ## Append-only, enforced in three places
 *
 * `brief §1.5`: "Demand votes are keyed to `cluster_id`. Re-clustering
 * invalidates every stored vote. Clusters are **append-only**." That rule is kept
 * by the prompt (the schema can only answer "this existing id" or "one new
 * label"), by `validateAssignResult` (an invented id is a schema failure), and by
 * `mergePlacement` below, which copies every existing cluster through untouched
 * and only ever appends. Full re-clustering is an explicit admin operation that
 * clears demand, and nothing on this path can perform one by accident.
 *
 * ## One step per phase
 *
 * This phase makes exactly one model call, so `brief` Part 7's "each phase is one
 * step" is trivially satisfied here — but the three functions beside it are the
 * reason the module is exported at all. A durable executor running the placement
 * as separate steps needs to merge the roster and decide whether the Floor
 * reconvenes BETWEEN steps, and the only alternative to exporting these is for it
 * to restate `brief §1.5` in its own code, where the append-only rule would then
 * exist twice.
 */

import { SANITIZE_LIMIT } from '../../config/constants.js';
import { sanitize } from '../../ingest/sanitize.js';
import type { ModelClient } from '../../model/types.js';
import { buildAssignRequest, validateAssignResult } from '../../panels/prompts/assign.js';
import type { Cluster, ClusterId, Product, UniquenessProduct, UniquenessResult } from '../../types.js';
import { dispatch } from '../dispatch.js';
import { PhaseLedger, zeroCost } from '../ledger.js';
import type { CustomerPhaseValue, PhaseResult } from '../types.js';

/** What one placement call needs. */
export interface PlacementPhaseInput {
  client: ModelClient;
  /** The product being placed. Its `id` must not already exist in the category. */
  product: Product;
  /** The category as it stands, for resolving the cluster members' names. */
  products: readonly Product[];
  /**
   * The clusters this product is placed against — the category's stored roster.
   * FIXED: nothing on this path may rename, merge, split or re-derive one.
   */
  clusters: readonly Cluster[];
}

/** A resolved placement: which cluster, whether it is new, and the scarcity row. */
export interface Placement {
  cluster_id: ClusterId;
  isNew: boolean;
  label: string;
  uniqueness_score: number;
  reason: string;
}

/**
 * Place one new product against the roster that already exists.
 * `src/panels/prompts/assign.ts`, dispatched exactly like every other phase.
 */
export async function runPlacementPhase(input: PlacementPhaseInput): Promise<PhaseResult<Placement>> {
  const ledger = new PhaseLedger();
  const existingIds = new Set(input.clusters.map((cluster) => cluster.cluster_id));

  const result = await dispatch(
    input.client,
    buildAssignRequest({ product: input.product, clusters: input.clusters, products: input.products }),
    `placement of product ${input.product.id}`,
    ledger,
    (output) => validateAssignResult(output, existingIds),
  );

  const cost = ledger.total();
  if (!result.ok) {
    return {
      phase: 'uniqueness',
      status: 'failed',
      cost,
      warnings: [],
      failure: {
        code: result.code,
        retryable: result.retryable,
        message:
          'the new product could not be placed in a cluster. Without a placement it would rank on merit ' +
          'alone and look exactly like a genuine solo cluster (DECISIONS.md S11), so this is reported ' +
          'here rather than left to be guessed from the board.',
        causes: [result.message],
      },
    };
  }

  const assignment = result.value;
  const placement: Placement =
    assignment.cluster_id === undefined
      ? {
          cluster_id: newClusterId(input.product.id, existingIds),
          isNew: true,
          label: assignment.new_cluster_label ?? '',
          uniqueness_score: assignment.uniqueness_score,
          reason: assignment.reason,
        }
      : {
          cluster_id: assignment.cluster_id,
          isNew: false,
          label: input.clusters.find((cluster) => cluster.cluster_id === assignment.cluster_id)?.label ?? '',
          uniqueness_score: assignment.uniqueness_score,
          reason: assignment.reason,
        };

  return { phase: 'uniqueness', status: 'ok', cost, warnings: [], value: placement };
}

/**
 * A cluster id for a product that opened its own cluster.
 *
 * Derived from the product id, so it is stable across a retry of the same
 * placement rather than fresh on every attempt — a demand vote keyed to a
 * regenerated id would be orphaned. Suffixed only on the collision that a
 * hand-edited roster could produce.
 */
function newClusterId(productId: number, taken: ReadonlySet<ClusterId>): ClusterId {
  const base = `p${productId}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Append the new product to the stored clusters. Append-only, literally: existing
 * `cluster_id`s, labels and memberships are copied through untouched, so every
 * demand vote keyed to one of them stays valid (`brief §1.5`).
 *
 * Pure, and deliberately so: a durable executor can call it after reading the
 * placement phase back off disk, and get the same roster the in-process path
 * would have built.
 */
export function mergePlacement(
  prior: UniquenessResult,
  productId: number,
  placement: Placement,
): UniquenessResult {
  const clusters: Cluster[] = prior.clusters.map((cluster) =>
    cluster.cluster_id === placement.cluster_id
      ? { ...cluster, member_ids: [...cluster.member_ids, productId] }
      : { ...cluster },
  );

  if (placement.isNew) {
    clusters.push({
      cluster_id: placement.cluster_id,
      label: sanitize(placement.label, SANITIZE_LIMIT),
      member_ids: [productId],
    });
  }

  const row: UniquenessProduct = {
    id: productId,
    uniqueness_score: placement.uniqueness_score,
    cluster_id: placement.cluster_id,
    reason: placement.reason,
  };

  return { clusters, products: [...prior.products, row] };
}

/**
 * The cluster the new product landed in, if it now holds a choice worth putting
 * to anybody — i.e. the ONE set whose membership moved.
 *
 * `undefined` means the product opened a cluster of its own, so no persona's
 * forced choice changed and the Floor does not convene at all. `similarSets`
 * filters to >= 2 members anyway; checking here is what lets the Customer phase
 * be SKIPPED rather than called with a set it would discard.
 */
export function changedCluster(merged: UniquenessResult, clusterId: ClusterId): Cluster | undefined {
  const cluster = merged.clusters.find((candidate) => candidate.cluster_id === clusterId);
  return cluster !== undefined && cluster.member_ids.length >= 2 ? cluster : undefined;
}

/**
 * The Floor legitimately not convening, on the placement path.
 *
 * `01 §5.3`'s gate and `DECISIONS.md` S11's terminal, SUCCESSFUL status —
 * structurally the same arm a full run returns for a category with no
 * multi-member cluster, and emphatically not the `failed` arm a placement that
 * never happened gets. 32 of 48 and 26 of 44 seeded products had no peers, so
 * merit-only is the common case, not a degraded one.
 */
export function skippedCustomerPhase(): PhaseResult<CustomerPhaseValue> {
  return { phase: 'customer', status: 'skipped', cost: zeroCost(), warnings: [], skipped: 'no_sets' };
}
