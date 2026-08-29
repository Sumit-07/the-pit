/**
 * The order products are chunked and rendered in.
 *
 * ## The defect this fixes
 *
 * `Product.id` is assigned AFTER sorting by the source sheet's `Rank`
 * (`src/ingest/load-category.ts`), so id order **is** the incoming leaderboard
 * order. Rendering a prompt in id order therefore shows a model a monotone
 * function of `orig_rank`, even though no rank value is ever printed — and
 * Global Constraint 1 says no model call may see a rank. A juror reading top to
 * bottom would be walking the exact leaderboard this engine exists to re-judge,
 * and `01 §5.1` points it at that list as its comparison set.
 *
 * The larger consequence is in the chunking. `balancedChunks` splits n = 44 into
 * `[22, 22]`, so in id order chunk 1 is the products ranked 1-22 and chunk 2 is
 * those ranked 23-44. Scoring is comparative — a juror deducts against the set in
 * front of it — so chunk 1 is judged against a uniformly strong field and chunk 2
 * against a uniformly weak one, and chunk 2's raw scores come back systematically
 * inflated relative to chunk 1's. `computeComposite` then z-normalizes all 44 as
 * one population, standardizing two differently-calibrated halves as if they were
 * one.
 *
 * That is `the-pit-build-brief.md` §1.1's isolated-scoring bias reappearing
 * BETWEEN CHUNKS on the full-run path. §1.1's own fix (the calibration sample)
 * addresses the incremental path and does not touch it.
 *
 * ## The fix
 *
 * Order every panel's products by a deterministic shuffle seeded on
 * `(category slug, categoryVersion)` — the same seed discipline the calibration
 * sampler uses, from the same module (`src/panels/seeded.ts`) — before chunking
 * and before rendering. Each chunk becomes a random sample across the whole
 * incoming range instead of a rank-contiguous band.
 *
 * ## What this does NOT remove
 *
 * The POSITIONAL signal is gone: reading top to bottom no longer walks the
 * incoming leaderboard, and no chunk is a rank-contiguous band. The NUMERIC
 * signal is not. Every prompt still prints `[id N]` markers, and `Product.id` is
 * itself a monotone function of `orig_rank`, so a model that chose to read the
 * id numbers could still recover the incoming order.
 *
 * That is a deliberate trade, not an oversight. Remapping display ids would put
 * a translation layer between what a juror scores and what the score log records
 * — and a translation bug misattributes a score to the wrong product, which is
 * far worse than the residual signal. Ids are the join key for the score log,
 * the clusters, the demand log and `ranking.json` alike. The size of what
 * remains is a question for measurement (Task 8), not for a comment.
 *
 * Two properties are the point, and both are enforced here:
 *
 * 1. **Not id order.** The permutation is drawn from a PRNG, so for any category
 *    of a realistic size the render order carries no `orig_rank` signal.
 * 2. **Stable.** Same category, same version, same set -> byte-identical order,
 *    in every process. The six jurors of one run must see the IDENTICAL prompt
 *    prefix or the cache breakpoint never hits, and two runs of the same category
 *    must be comparable.
 *
 * `Product.id` is never reassigned. It stays the stable key that the score log,
 * the clusters, the demand log and `ranking.json` are all joined on; only the
 * order things are presented in changes.
 */

import { CHUNK_SIZE } from '../config/constants.js';
import { chunkItems } from '../rank/chunk.js';
import { requireSlug, seedFrom, shuffleSeeded } from './seeded.js';

/**
 * What pins an order to a point in a category's life. The same pair that seeds
 * the calibration sample, for the same reason: `categoryVersion` bumps on every
 * placement and every nightly rebuild (`brief` Part 3), so a rebuilt category
 * legitimately gets a fresh order while a re-run of the same snapshot does not.
 */
export interface PanelOrdering {
  category: string;
  categoryVersion: string;
}

/** Namespace for the product render/chunk order. */
const ORDER_NAMESPACE = 'panel-order';

/**
 * The seed for one ordering decision. `namespace` separates unrelated draws that
 * share a `(slug, version)` pair, so the calibration selection and the render
 * order never move together.
 */
export function orderingSeed(ordering: PanelOrdering, namespace: string = ORDER_NAMESPACE): number {
  const slug = requireSlug('panelOrder', ordering.category, ordering.categoryVersion);
  return seedFrom(namespace, slug, ordering.categoryVersion);
}

/**
 * The canonical presentation order for a set of products.
 *
 * Sorted by `id` first so the result does not depend on the order the caller's
 * array happened to be in — a permutation that varied with input order would be
 * stable only by luck — then shuffled with the seeded PRNG.
 *
 * Idempotent in the sense that matters: applying it to an already-ordered subset
 * (a chunk) is still deterministic and still carries no rank signal, so a caller
 * that orders globally and a builder that orders again locally do not conflict.
 */
export function panelOrder<T extends { id: number }>(items: readonly T[], ordering: PanelOrdering): T[] {
  const canonical = [...items].sort((a, b) => a.id - b.id);
  return shuffleSeeded(canonical, orderingSeed(ordering));
}

/**
 * Order first, then chunk. The function Task 7's scoring pass calls, so the
 * rank-contiguous-chunk defect described above is not merely fixed but
 * unwritable: there is no path here that chunks products in the order they
 * arrived.
 *
 * The concatenation of the result is a permutation of the input: no product is
 * dropped and none is scored twice (`chunkItems`).
 */
export function orderedChunks<T extends { id: number }>(
  items: readonly T[],
  ordering: PanelOrdering,
  maxSize: number = CHUNK_SIZE,
): T[][] {
  return chunkItems(panelOrder(items, ordering), maxSize);
}
