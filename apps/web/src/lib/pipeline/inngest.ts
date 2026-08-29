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
 * — a terminal `PhaseFailedError` becomes `NonRetriableError`, and nothing else
 * is reinterpreted.
 *
 * ## Why the pipeline does not import this module
 *
 * `run.ts` throws `PhaseFailedError`, not `NonRetriableError`, so the pipeline
 * and every test of it run without loading the Inngest SDK — and so the same
 * pipeline can be driven by a different executor later without its failure
 * semantics being defined by a vendor's error class.
 */

import { AnthropicClient } from '@the-pit/engine';
import { Inngest, NonRetriableError } from 'inngest';

import { PhaseFailedError } from './errors';
import { runPipeline, type PipelineResult } from './run';
import { defaultBindings, type RunnerBindings } from './service';
import type { PipelineDeps, PipelineStep, StepRunner } from './types';

/** `brief §2.3`'s cap on free retries per attempt, before the support queue. */
export const MAX_FREE_RETRIES = 3;

/** The event that enqueues a run. Carries a slug, never a category payload. */
export const RUN_REQUESTED = 'pit/run.requested';

/** The event a delivered run emits, for whatever consumes an attempt. */
export const RUN_DELIVERED = 'pit/run.delivered';

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
 */
export function toExecutorError(error: unknown): unknown {
  if (error instanceof PhaseFailedError && !error.retryable) {
    return new NonRetriableError(error.message, { cause: error });
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
    store: bindings.store(input.category),
    snapshots: bindings.snapshots,
    ...(onDelivered === undefined ? {} : { onDelivered }),
  };

  return runPipeline(input, deps, runner);
}
