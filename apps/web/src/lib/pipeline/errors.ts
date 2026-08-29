/**
 * How a phase failure leaves the pipeline.
 *
 * ## The classification is the engine's, always
 *
 * `packages/engine/src/run/dispatch.ts` already decides whether a failure is
 * retryable, keyed on an error CODE rather than on message wording, and already
 * demotes a `max_tokens` truncation to terminal so a deterministic failure cannot
 * burn `brief §2.3`'s free-retry budget reproducing itself. Nothing here
 * re-classifies anything: `PhaseFailedError.retryable` is copied straight off
 * `PhaseFailure.retryable`, and the only judgement this module makes is the one
 * the engine cannot — that a run whose failures are ALL retryable is retryable,
 * and one terminal failure makes the whole run terminal. That is the same rule
 * `runCategory` applies to its own `RunOutcome`.
 *
 * ## Why an exception rather than a return value
 *
 * Inside a durable step, the difference between "returned a failure" and "threw"
 * is the difference between a step that is memoized as done and a step that is
 * retried. A phase result that came back `failed` has to become a throw or the
 * executor will record the failure as the step's answer and march on to `rank`
 * with nothing to rank. The result is persisted BEFORE the throw — that is what
 * gives the support queue and the status page a diagnosis, and it is why
 * `brief §2.3`'s "retry only the failed phase" can be true at all.
 *
 * The mapping onto Inngest's own retriable/non-retriable distinction happens at
 * the edge, in `inngest.ts`, so that the pipeline and its tests do not have to
 * load the Inngest SDK to run.
 */

import type { ModelClient, ModelRequest, PhaseFailure } from '@the-pit/engine';
import { ModelCallError } from '@the-pit/engine';

import type { PipelineStep } from './types';

/**
 * A phase that ran and did not produce a usable result.
 *
 * `retryable: true` is `brief §2.3`'s FREE retry — no attempt consumed, nothing
 * delivered. `retryable: false` means the run cannot come out differently and
 * belongs in the support queue rather than in a retry loop.
 */
export class PhaseFailedError extends Error {
  override readonly name = 'PhaseFailedError';
  readonly step: PipelineStep;
  readonly retryable: boolean;
  readonly failures: readonly PhaseFailure[];

  constructor(step: PipelineStep, failures: readonly PhaseFailure[]) {
    const first = failures[0];
    super(`${step}: ${first?.message ?? 'the phase failed with no stated cause'}`);
    this.step = step;
    this.failures = failures;
    // One terminal failure decides the run. Matches `runCategory`'s own
    // `failures.every(f => f.retryable)`.
    this.retryable = failures.length > 0 && failures.every((failure) => failure.retryable);
  }
}

/**
 * A `ModelClient` that exists to prove a code path never reaches a model.
 *
 * Two places need it, for the same reason and from two different documents:
 *
 * - The `rank` step re-enters `runCategory` with `resume: true` purely to
 *   reassemble what is already persisted. Every phase must come back off disk. If
 *   one did not — a stale version stamp, a store that lost a write — the honest
 *   outcome is a loud failure, not a silent second purchase of a phase the
 *   customer has already paid for once.
 * - `02 §4`: "the board never computes anything at read time" and "reads never
 *   touch a model". A snapshot build handed this client fails rather than
 *   quietly spending on a page view.
 *
 * It throws a `ModelCallError` with `retryable: false`, so if it ever does fire
 * the engine's own classifier reports it as terminal and it lands in front of a
 * person instead of being retried three times.
 */
export class NoModelClient implements ModelClient {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  complete(request: ModelRequest): Promise<ModelResponseNever> {
    return Promise.reject(
      new ModelCallError(
        `${this.reason} (a call to ${JSON.stringify(request.toolName)} was attempted)`,
        { retryable: false },
      ),
    );
  }
}

/**
 * The return type of a client that never returns.
 *
 * `NoModelClient.complete` always rejects, so naming its resolved type `never`
 * says so in the signature rather than in a comment — and keeps the class
 * assignable to `ModelClient`, whose `complete` returns `Promise<ModelResponse>`.
 */
type ModelResponseNever = never;
