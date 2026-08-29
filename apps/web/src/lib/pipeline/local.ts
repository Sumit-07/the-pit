/**
 * A `StepRunner` that just runs the bodies, plus a `ModelClient` wrapper that
 * says which step each call was made from.
 *
 * Two jobs, and the second is the important one.
 *
 * Together they let the whole pipeline execute in a process with no Inngest
 * client, no dev server and no network — which is how the engine's own suite runs
 * and what this one needs too.
 *
 * And they make `brief` Part 7's constraint TESTABLE. "One Inngest step per
 * phase, not per juror call" has no observable effect on a run's output: split
 * the six juror calls into six steps and every score, rank, verdict and dollar
 * figure comes out identical. What changes is the list of step ids the executor
 * was handed — and against the free tier's five-concurrent-step limit, that
 * difference is the entire point. So `RecordingStepRunner` records the ids, and
 * `CallMeter` attributes every model call to the step it was made from, through
 * an `AsyncLocalStorage` rather than a wall-clock window: `score` and `cluster`
 * run CONCURRENTLY (`01 §2`'s Round 1), so a timestamp-based attribution would
 * credit one step's calls to the other.
 *
 * The two assertions that follow are the ones a per-juror-step regression fails:
 *
 * - `ids` is exactly `PIPELINE_STEPS` — five entries, not ten or fifteen.
 * - `callsIn('score')` is `JUROR_COUNT x chunks`, and `concurrencyIn('score')`
 *   is the same number, i.e. they went out together rather than one after
 *   another. A phase that awaited its calls in a loop would pass the step count
 *   and fail this.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ModelClient, ModelRequest, ModelResponse } from '@the-pit/engine';

import type { PipelineStep, StepRunner } from './types';

/**
 * The step a model call is being made from.
 *
 * Async context rather than a mutable "current step" field, because Round 1 runs
 * two steps at once and a single field would be whichever started last.
 */
const currentStep = new AsyncLocalStorage<PipelineStep>();

/** Which step the calling code is inside, or `undefined` outside the pipeline. */
export function stepInProgress(): PipelineStep | undefined {
  return currentStep.getStore();
}

/**
 * Runs step bodies inline, in order, recording each one.
 *
 * A body that throws is recorded before the throw propagates — a step that failed
 * still ran, and a test asserting "only the failed phase re-ran" needs to see it.
 */
export class RecordingStepRunner implements StepRunner {
  /** The step ids, in completion order. Compare against `PIPELINE_STEPS`. */
  readonly ids: PipelineStep[] = [];

  async run<T>(id: PipelineStep, body: () => Promise<T>): Promise<T> {
    try {
      return await currentStep.run(id, body);
    } finally {
      this.ids.push(id);
    }
  }
}

/**
 * A `ModelClient` wrapper that counts calls per step and tracks how many of them
 * were in flight at once.
 *
 * The concurrency figure is what separates "six calls inside one step" from "six
 * calls inside one step, awaited one after another". Both give the right step
 * count and only the first is what `brief` Part 7 asks for.
 */
export class CallMeter implements ModelClient {
  private readonly inner: ModelClient;
  private readonly inFlight = new Map<string, number>();
  private readonly peaks = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(inner: ModelClient) {
    this.inner = inner;
  }

  /** Every call this run made, whatever step it came from. */
  get total(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }

  /** Calls made from inside one step. */
  callsIn(step: PipelineStep): number {
    return this.counts.get(step) ?? 0;
  }

  /** The most calls in flight at once inside one step. */
  concurrencyIn(step: PipelineStep): number {
    return this.peaks.get(step) ?? 0;
  }

  /** Calls made outside any step — which should always be zero in a pipeline run. */
  get callsOutsideAnyStep(): number {
    return this.counts.get(OUTSIDE) ?? 0;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const key = currentStep.getStore() ?? OUTSIDE;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const flight = (this.inFlight.get(key) ?? 0) + 1;
    this.inFlight.set(key, flight);
    this.peaks.set(key, Math.max(this.peaks.get(key) ?? 0, flight));
    try {
      // Yield once so simultaneous callers genuinely overlap. A fixture client
      // resolves without ever suspending, and without this the second call would
      // not begin until the first had finished — the peak would read 1 for a
      // fan-out that really is parallel, and the assertion would be measuring the
      // fixture rather than the phase.
      await Promise.resolve();
      return await this.inner.complete(request);
    } finally {
      this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
    }
  }
}

/** The bucket for a call made with no step in progress. */
const OUTSIDE = 'outside';
