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
 * `isTerminalFailure` extends the same *method* — not the classification — to
 * failures the engine never sees, because they come from storage rather than
 * from a model. It reads an error CODE, exactly as `dispatch` does, and the codes
 * it treats as terminal are listed in one constant below.
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
 * What a customer is told a failure was.
 *
 * `PhaseFailure.message` is written for whoever has to fix the run: it names the
 * provider, the tool that was called, the schema field that did not parse. That
 * text was reaching `/status` verbatim — `NoModelClient` alone puts
 * `a call to "score_product" was attempted` in front of somebody who paid five
 * dollars and is watching a progress bar. A person waiting on a run needs to know
 * whether it is coming back, and nothing else; the diagnosis belongs in the
 * support queue, which reads the stored `PhaseFailure` and still has every word
 * of it.
 *
 * Keyed on `FailureCode`, exactly as `dispatch.ts` classifies retryability, so
 * this is a lookup and never a scan of message wording. An unrecognised code
 * falls through to the generic line rather than leaking the raw text as a
 * default — a new code should read as a plain failure until somebody writes it a
 * sentence, not as a paragraph of engine prose.
 *
 * Nothing here changes retry behaviour. `retryable` is still the engine's, and
 * `PhaseFailedError.message` still carries the raw text for logs and telemetry.
 */
const CUSTOMER_MESSAGE: Record<PhaseFailure['code'], string> = {
  model_call: 'That step timed out.',
  schema: 'That step failed.',
  truncated: 'That step failed.',
  incomplete_panel: 'Part of the panel did not answer.',
  internal: 'That step failed.',
};

/** The generic line, for a code this module has not been taught. */
const CUSTOMER_FALLBACK = 'That step failed.';

/**
 * One stored failure, as the sentence `/status` shows.
 *
 * Never the raw message. See `CUSTOMER_MESSAGE`.
 */
export function customerMessage(failure: Pick<PhaseFailure, 'code'>): string {
  return CUSTOMER_MESSAGE[failure.code] ?? CUSTOMER_FALLBACK;
}

/**
 * The one storage fault that is deterministic, and therefore terminal.
 *
 * `PgPipelineStore.writeRanking` throws `SnapshotVersionConflictError` when the
 * board this run produced disagrees with the board already stored under its
 * `category_snapshot_version` — `snapshots_category_version_uk` allows one board
 * per population version and `snapshots_body_immutable_trg` refuses to edit it.
 *
 * Nothing about that comes out differently on a second attempt: the run would
 * recompute the same arithmetic over the same stored rows and hit the same
 * unique. The fix is an operator's (bump `categories.category_snapshot_version`
 * and re-enqueue), and until it is made, every retry is `brief §2.3`'s free-retry
 * budget being spent reproducing a failure that cannot recover.
 *
 * Declared HERE rather than beside the error class so that the classifier and
 * the thrower share one constant without the classifier importing `@the-pit/db`.
 */
export const SNAPSHOT_VERSION_CONFLICT = 'snapshot_version_conflict';

/**
 * Error codes that are terminal wherever they surface.
 *
 * A list rather than a single check because the next deterministic storage fault
 * belongs on it, and because being able to read the whole list in one place is
 * what stops the second one being classified by wording.
 */
const TERMINAL_CODES: readonly string[] = [SNAPSHOT_VERSION_CONFLICT];

/**
 * Is this failure one that cannot come out differently on a retry?
 *
 * Two sources, and only two:
 *
 * 1. A `PhaseFailedError` that already carries the engine's verdict. Nothing is
 *    re-decided here; `retryable` is copied off `PhaseFailure.retryable`.
 * 2. An error carrying a `code` on `TERMINAL_CODES`.
 *
 * The second arm keys on a CODE, never on message wording — the same rule
 * `packages/engine/src/run/dispatch.ts` follows when it demotes a `max_tokens`
 * truncation, and for the same reason: a message is prose that a later edit will
 * reword, and a classifier that reads prose silently stops classifying.
 *
 * Structural rather than `instanceof`, because the throwers live behind
 * `@the-pit/db` and this module is imported by every part of the pipeline that
 * must not load a database driver.
 */
export function isTerminalFailure(error: unknown): boolean {
  if (error instanceof PhaseFailedError) return !error.retryable;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && TERMINAL_CODES.includes(code);
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
