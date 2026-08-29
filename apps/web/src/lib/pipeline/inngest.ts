/**
 * The Inngest edge: the client, the event, the function, and the two mappings
 * that belong at a boundary rather than in the pipeline.
 *
 * ## The step granularity, once more, where it is enforced
 *
 * `brief` Part 7 caps the free tier at 50K executions and **5 concurrent steps**.
 * `runPipeline` asks this adapter for exactly five steps —
 * `score`, `cluster`, `persona`, `rank`, `deliver` — and fires the first two
 * together, so a run peaks at two concurrent steps and a category with six jurors
 * and two chunks still spends five executions rather than fifteen. Nothing below
 * this file may turn a model call into a step.
 *
 * ## Retries: three, free, and only for failures that can come out differently
 *
 * `brief §2.3`: "Failures are free retries... **Cap free retries at 3 per
 * attempt**, then route to a support queue." `retries: 3` is that cap, enforced
 * by the executor rather than by a counter this code would have to keep. What
 * decides whether a failure gets to use one is the ENGINE's classification, which
 * arrives here already made: `dispatch` keys it on an error code and demotes a
 * `max_tokens` truncation to terminal precisely so a deterministic failure cannot
 * consume the budget. `toExecutorError` is the whole of this file's contribution
 * — a terminal failure becomes `NonRetriableError`, and nothing else is
 * reinterpreted.
 *
 * "Terminal" is `isTerminalFailure`, and it covers one thing the engine cannot
 * see: a deterministic STORAGE fault. `SnapshotVersionConflictError` is a unique
 * constraint that will still be there on the third retry, so it is demoted on its
 * error code exactly as `dispatch` demotes `max_tokens` — same rule, same reason,
 * one layer out.
 *
 * ## Why the pipeline does not import this module
 *
 * `run.ts` throws `PhaseFailedError`, not `NonRetriableError`, so the pipeline
 * and every test of it run without loading the Inngest SDK — and so the same
 * pipeline can be driven by a different executor later without its failure
 * semantics being defined by a vendor's error class.
 */

import { AnthropicClient, phaseVersions, type Product } from '@the-pit/engine';
import { Inngest, NonRetriableError } from 'inngest';

import { PlacementInFlightError, type PlacementSubmission } from './claims';
import { isTerminalFailure } from './errors';
import { runPlacement, type PlacementOutcome } from './placement';
import { runPipeline, type PipelineResult } from './run';
import { defaultBindings, type RunnerBindings } from './service';
import { PlacementPhaseStore } from './store';
import type { PipelineDeps, PipelineStep, StepRunner } from './types';

/** `brief §2.3`'s cap on free retries per attempt, before the support queue. */
export const MAX_FREE_RETRIES = 3;

/** The event that enqueues a run. Carries a slug, never a category payload. */
export const RUN_REQUESTED = 'pit/run.requested';

/** The event a delivered run emits, for whatever consumes an attempt. */
export const RUN_DELIVERED = 'pit/run.delivered';

/**
 * The event that enqueues ONE paid submission against an already-scored
 * category — `brief §1.1`'s `--add-product` path, and the path every paying
 * customer takes.
 */
export const PLACEMENT_REQUESTED = 'pit/placement.requested';

/** What `pit/run.requested` carries. */
export interface RunRequestedData {
  slug: string;
  /**
   * The category snapshot version to run under. Optional only for a first seed:
   * after any placement it must be supplied, because `brief §1.2` moves every
   * z-score in the category and `brief §1.3` keys the caches on this value.
   */
  categoryVersion?: string;
}

/**
 * What `pit/placement.requested` carries.
 *
 * The product itself, unlike `RunRequestedData`'s slug-only payload. A run event
 * names a category that is already seeded on both sides; a placement names a
 * product that exists nowhere yet — it IS the submission — so there is nothing to
 * look it up by until it has been placed. It stays small: one product, not a
 * category.
 *
 * The text in it is UNTRUSTED (Global Constraint 2) and is screened by
 * `DECISIONS.md` S9's input gate before the first step runs.
 */
export interface PlacementRequestedData {
  slug: string;
  /**
   * The category snapshot version to place under. `brief §1.2` moves every
   * z-score in the category on a placement and `brief §1.3` keys the caches on
   * this value, so after the first placement it must be supplied.
   */
  categoryVersion?: string;
  product: Product;
  /**
   * `jobIdempotencyKey` from `@the-pit/payments` — the identity of the
   * SUBMISSION.
   *
   * Optional in the type and required in practice for anything paid. `brief §2.2`
   * asks for "an idempotency key on job creation so a double-clicked submit
   * doesn't buy twice", and without it a second event for one submission — a
   * retried webhook, a re-POSTed status page, a support replay fired in the
   * window between a successful `rank` and a failed `deliver` — runs the whole
   * pipeline again. The customer is not charged twice (`brief §2.3` consumes an
   * attempt only on delivery), so nobody reports it; it shows up as an inference
   * bill that does not match the sales count.
   *
   * Optional because an ADMIN placement has no submission and no payer, and
   * making the field mandatory would only mean the admin path invented a value.
   */
  idempotencyKey?: string;
}

export const inngest = new Inngest({ id: 'the-pit' });

/**
 * Adapt Inngest's `step` onto the pipeline's `StepRunner`.
 *
 * Two things happen here and only here:
 *
 * 1. The failure mapping, applied INSIDE the step body. A throw has to be
 *    classified before the executor sees it, or a terminal failure gets three
 *    retries it can never use.
 * 2. The cast back from `Jsonify<T>`. Every step body returns a `StepReport`,
 *    which is plain JSON by construction — the cast asserts what the shape
 *    already guarantees, and it is confined to this one line rather than spread
 *    through the pipeline.
 */
export function inngestStepRunner(step: { run: (id: string, body: () => Promise<unknown>) => Promise<unknown> }): StepRunner {
  return {
    async run<T>(id: PipelineStep, body: () => Promise<T>): Promise<T> {
      const value = await step.run(id, async () => {
        try {
          return await body();
        } catch (error) {
          throw toExecutorError(error);
        }
      });
      return value as T;
    },
  };
}

/**
 * Turn a pipeline failure into the executor's vocabulary.
 *
 * A retryable failure is returned unchanged so Inngest applies its own backoff
 * and the `retries: 3` cap. A terminal one becomes `NonRetriableError`: the run
 * cannot come out differently, and `brief §2.3` sends it to a support queue
 * rather than through a retry loop that spends money reproducing it.
 *
 * Two kinds of failure reach that arm, and `isTerminalFailure` is the only thing
 * that decides which:
 *
 * - A terminal `PhaseFailedError`. The engine classified it; nothing here
 *   re-opens the question.
 * - A deterministic STORAGE fault, carried on an error code —
 *   `SnapshotVersionConflictError` from `pg-store.ts`. It used to escape the
 *   `rank` step unwrapped, so Inngest saw a bare error, assumed the optimistic
 *   thing, and spent all three free retries reproducing a unique-constraint
 *   violation that only an operator can clear.
 *
 * Keyed on a code and never on the message, for the reason
 * `packages/engine/src/run/dispatch.ts` gives about its own `max_tokens`
 * demotion: a classifier that matches prose stops classifying the day the prose
 * is reworded, and it does so silently and on the money path.
 */
export function toExecutorError(error: unknown): unknown {
  if (isTerminalFailure(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return new NonRetriableError(message, { cause: error });
  }
  return error;
}

/**
 * The pipeline as an Inngest function.
 *
 * `concurrency` is per-category: two runs of the same board would race on the
 * same `cjr/runs/<slug>/` artifacts, and `brief §1.5` makes cluster membership
 * append-only precisely because a second writer invalidates stored demand votes.
 * Different categories still run in parallel.
 */
export const runCategoryFunction = inngest.createFunction(
  {
    id: 'run-category',
    retries: MAX_FREE_RETRIES,
    concurrency: { key: 'event.data.slug', limit: 1 },
    triggers: [{ event: RUN_REQUESTED }],
  },
  async ({ event, step }) => {
    const data = event.data as RunRequestedData;
    return executeRun(data, defaultBindings(), inngestStepRunner(step), async (payload) => {
      await inngest.send({ name: RUN_DELIVERED, data: payload });
    });
  },
);

/**
 * Load the category and run it. Separated from `createFunction` so the whole body
 * is reachable from a test with in-memory bindings and a recording step runner.
 *
 * A missing or unapprovable category is `NonRetriableError` on sight: no amount
 * of retrying installs a jury, and `01 §4` Steps 2 and 3 are human approval
 * gates.
 */
export async function executeRun(
  data: RunRequestedData,
  bindings: RunnerBindings,
  runner: StepRunner,
  onDelivered?: PipelineDeps['onDelivered'],
  client: PipelineDeps['client'] = new AnthropicClient(),
): Promise<PipelineResult> {
  const input = await bindings.categories.load(
    data.slug,
    data.categoryVersion === undefined ? {} : { categoryVersion: data.categoryVersion },
  );
  if (input === undefined) {
    throw new NonRetriableError(`no category is seeded under the slug ${JSON.stringify(data.slug)}`);
  }

  const deps: PipelineDeps = {
    client,
    // The store is addressed by the versions this run is judged under, not just
    // by the category. A durable store keys its row on all four of them, so a run
    // under a bumped `prompt_version` reads no phases and re-runs — the same
    // verdict `resume.ts`'s version gate reaches from the stamps inside the
    // envelopes. `phaseVersions` is the engine's own, and `runPipeline` computes
    // the identical value to stamp what it writes.
    store: bindings.store(input.category, phaseVersions(input)),
    snapshots: bindings.snapshots,
    ...(onDelivered === undefined ? {} : { onDelivered }),
  };

  return runPipeline(input, deps, runner);
}

/**
 * The placement as an Inngest function.
 *
 * A separate function from `run-category` because it is a separate event with a
 * separate payload, but the same `retries: 3` cap and the same per-slug
 * concurrency: two placements against one category would race on the same
 * `results.json` and `ranking.json`, and `brief §1.5` makes cluster membership
 * append-only precisely because a second writer invalidates stored demand votes.
 *
 * Inngest's concurrency key is per FUNCTION, so this serializes placements
 * against each other but not against a full re-run of the same category. That
 * pairing is an admin operation on a category with paid placements in it, and it
 * is `brief §1.5`'s "explicit admin operation that clears demand" — it should not
 * be enqueued while a placement is in flight.
 */
export const placeProductFunction = inngest.createFunction(
  {
    id: 'place-product',
    retries: MAX_FREE_RETRIES,
    concurrency: { key: 'event.data.slug', limit: 1 },
    triggers: [{ event: PLACEMENT_REQUESTED }],
  },
  async ({ event, step }) => {
    const data = event.data as PlacementRequestedData;
    return executePlacement(data, defaultBindings(), inngestStepRunner(step), async (payload) => {
      await inngest.send({ name: RUN_DELIVERED, data: payload });
    });
  },
);

/**
 * Load the category, its stored votes and its board, and place one product into
 * them. Separated from `createFunction` for the same reason `executeRun` is: the
 * whole body is reachable from a test with in-memory bindings.
 *
 * Three things are terminal on sight, because no amount of retrying changes any
 * of them: a slug that is not seeded, a category that has never been RUN (a
 * placement appends to stored votes and clusters; there is nothing to append to),
 * and — inside `runPlacement` — a product id that already exists.
 *
 * The phases are stored in the placement's own scope (`placementScope`), while
 * `products.json`, `results.json` and `ranking.json` stay the category's. A
 * placement's `score` envelope holds one product and its `uniqueness` envelope
 * holds a cluster ASSIGNMENT rather than a roster; sharing a scope with the seed
 * run would let the resume gate hand one to the other under a matching version
 * stamp, and it would be right to — nothing in the envelope says which kind of
 * run wrote it.
 */
export async function executePlacement(
  data: PlacementRequestedData,
  bindings: RunnerBindings,
  runner: StepRunner,
  onDelivered?: PipelineDeps['onDelivered'],
  client: PipelineDeps['client'] = new AnthropicClient(),
): Promise<PlacementOutcome> {
  const category = await bindings.categories.load(
    data.slug,
    data.categoryVersion === undefined ? {} : { categoryVersion: data.categoryVersion },
  );
  if (category === undefined) {
    throw new NonRetriableError(`no category is seeded under the slug ${JSON.stringify(data.slug)}`);
  }

  const versions = phaseVersions(category);
  const categoryStore = bindings.store(category.category, versions);
  const [results, ranking] = await Promise.all([categoryStore.readResults(), categoryStore.readRanking()]);

  if (results === undefined || ranking === undefined) {
    throw new NonRetriableError(
      `the category ${JSON.stringify(data.slug)} has no delivered run to place into. A placement appends ` +
        'to stored scores, clusters and votes (brief §1.5); seeding the category is a separate operation ' +
        'and must happen first.',
    );
  }

  // The claim, BEFORE the first step and before anything is spent. See
  // `claims.ts`: the window is a second event for one submission arriving while
  // the first is in flight, and what it costs is a whole second pipeline —
  // twelve juror calls, two clustering passes, two persona rounds — for one
  // payment. A claim taken after the run would guard nothing.
  const submission: PlacementSubmission | undefined =
    data.idempotencyKey === undefined || data.idempotencyKey === ''
      ? undefined
      : { key: data.idempotencyKey, slug: data.slug, versions, productId: data.product.id };

  if (submission !== undefined) {
    const claim = await bindings.claims.claim(submission);
    // A finished submission never runs again — whoever owns it, and including
    // this run itself. One submission, one placement, one result.
    if (claim.outcome !== undefined) return claim.outcome;
    // Owned by someone else and not finished. Retryable rather than terminal: it
    // costs no model calls, and the first placement landing is exactly the thing
    // that makes a retry succeed. An unfinished claim of THIS run's own is
    // `brief §2.3`'s free retry and falls through to resume its phases.
    if (!claim.mine) throw new PlacementInFlightError(claim.runId);
  }

  const deps: PipelineDeps = {
    client,
    // The scope is named to the BINDING rather than smuggled through the category
    // string. On disk it becomes `placementScope(...)`, the separate directory
    // this file already described; in Postgres it becomes a separate job row.
    // Passing a synthetic category name worked on the filesystem and could not
    // work durably — `PgPipelineStore` resolves a real `categories.id` from the
    // slug, and there is no category called "... placement 41".
    store: new PlacementPhaseStore(
      categoryStore,
      bindings.store(category.category, versions, { placement: data.product.id }),
    ),
    snapshots: bindings.snapshots,
    ...(onDelivered === undefined ? {} : { onDelivered }),
  };

  const outcome = await runPlacement({ ...category, product: data.product, results, ranking }, deps, runner);

  // Recorded only on a finished run. A failure is not an outcome — `brief §2.3`
  // makes it a free retry, and a retry has to be allowed to run.
  if (submission !== undefined) await bindings.claims.record(submission, outcome);
  return outcome;
}
