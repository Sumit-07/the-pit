/**
 * The one place the orchestrator calls a model.
 *
 * Every phase goes through `dispatch`, which does four things in a fixed order:
 * hands the request to the injected `ModelClient`, bills the call to the phase
 * ledger, validates the answer against its `01 §5` schema, and — if anything went
 * wrong — turns the exception into a `PhaseFailure` the retry policy can read.
 *
 * ## Why this exists as its own module
 *
 * Global Constraint 5 and `docs/plans/phase-1-engine.md` Task 9 both require that
 * NOTHING constructs a client or reaches an SDK outside the injection point.
 * Task 9 adds a third adapter — `HandoffClient`, which writes each would-be
 * request to disk and reads a locally-produced response back — and it becomes a
 * drop-in only if the orchestrator's contact with a model is exactly this
 * function. Concentrating it here also means the truncation demotion below is
 * written once instead of in three phases.
 *
 * ## The truncation demotion
 *
 * `MAX_TOKENS_UNIQUENESS` and `MAX_TOKENS_CHOICE` are derived from an unbounded
 * category size: a big enough category overflows them. `anthropic-client.ts`
 * classifies a `max_tokens` truncation as retryable, which is right at that layer
 * — it cannot know whether the overflow was a one-off. Here it is wrong: the
 * prompt is deterministic, so the same category truncates on every attempt, and a
 * phase retry loop would spend `brief §2.3`'s three free retries reproducing it
 * before dumping the customer in the support queue. So `code: 'max_tokens'` is
 * demoted to a TERMINAL failure with a message naming the budget to raise.
 *
 * The demotion keys on `ModelCallError.code`, never on the error's wording.
 */

import type { ModelClient, ModelRequest } from '../model/types.js';
import { ModelCallError } from '../model/types.js';
import { SchemaValidationError } from '../panels/schemas.js';
import type { PhaseLedger } from './ledger.js';
import type { FailureCode } from './types.js';

/** A dispatched call that came back and validated. */
export interface DispatchOk<T> {
  ok: true;
  value: T;
}

/** A dispatched call that did not. `label` names the juror / persona / pass. */
export interface DispatchFailed {
  ok: false;
  label: string;
  code: FailureCode;
  retryable: boolean;
  message: string;
}

export type DispatchResult<T> = DispatchOk<T> | DispatchFailed;

/**
 * Make one model call, bill it, and validate the answer.
 *
 * Never throws for a model-side or schema-side failure — those are returned, so a
 * phase can fan out with `Promise.all` and still learn about EVERY call that
 * failed rather than only the first one to reject. An engine bug still throws:
 * `internal` failures are not something to keep going through.
 *
 * @param label Identifies the call in a failure message: a juror role and chunk,
 *   a persona name, or the pass name. It is the first thing a person reads when a
 *   run fails, so it must say which call, not just which phase.
 * @param validate Turns the raw tool input into the validated shape. Runs inside
 *   the same try, so a `SchemaValidationError` is classified here rather than
 *   escaping as an unhandled rejection.
 */
export async function dispatch<T>(
  client: ModelClient,
  request: ModelRequest,
  label: string,
  ledger: PhaseLedger,
  validate: (output: unknown) => T,
): Promise<DispatchResult<T>> {
  let output: unknown;
  try {
    const response = await client.complete(request);
    ledger.record(response.model, response.usage);
    output = response.output;
  } catch (error) {
    ledger.recordFailedCall();
    return classifyCallError(error, label);
  }

  try {
    return { ok: true, value: validate(output) };
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      return { ok: false, label, code: 'schema', retryable: true, message: `${label}: ${error.message}` };
    }
    throw error;
  }
}

/** Map a thrown call error onto the phase-level classification. */
function classifyCallError(error: unknown, label: string): DispatchFailed {
  if (error instanceof ModelCallError) {
    if (error.code === 'max_tokens') {
      return {
        ok: false,
        label,
        code: 'truncated',
        // The demotion. Deterministic, so retrying it burns the free-retry budget
        // on a failure that cannot come out differently.
        retryable: false,
        message:
          `${label}: the answer was truncated at max_tokens. This category is too large for the ` +
          'budget this panel was given, so every retry will truncate identically — raise the ' +
          `panel's MAX_TOKENS_* constant or reduce the set. (${error.message})`,
      };
    }
    return { ok: false, label, code: 'model_call', retryable: error.retryable, message: `${label}: ${error.message}` };
  }

  // Not a `ModelCallError`: an adapter that threw something else, or a bug. Not
  // retryable — retrying an unrecognised failure spends money to reproduce it.
  return {
    ok: false,
    label,
    code: 'internal',
    retryable: false,
    message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
