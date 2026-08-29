/**
 * One submission, one placement — the guard that stops a paid run happening
 * twice.
 *
 * ## The window
 *
 * `place-product` is serialized per slug, so two placements against one category
 * cannot interleave. What that does NOT stop is a genuinely new
 * `pit/placement.requested` event for the SAME submission entering the queue
 * while the first one is in flight — a webhook Dodo retried, a status page
 * reloaded into a re-POST, a support replay. Fired in the window between a
 * successful `rank` step and a failed `deliver` step, the second event finds a
 * category whose catalogue has not been extended yet (`products.json` is written
 * last, deliberately), passes `assertPlaceable`, and runs the whole pipeline
 * again.
 *
 * `brief §2.3` protects the customer from that: an attempt is consumed only on
 * delivery, in the transaction that writes the verdict, so they are charged once.
 * It does not protect the INFERENCE. Two placements are twelve juror calls, two
 * clustering passes and two persona rounds for one $5 — and because nobody is
 * double-charged, nobody reports it. It surfaces as an inference bill that does
 * not match the sales count, months later.
 *
 * ## The key already exists; nothing was reading it
 *
 * `packages/payments` computes `jobIdempotencyKey({accountId, normalizedUrl,
 * descriptionHash, cycleId})` at job creation for exactly this — `brief §2.2`'s
 * "idempotency key on job creation so a double-clicked submit doesn't buy twice"
 * — and `packages/db` carries `jobs_idempotency_key_uk`, a UNIQUE index over the
 * column. Two packages, both correct, joined by nothing: the pipeline never saw
 * the key and never looked at the index. This module is the join.
 *
 * The cycle id is IN that key, which is what keeps `brief §2.4`'s re-pitch
 * working: the same product pitched again after the next rebuild is a different
 * cycle, therefore a different key, therefore a different claim and a second run
 * — which is the behaviour `packages/payments/src/listing/repitch.ts` implements
 * and which a guard keyed on the product alone would have silently blocked.
 *
 * ## Claim, then run
 *
 * The claim is taken BEFORE the first step, because a claim taken afterwards
 * guards nothing that costs money. The winner is decided by the unique index, not
 * by a SELECT followed by an INSERT — `packages/payments/src/submission/job.ts`
 * makes the same point about `JobStore.create`, and the race it warns about is
 * precisely the one two concurrent events create.
 */

import type { PhaseVersions } from '@the-pit/engine';

import type { PlacementOutcome } from './placement';

/** The submission a placement is running for. */
export interface PlacementSubmission {
  /**
   * `jobIdempotencyKey` from `@the-pit/payments`: the identity of the SUBMISSION,
   * not of the product and not of the payment. An account that bought three
   * attempts pitches three products against one payment, so the payment cannot be
   * the key; a re-pitch in a later cycle is a different key by construction.
   */
  key: string;
  slug: string;
  /** The four versions this event would run under. Part of the run's identity. */
  versions: PhaseVersions;
  /** The engine id of the product being placed. */
  productId: number;
}

/** Who owns a submission, and what they made of it. */
export interface PlacementClaim {
  /** An opaque identity for the run that owns this key. Only `mine` is worth branching on. */
  runId: string;
  /** True when THIS event owns the key and may spend. False means an earlier one does. */
  mine: boolean;
  /** The owner's finished outcome, when it has one. Absent while the first run is in flight. */
  outcome?: PlacementOutcome;
}

/**
 * Where a submission's claim is recorded.
 *
 * Two methods, and the asymmetry is the point: `claim` must be atomic against a
 * concurrent caller, and `record` need only be durable.
 */
export interface PlacementClaims {
  /**
   * Take the key for this run, or report who already holds it.
   *
   * MUST decide the winner with a unique constraint rather than a read followed
   * by a write. Re-claiming a key this same run already holds is `mine: true` —
   * an Inngest retry of one event has to resume, not be told it is a duplicate.
   */
  claim(submission: PlacementSubmission): Promise<PlacementClaim>;
  /** Record what the owning run produced, so a later duplicate resolves to it. */
  record(submission: PlacementSubmission, outcome: PlacementOutcome): Promise<void>;
}

/**
 * A run's identity, as a string.
 *
 * All four versions plus the product, because those are what make two events the
 * same RUN: an event carrying a bumped `category_snapshot_version` is a different
 * run over a different population (`brief §1.2`), even for the same submission —
 * which is exactly the shape the double-placement takes, since the first
 * placement bumps that version on its way through.
 */
export function placementRunKey(submission: PlacementSubmission): string {
  const { versions: v } = submission;
  return [
    'placement',
    submission.slug,
    String(submission.productId),
    v.category_version,
    v.prompt_version,
    v.persona_version,
    v.engine_version,
  ].join('|');
}

/**
 * Claims held in this process. For tests, and for the filesystem binding.
 *
 * Per-process, exactly like `FilePipelineStore` is per-instance, and for the same
 * reason it is not the production answer: two Vercel lambdas do not share a Map.
 * `PgPlacementClaims` is the durable one, and `storageMode` is what decides which
 * a deployment gets — the same rule, in the same place, as the store and the sink.
 */
export class MemoryPlacementClaims implements PlacementClaims {
  private readonly held = new Map<string, { runId: string; outcome?: PlacementOutcome }>();

  claim(submission: PlacementSubmission): Promise<PlacementClaim> {
    const runId = placementRunKey(submission);
    const existing = this.held.get(submission.key);
    if (existing === undefined) {
      this.held.set(submission.key, { runId });
      return Promise.resolve({ runId, mine: true });
    }
    return Promise.resolve({
      runId: existing.runId,
      mine: existing.runId === runId,
      ...(existing.outcome === undefined ? {} : { outcome: existing.outcome }),
    });
  }

  record(submission: PlacementSubmission, outcome: PlacementOutcome): Promise<void> {
    const runId = placementRunKey(submission);
    const existing = this.held.get(submission.key);
    // Only the owner records. A duplicate that somehow reached here must not
    // overwrite the first placement's answer with its own.
    if (existing !== undefined && existing.runId !== runId) return Promise.resolve();
    this.held.set(submission.key, { runId, outcome });
    return Promise.resolve();
  }
}

/**
 * A second event arrived for a submission whose first placement has not finished.
 *
 * Deliberately an ordinary `Error` and NOT terminal: the honest answer is "come
 * back in a moment", and Inngest's backoff is the mechanism for that. It spends
 * no model calls, so a retry here is free in the only currency that matters.
 * `isTerminalFailure` leaves it retryable, which is the whole reason that
 * classifier keys on a code rather than on a class.
 */
export class PlacementInFlightError extends Error {
  override readonly name = 'PlacementInFlightError';
  readonly runId: string;

  constructor(runId: string) {
    super(
      `this submission is already being placed by run ${JSON.stringify(runId)}, which has not finished. ` +
        'Nothing was spent: a second run for one submission is twelve juror calls, two clustering passes and ' +
        'two persona rounds bought twice for one payment (brief §2.2). Retrying resolves to the first ' +
        "placement's outcome once it lands.",
    );
    this.runId = runId;
  }
}
