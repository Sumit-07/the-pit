/**
 * The paid path: ONE customer, ONE product, placed into a category that is
 * already scored — as five durable steps.
 *
 *   score ──▶ cluster ──▶ persona ──▶ rank ──▶ deliver
 *
 * `packages/engine`'s `runIncremental` is this same path in one process. Every
 * decision it makes is still the engine's here: `brief §1.1`'s calibration sample
 * (`placementCalibration`), the append-only placement and its merge
 * (`runPlacementPhase`, `mergePlacement`, `changedCluster`), the Floor's gate
 * (`skippedCustomerPhase`), and the whole of step 4 — the score-log fold, the
 * demand merge, the ledger, the coverage record and the re-rank
 * (`completePlacement`). This module contributes the STEP BOUNDARIES and nothing
 * else, because a second implementation of any of the above would be a second
 * implementation of the money path.
 *
 * ## Why this needs to be steps at all
 *
 * This is the path every paying customer takes, and until now it was the one path
 * the pipeline could not run. A placement spends `JUROR_COUNT + 1 + personas`
 * calls; `runIncremental` executed as a single unit of work either finishes or
 * loses all of them. As steps it is resumable, retryable and step-bounded exactly
 * as a full run is: a failed phase is persisted before it is thrown, and the
 * retry re-buys only that phase (`brief §2.3`).
 *
 * ## One step per phase (`brief` Part 7)
 *
 * Five step ids, the same five `PIPELINE_STEPS` names, whatever the panel size.
 * The six juror calls fan out INSIDE the score step — the free tier allows five
 * concurrent steps, so a six-way fan-out as steps throttles — and the personas
 * fan out inside the persona step. `test/placement-steps.test.ts` asserts the
 * executed step ids, which is the only assertion that catches the regression.
 *
 * ## Score before cluster, unlike a full run
 *
 * A full run fires `score` and `cluster` together: `01 §2`'s Round 1, neither
 * depends on the other. A placement does not, and that is `runIncremental`'s
 * behaviour rather than an oversight — if the merit panel did not return usable
 * scores there is nothing to place, so the placement call is never made and the
 * customer is never charged for it. One extra call's worth of latency, once, on
 * the path where the spend actually matters.
 *
 * ## The input gate
 *
 * `screenInput` (`DECISIONS.md` S9) runs before the first step, on UNTRUSTED
 * submitted text, and a hold returns without spending anything and without
 * persisting anything. It is not a failure and must never be retried: it is a
 * route-to-a-human decision. It is deterministic, so a replay reaches the same
 * verdict without a memoized step to remember it.
 */

import {
  assertPlaceable,
  changedCluster,
  completePlacement,
  mergePlacement,
  phaseVersions,
  placementCalibration,
  runCustomerPhase,
  runPlacementPhase,
  runScorePhase,
  screenInput,
  skippedCustomerPhase,
  type CustomerPhaseValue,
  type IncrementalInput,
  type PanelOrdering,
  type Placement,
  type PlacedCluster,
  type PhaseResult,
  type PhaseVersions,
  type ScorePhaseValue,
} from '@the-pit/engine';

import { NoModelClient, PhaseFailedError } from './errors';
import { reusableStoredPhase } from './resume';
import { deliverStep, phaseStep, type DeliverReport, type PipelineResult } from './run';
import type { PipelineDeps, StepReport, StepRunner } from './types';

/**
 * One submission against one already-scored category.
 *
 * The engine's `IncrementalInput` minus the two things a durable executor owns:
 * the model client and the store both come from `PipelineDeps`, so a step body
 * cannot be handed one set and the assembly another.
 */
export type PlacementInput = Omit<IncrementalInput, 'client' | 'store'>;

/**
 * What a placement produced.
 *
 * `held` is a separate arm rather than a failure, exactly as it is in the engine:
 * nothing was spent, nothing was persisted, and retrying it would reach the same
 * verdict forever.
 *
 * A `placed` outcome with `assignment.is_new` is a SUCCESSFUL delivery, not a
 * partial one. 32 of 48 and 26 of 44 seeded products had no peers, so a solo
 * cluster is the common case; the board shows merit alone and says so
 * (`demand_status: 'solo_cluster'`), and `DECISIONS.md` S11 calls that whole.
 */
export type PlacementOutcome =
  | { status: 'held'; matched: string }
  | ({ status: 'placed' } & PlacementResult);

/** A delivered placement: the pipeline's result, plus where the product landed. */
export interface PlacementResult extends PipelineResult {
  assignment: PlacedCluster;
}

/** The `rank` step's report, which carries the assignment back to the caller. */
interface PlaceReport extends StepReport {
  assignment: PlacedCluster;
}

/**
 * Place one product through the pipeline.
 *
 * Throws `PhaseFailedError` on any phase failure, exactly as `runPipeline` does,
 * so `inngest.ts`'s existing mapping onto the executor's vocabulary applies
 * unchanged: a retryable failure gets one of `brief §2.3`'s three free retries, a
 * terminal one goes to the support queue.
 */
export async function runPlacement(
  input: PlacementInput,
  deps: PipelineDeps,
  step: StepRunner,
): Promise<PlacementOutcome> {
  // The two guards and the gate, before a step exists to spend anything. Both are
  // the engine's: `assertPlaceable` refuses a colliding id and a category that has
  // never been clustered (`brief §1.5` makes building a roster an admin
  // operation, not a side effect of a submission).
  const prior = assertPlaceable(input);

  const screen = screenInput(`${input.product.name}\n${input.product.description}`);
  if (screen.hold) return { status: 'held', matched: screen.matched ?? '' };

  const versions = phaseVersions(input);
  const ordering: PanelOrdering = { category: input.category, categoryVersion: input.config.categoryVersion };
  const reports: StepReport[] = [];

  // --- Score: one product, with the calibration sample (`brief §1.1`) ---------
  reports.push(await step.run('score', () => scoreStep(input, deps, versions, ordering)));

  // --- Cluster: place it against the fixed roster (`brief §1.5`) --------------
  reports.push(
    await step.run('cluster', () =>
      phaseStep<Placement>('cluster', deps, versions, () =>
        runPlacementPhase({
          client: deps.client,
          product: input.product,
          products: input.products,
          clusters: prior.clusters,
        }),
      ),
    ),
  );

  // --- Persona: re-ask the Floor about the ONE set that changed ---------------
  reports.push(await step.run('persona', () => personaStep(input, deps, versions, ordering)));

  // --- Rank: the engine's step 4, over what is already persisted --------------
  const placed = await step.run('rank', () => rankStep(input, deps, versions));
  reports.push(placed);

  // --- Deliver: republish the board, then extend the catalogue ----------------
  const delivered = await step.run('deliver', () => placementDeliverStep(input, deps));
  reports.push(delivered);

  return {
    status: 'placed',
    slug: deps.store.slug,
    reports,
    ...(delivered.published === undefined ? {} : { published: delivered.published }),
    product_count: delivered.product_count,
    assignment: placed.assignment,
  };
}

// --- The steps -----------------------------------------------------------------

/**
 * The merit jury over ONE product — and the whole reason `brief §1.1` exists.
 *
 * > "In a full run, jurors score up to 40 products in one prompt and spread
 * > deductions across them. In the `--add-product` path they score **one product
 * > alone**, which produces systematically different raw scores. Every paid
 * > submission uses that path, so the bias lands entirely on customers."
 *
 * So the calibration sample is not optional on this step and is not a `...spread`
 * that quietly disappears when a config field is absent: `placementCalibration`
 * either passes the sample the caller configured or draws one from the category's
 * own stored ranking. A placement whose prompt lost the block would return
 * plausible, biased scores that nothing downstream could detect — which is why
 * `test/placement-calibration.test.ts` asserts the block is in every juror's
 * prompt rather than trusting the wiring.
 *
 * Six juror calls, one step. `runScorePhase` fans them out with a single
 * `Promise.all`, so the concurrency is the engine's and this step only awaits it.
 */
async function scoreStep(
  input: PlacementInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
  ordering: PanelOrdering,
): Promise<StepReport> {
  return phaseStep<ScorePhaseValue>('score', deps, versions, () =>
    runScorePhase({
      client: deps.client,
      // Deliberately one product. The calibration sample, not a batch, supplies
      // the comparative context.
      products: [input.product],
      jury: input.jury,
      ordering,
      calibration: placementCalibration(input),
    }),
  );
}

/**
 * The Floor, for the one set whose membership moved.
 *
 * The merged roster is rebuilt here from the placement envelope the previous step
 * persisted — not handed across from it. A step's return value is a memoized JSON
 * blob, and a run resumed in a fresh process has no previous step to be handed
 * anything by; the store is the state.
 *
 * If the product opened a cluster of its own, nothing changed for anybody and the
 * phase is `skipped: 'no_sets'` — a terminal, SUCCESSFUL status (`DECISIONS.md`
 * S11), persisted like any other phase result and reported as a skip rather than
 * thrown. That distinction is the whole delivery decision on this path: a solo
 * cluster delivers, a placement that never happened does not.
 */
async function personaStep(
  input: PlacementInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
  ordering: PanelOrdering,
): Promise<StepReport> {
  return phaseStep<CustomerPhaseValue>('persona', deps, versions, async () => {
    const placement = await reusableStoredPhase<Placement>(deps.store, 'uniqueness', versions);
    if (placement === undefined || placement.status !== 'ok') {
      // Unreachable while the cluster step throws on failure: this is the state
      // where the store lost a write or the versions moved mid-run. Terminal,
      // because retrying it spends the customer's free retries reproducing a
      // storage fault rather than a model one.
      throw new PhaseFailedError('persona', [
        {
          code: 'internal',
          retryable: false,
          message:
            'the customer panel could not start: no usable placement was persisted for this submission. ' +
            'Without one there is no changed cluster to re-ask about, and skipping the Floor here would be ' +
            'indistinguishable on the board from a genuine solo cluster (DECISIONS.md S11).',
          causes: [],
        },
      ]);
    }

    const prior = assertPlaceable(input);
    const merged = mergePlacement(prior, input.product.id, placement.value);
    const changed = changedCluster(merged, placement.value.cluster_id);
    if (changed === undefined) return skippedCustomerPhase();

    return runCustomerPhase({
      client: deps.client,
      products: [...input.products, input.product],
      personas: input.personas.personas,
      // Only the changed cluster. Every other set's stored votes stand, which is
      // the entire reason clusters are append-only (`brief §1.5`).
      uniqueness: { clusters: [changed], products: merged.products },
      ordering,
    });
  });
}

/**
 * Rank — the engine's step 4, re-entered over what is already on disk.
 *
 * `completePlacement` folds the new rows into the stored score log, merges the
 * one re-voted set's demand back in, assembles `results.json` with THIS
 * placement's ledger and coverage, and re-ranks the whole category
 * (`brief §1.2`: appending a product moves every z-score, so a placement is a
 * re-rank and not an insertion). Every line of that is the engine's.
 *
 * Handed a `NoModelClient`, like the full path's rank step and for the same
 * reason: this step is arithmetic over stored rows, and a model call from here
 * would mean a phase silently did not resume and is being bought twice.
 */
async function rankStep(
  input: PlacementInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
): Promise<PlaceReport> {
  const score = await reusableStoredPhase<ScorePhaseValue>(deps.store, 'score', versions);
  const placement = await reusableStoredPhase<Placement>(deps.store, 'uniqueness', versions);
  const customer = await reusableStoredPhase<CustomerPhaseValue>(deps.store, 'customer', versions);

  if (score === undefined || placement === undefined || customer === undefined) {
    throw new PhaseFailedError('rank', [
      {
        code: 'internal',
        retryable: false,
        message:
          'the placement cannot be assembled: one of its three phases is not persisted under this run’s ' +
          'versions. Re-buying it here would charge the customer a second time on the step whose whole ' +
          'job is arithmetic.',
        causes: missingPhases({ score, uniqueness: placement, customer }),
      },
    ]);
  }

  const outcome = await completePlacement(
    {
      ...input,
      client: new NoModelClient(
        'the rank step assembles phases that are already persisted and must never buy one; ' +
          'a call here means a phase did not resume, and re-running it silently would charge twice',
      ),
    },
    { score, placement, customer },
    deps.store,
  );

  if (outcome.status !== 'placed') throw new PhaseFailedError('rank', outcome.failures);

  return {
    step: 'rank',
    status: 'ok',
    calls: 0,
    assignment: outcome.assignment,
    detail: outcome.assignment.is_new
      ? `placed in a new cluster ${JSON.stringify(outcome.assignment.cluster_id)}; ` +
        'no peers, so the board shows merit alone (DECISIONS.md S11)'
      : `placed in ${JSON.stringify(outcome.assignment.cluster_id)} alongside ${outcome.assignment.size - 1} peer(s)`,
  };
}

/**
 * Deliver — republish the board, extend the category's catalogue, then settle.
 *
 * The shared `deliverStep` does the publishing and fires `onDelivered`, so
 * `brief §2.3`'s "an attempt is consumed only on delivery" has exactly one
 * implementation for both paths.
 *
 * The catalogue write is handed to `deliverStep` as its `afterPublish` hook
 * rather than done around the call, and the sandwich is the point. It has to
 * happen:
 *
 * - AFTER the board exists, for the reason it always did. `Product.id` is pinned
 *   by `products.json`, and the guards at the top of `runPlacement` run on every
 *   replay: a catalogue that already contained this submission would make
 *   `assertPlaceable` throw before the retried step ever started, turning a
 *   recoverable publishing failure into a dead run.
 * - BEFORE `onDelivered`, which is new. On Postgres this write is the paid
 *   `products` row — `source = 'paid'` with the payer's address, which is what
 *   `products_source_submitter` demands and what makes `brief §2.4`'s cycle lock,
 *   material-change and ownership rules reachable at all. The verdict that
 *   settlement writes names that row through a foreign key, so a settle fired
 *   before it existed would fail inside the transaction that has already
 *   published a board.
 *
 * Both writes are idempotent, so a replayed step lands on the same rows.
 *
 * ## The version the board is stamped with is the one it was STORED under
 *
 * A placement produces a new board — `brief §1.2` moves every z-score the moment
 * a product is appended — so a durable store publishes it under a new
 * `category_snapshot_version` and moves the category's to match, in one
 * transaction (`pg-store.ts`'s `publishAs`). That version is read back off the
 * store rather than taken from `input.config.categoryVersion`, which is the
 * version this run READ.
 *
 * It has to be, because the stamp is not decoration. It is the CDN key segment
 * the archived board sits under (`snapshot.ts`), the cache key `brief §1.3`
 * invalidates on, and the `category_snapshot_version` frozen onto the verdict
 * payload a customer's permanent URL resolves through. Stamped with the version
 * that was read, all three would name a board that no longer exists.
 *
 * `input.config.categoryVersion` is the fallback for the stores that do not key
 * boards by version at all — the filesystem and memory ones, which hold a single
 * `ranking.json` and overwrite it.
 */
async function placementDeliverStep(input: PlacementInput, deps: PipelineDeps): Promise<DeliverReport> {
  const categoryVersion = deps.store.publishedCategoryVersion ?? input.config.categoryVersion;
  return deliverStep(
    categoryVersion,
    deps,
    async () => {
      await deps.store.writeProducts({
        category: input.category,
        products: [...input.products, input.product],
      });
    },
    // The installed jury this placement was judged by, frozen onto the verdict
    // with the rank. `deliverStep` says why it cannot be read at render, and
    // `verdict-panel.ts` says why nothing downstream can recover it from the
    // board: without it a paying customer's verdict draws six merit spokes and
    // can say who cut them for none.
    input.jury,
  );
}

/** Which of the three phases did not come back, for a failure that names them. */
function missingPhases(phases: Record<string, PhaseResult<unknown> | undefined>): string[] {
  return Object.entries(phases)
    .filter(([, result]) => result === undefined)
    .map(([phase]) => `no reusable ${phase} phase is stored for this placement`);
}
