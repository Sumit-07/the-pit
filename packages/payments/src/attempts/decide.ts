/**
 * The one function that decides whether a customer is charged.
 *
 * ## It reads the engine's unions and nothing else
 *
 * `packages/engine/src/run/types.ts` already did the hard part. `RunOutcome`'s
 * failed arm carries no `ranking` field at all, so "never deliver a degraded
 * verdict" is a type error rather than a rule; `PhaseResult` is a three-armed
 * union whose `skipped` arm is a terminal SUCCESS; and `PhaseFailure.retryable`
 * is already `brief §2.3`'s free-retry classification, set by the phase that
 * made the failing call.
 *
 * So this module does not re-derive any of that. It does not look at the
 * ranking, does not look at `demand_status`, does not check whether the cluster
 * id came back `'unclustered'`. Every one of those is a legitimate state of a
 * perfectly good run: `DECISIONS.md` S3 and S11 make a solo cluster a normal,
 * common delivery — 32 of 48 Developer Tools products and 26 of 44 Health &
 * Fitness products have no cluster peers — and the Customer phase says so itself
 * with `skipped: 'no_sets'`. Reading the ranking backwards to guess at
 * deliver-vs-retry would refund the common case and charge for the broken one.
 *
 * ## Deciding and doing are separate
 *
 * This function is pure and spends nothing. `AttemptsLedger.settle` performs
 * what it decided, and only the `consume` arm ever reaches the ledger — inside
 * the same transaction as the verdict write, per `brief §2.3`.
 */

import type { IncrementalOutcome, PhaseFailure, PhaseName, RunOutcome, RunResults } from '@the-pit/engine';

/**
 * `brief §2.3`: cap free retries at 3 per attempt, then route to a support
 * queue. Counted per ATTEMPT rather than per account or per day, because the
 * thing being protected is the compute one $5 buys — "otherwise a user can burn
 * compute by killing the connection repeatedly".
 *
 * Three retries means a run may execute up to four times: the original plus
 * three. The vote cache makes each retry re-buy only the phase that failed, so
 * the exposure is bounded well below four full runs.
 */
export const FREE_RETRY_CAP = 3;

/** What the pipeline hands us when a run reaches a terminal state. */
export type PipelineOutcome = RunOutcome | IncrementalOutcome;

/** Why a run is going to a human instead of back through the pipeline. */
export type SupportReason =
  /** Retryable, but this attempt has already had its three free retries. */
  | 'retry_cap_exhausted'
  /** At least one failure will fail identically forever; retrying spends money to reproduce a bug. */
  | 'terminal_failure';

/**
 * What to do about the attempt.
 *
 * `consumesAttempt` is on every arm, and is `true` on exactly one of them. It is
 * redundant with the discriminant on purpose: it is the field a reviewer scans
 * for, and the field a test can assert on every arm at once, so a future arm
 * added without thinking about the money path cannot default into charging.
 */
export type AttemptDecision =
  | {
      readonly action: 'consume';
      readonly consumesAttempt: true;
      /** Present so the caller can log WHY without re-deriving it. */
      readonly customerPhase: 'convened' | 'skipped';
    }
  | {
      readonly action: 'free_retry';
      readonly consumesAttempt: false;
      /** `brief §2.3`: retry only the failed phase. Completed phases are cached. */
      readonly retryPhases: readonly PhaseName[];
      readonly freeRetriesUsed: number;
      readonly freeRetriesRemaining: number;
      readonly failures: readonly PhaseFailure[];
    }
  | {
      readonly action: 'support_queue';
      readonly consumesAttempt: false;
      readonly reason: SupportReason;
      readonly failures: readonly PhaseFailure[];
      readonly retryPhases: readonly PhaseName[];
    }
  | {
      readonly action: 'moderation_queue';
      readonly consumesAttempt: false;
      /** The injection-shaped phrase the input gate matched (`DECISIONS.md` S9). */
      readonly matched: string;
    };

export interface AttemptDecisionInput {
  readonly outcome: PipelineOutcome;
  /**
   * Free retries already spent on THIS attempt, not on this account. Zero on a
   * first run. The caller owns this counter; it belongs on the job row, so a
   * crashed worker cannot lose it and a new job cannot inherit it.
   */
  readonly freeRetriesUsed: number;
  /** Overridable so a test can prove the cap is enforced rather than coincidental. */
  readonly freeRetryCap?: number;
}

const PHASE_ORDER: readonly PhaseName[] = ['score', 'uniqueness', 'customer'];

/**
 * Which phases came back `failed`, in pipeline order.
 *
 * Read off `results.meta.phases` rather than off `outcome.failures`, because
 * `PhaseFailure` carries a code and its causes but not the phase it came from,
 * and "retry only the failed phase" needs the phase name. A phase that is `ok`
 * or `skipped` is not in this list, which is precisely what makes the retry
 * cheap: `runCategory`'s `resume` reads the persisted envelopes back and
 * re-buys nothing that already succeeded.
 */
export function failedPhases(results: RunResults): readonly PhaseName[] {
  return PHASE_ORDER.filter((phase) => results.meta.phases[phase].status === 'failed');
}

/**
 * Decide what happens to the attempt. Pure; makes no call and writes nothing.
 *
 * The four outcomes, and the rule each one comes from:
 *
 * - a delivered/placed run consumes the attempt (`brief §2.3`) — INCLUDING one
 *   whose Customer phase skipped with `no_sets`, which is `DECISIONS.md` S11's
 *   solo cluster and the common case, not an edge case;
 * - a retryable failure is a FREE retry (`brief §2.3`) until the cap;
 * - a terminal failure, or one past the cap, goes to a human;
 * - a held submission goes to moderation with the attempt untouched — the
 *   `DECISIONS.md` S9 input gate fired before anything was spent, and retrying
 *   would match the same phrase forever.
 */
export function decideAttempt(input: AttemptDecisionInput): AttemptDecision {
  const { outcome } = input;

  if (outcome.status === 'held') {
    return { action: 'moderation_queue', consumesAttempt: false, matched: outcome.matched };
  }

  if (outcome.status === 'delivered' || outcome.status === 'placed') {
    return {
      action: 'consume',
      consumesAttempt: true,
      customerPhase: outcome.results.meta.phases.customer.status === 'skipped' ? 'skipped' : 'convened',
    };
  }

  const retryPhases = failedPhases(outcome.results);
  const cap = input.freeRetryCap ?? FREE_RETRY_CAP;

  if (!outcome.retryable) {
    return {
      action: 'support_queue',
      consumesAttempt: false,
      reason: 'terminal_failure',
      failures: outcome.failures,
      retryPhases,
    };
  }

  if (input.freeRetriesUsed >= cap) {
    return {
      action: 'support_queue',
      consumesAttempt: false,
      reason: 'retry_cap_exhausted',
      failures: outcome.failures,
      retryPhases,
    };
  }

  const used = input.freeRetriesUsed + 1;
  return {
    action: 'free_retry',
    consumesAttempt: false,
    retryPhases,
    freeRetriesUsed: used,
    freeRetriesRemaining: cap - used,
    failures: outcome.failures,
  };
}
