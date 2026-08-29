/**
 * Reading the engine's persisted phase envelopes back — the READ side of the
 * engine's resumability, not a second one.
 *
 * `packages/engine/src/run/run-category.ts` already owns this decision. Its
 * private `resumePhase` reuses a stored phase only when it is `ok` or `skipped`,
 * only when its `phase` field matches, and only when all four of
 * `category_version`, `prompt_version`, `persona_version` and `engine_version`
 * still match the run in progress — because a phase produced under different
 * versions "is a stale answer, not a saving", and delivering it would stamp a
 * board with a rubric that never produced its scores (`01 §9` rule 5,
 * `brief §1.3`).
 *
 * `resumePhase` itself is not exported — it reads and writes through the engine's
 * own store as part of running a category — but the PREDICATE it decides on is,
 * as `versionsMoved`. The pipeline needs that decision in two places the engine
 * has no reason to serve:
 *
 * 1. **Before a phase step spends anything.** The pipeline runs one phase per
 *    Inngest step, so it has to ask "is this phase already bought?" at each step
 *    boundary rather than once inside `runCategory`.
 * 2. **On the status page.** `brief` Part 6 wants a reload mid-run to show where
 *    the run actually is, reconstructed from persisted results. A stored phase
 *    from a superseded `prompt_version` is not progress — it is work the next
 *    attempt will re-buy — and showing it as a green tick would be a lie the
 *    customer notices when the clock keeps running.
 *
 * So this module answers the same question against the same files, in the same
 * format, with the engine's own `versionsMoved` for the version rule and the
 * engine's own `phaseVersions()` for the current stamp. There is no second
 * store, no second envelope, no second version list and no second copy of the
 * rule — what this module adds is the five-armed classification the status page
 * needs, which is presentation rather than policy. A restated predicate would
 * drift, and the whole point of a version-stamped phase is that a stale one is
 * never delivered as fresh.
 *
 * `test/pipeline-resume.test.ts` still pins the two together end to end: for the
 * same stored envelope it asserts that this module's verdict and
 * `runCategory({resume: true})`'s behaviour agree.
 */

import {
  versionsMoved,
  type PersistedPhase,
  type PhaseFailed,
  type PhaseName,
  type PhaseResult,
  type PhaseVersions,
} from '@the-pit/engine';

import type { PipelineStore } from './store';

/**
 * Which of the four versions differ, named for a human — the ENGINE's predicate,
 * re-exported here so the status page and the phase steps read the rule from the
 * same place `resumePhase` does rather than from a copy of it.
 */
export { versionsMoved };

/**
 * What is on disk for one phase, classified.
 *
 * Five arms rather than a boolean, because the status page has to say something
 * different for each of them and "not reusable" collapses four genuinely
 * different situations into one shrug:
 *
 * - `absent` — never run. The ordinary state of a phase in a queued run.
 * - `reusable` — `ok` or `skipped` under the current versions. Free on a retry.
 * - `failed` — stored, and stored as a failure. `brief §2.3` retries it; the
 *   engine deliberately never reuses one, or the retry would be a no-op that
 *   re-reports the original failure forever.
 * - `stale` — a good result under versions that have since moved. `moved` names
 *   which, in the engine's own wording, so the extra spend has a stated reason.
 * - `unstamped` — an envelope with no `versions`. Written before the stamp
 *   existed, or hand-edited. Treated exactly as `stale`.
 */
export type StoredPhase<T> =
  | { state: 'absent' }
  | { state: 'reusable'; result: PhaseResult<T> }
  | { state: 'failed'; result: PhaseFailed }
  | { state: 'stale'; moved: readonly string[] }
  | { state: 'unstamped' };

/**
 * Classify the stored envelope for one phase against the versions this run uses.
 *
 * Never throws for a malformed file: a store that came back with something that
 * is not an envelope is reported `absent`, which makes the phase run again. The
 * alternative — trusting it — is the one outcome that spends a customer's money
 * on a board nobody can vouch for.
 */
export async function readStoredPhase<T>(
  store: PipelineStore,
  phase: PhaseName,
  versions: PhaseVersions,
): Promise<StoredPhase<T>> {
  const stored = await store.readPhase(phase);
  if (stored === null || typeof stored !== 'object') return { state: 'absent' };

  const envelope = stored as Partial<PersistedPhase<T>>;
  const result = envelope.result;
  if (result === null || result === undefined || typeof result !== 'object') return { state: 'absent' };
  if (result.phase !== phase) return { state: 'absent' };

  if (envelope.versions === undefined) return { state: 'unstamped' };
  const moved = versionsMoved(envelope.versions, versions);
  if (moved.length > 0) return { state: 'stale', moved };

  if (result.status === 'failed') return { state: 'failed', result };
  if (result.status !== 'ok' && result.status !== 'skipped') return { state: 'absent' };
  return { state: 'reusable', result };
}

/**
 * The stored phase result if — and only if — the engine would reuse it.
 *
 * The one call a phase step makes before deciding to spend. Everything else in
 * `StoredPhase` is for the status page.
 */
export async function reusableStoredPhase<T>(
  store: PipelineStore,
  phase: PhaseName,
  versions: PhaseVersions,
): Promise<PhaseResult<T> | undefined> {
  const stored = await readStoredPhase<T>(store, phase, versions);
  return stored.state === 'reusable' ? stored.result : undefined;
}
