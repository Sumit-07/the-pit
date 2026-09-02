/**
 * Where a run actually is — reconstructed from what is persisted, not from what
 * has streamed past since a connection opened.
 *
 * `brief` Part 6: "**Status page** — resumable. Someone who closes the tab at 40s
 * returns to live progress, not a spinner or a dead job."
 *
 * That sentence rules out the obvious implementation. A page that subscribes to
 * an event stream and renders what arrives is correct only for a viewer who was
 * watching from the start; a viewer who reloads at 0:40 has missed the Score
 * phase landing and sees an empty list under a spinner, indistinguishable from a
 * job that died. So state is READ, every time, from the same version-stamped
 * phase envelopes the pipeline persists as each phase lands — the ones
 * `brief §2.3`'s free retry reads back. Polling or SSE then only has to deliver
 * CHANGES to a page that already knows where it stands.
 *
 * ## Honesty about stale phases
 *
 * A phase stored under a superseded `prompt_version` is reported `pending`, with
 * the version that moved named in its detail. It is not progress: the next
 * attempt will re-buy it (`01 §9` rule 5, `brief §1.3`). Reporting it as a
 * completed step would show a customer a run that is 60% done and then take
 * longer than a run that showed 20%, which is worse than showing nothing.
 *
 * ## Nothing here recomputes a rank
 *
 * `02 §4`: reads never touch a model, and the board never computes anything at
 * read time. This module takes no `ModelClient`, and the `rank` and `deliver`
 * steps are reported from the presence of `ranking.json` and of a published
 * snapshot — artifacts, not recomputation.
 */

import type { PhaseName, PhaseVersions } from '@the-pit/engine';

import { customerMessage } from './errors';
import { readStoredPhase, type StoredPhase } from './resume';
import type { SnapshotSink } from './snapshot';
import type { PipelineStore } from './store';
import { PHASE_OF_STEP, PIPELINE_STEPS, type PipelineStep } from './types';
import { readVoteCache } from './vote-cache';

/**
 * What a customer is told the run is doing.
 *
 * `retrying` is a state of its own rather than a flavour of `failed` because
 * `brief §2.3` makes the two mean opposite things to the person watching: a
 * retryable failure is a free retry already under way and costs them nothing,
 * while `needs_support` is the end of the automatic road. Collapsing them would
 * either alarm someone whose run is fine or reassure someone whose run is not.
 */
export type RunState = 'queued' | 'running' | 'retrying' | 'delivered' | 'needs_support';

/** One step, as the page shows it. */
export interface StepStatus {
  step: PipelineStep;
  /**
   * - `pending` — not run yet, or stored under versions that have since moved.
   * - `done` — a persisted `ok`.
   * - `skipped` — a persisted, terminal, SUCCESSFUL non-run (`DECISIONS.md` S11).
   * - `failed` — a persisted failure. `retryable` says whether it is free.
   */
  state: 'pending' | 'done' | 'skipped' | 'failed';
  detail?: string;
  /** Only on `failed`. The engine's classification, never re-derived here. */
  retryable?: boolean;
  /** Model calls the phase made, from its persisted cost. Absent until it has run. */
  calls?: number;
}

/** The whole answer the status endpoint returns. */
export interface RunStatus {
  slug: string;
  state: RunState;
  /** Always five entries, in pipeline order, whether or not they have run. */
  steps: StepStatus[];
  /** Steps finished out of five. What a progress bar reads. */
  completed: number;
  total: number;
  /** The versions this run is being judged under — what a stale stored phase is compared against. */
  versions: PhaseVersions;
  /**
   * Juror votes a retry would not have to re-buy, keyed
   * `(juror_id, product_id, prompt_version)`. The observable form of
   * "the vote cache makes a retried phase nearly free" (`brief` Part 7).
   */
  votes_cached: number;
  /** Set once the board snapshot exists. ISO-8601. */
  delivered_at?: string;
  /** The first failure worth showing, if any. */
  failure?: { step: PipelineStep; message: string; retryable: boolean };
}

/** Everything `readRunStatus` reads. No client, by construction (`02 §4`). */
export interface StatusInput {
  store: PipelineStore;
  versions: PhaseVersions;
  /** Consulted for the `deliver` step. Omitted, `deliver` is reported from `ranking.json` alone. */
  snapshots?: SnapshotSink;
  /**
   * The `category_snapshot_version` this run's board is PUBLISHED under, when it
   * is not the one the run read.
   *
   * A seed run publishes the version it read and needs nothing here. A placement
   * does not: `brief §1.2` moves every z-score the moment a product is appended,
   * so the board that comes out is a different board under a bumped version
   * (`inngest.ts`'s `publishAs`). Comparing the published snapshot against the
   * version the run READ would find a mismatch on every successful placement and
   * report `deliver` as pending forever — the customer's run stuck at four of
   * five, on the page they opened to find out whether it was done.
   *
   * Phases are still judged against `versions`, verbatim. The two stamps mean
   * different things and `pg-store.ts` keeps them apart for the same reason.
   */
  boardVersion?: string;
}

/**
 * A run that has been bought and not yet started — five steps, none of them run.
 *
 * The window between the payment settling and the first phase landing is short
 * and it is the window a buyer is most likely to be looking at, so it gets a real
 * answer rather than a 404. There is nothing persisted to read yet, which is
 * exactly what this says: `queued`, and "Nothing has started yet."
 *
 * Deliberately not "read the category's own run and show that". The seed run's
 * phases are stamped with the same four versions and would be reported as this
 * customer's progress — a full board's worth of finished steps, on a submission
 * that has not been scored.
 */
export function pendingRunStatus(slug: string, versions: PhaseVersions): RunStatus {
  return {
    slug,
    state: 'queued',
    steps: PIPELINE_STEPS.map((step) => ({ step, state: 'pending' })),
    completed: 0,
    total: PIPELINE_STEPS.length,
    versions,
    votes_cached: 0,
  };
}

/** Read the run's real state off its persisted artifacts. */
export async function readRunStatus(input: StatusInput): Promise<RunStatus> {
  const phases = new Map<PipelineStep, StoredPhase<unknown>>();
  for (const [step, phase] of Object.entries(PHASE_OF_STEP) as [PipelineStep, PhaseName][]) {
    phases.set(step, await readStoredPhase(input.store, phase, input.versions));
  }

  const ranking = await input.store.readRanking();
  const snapshot = input.snapshots === undefined ? undefined : await input.snapshots.read(input.store.slug);

  // A `ranking.json` or a snapshot left over from a SUPERSEDED version is not
  // this run's output. Both documents carry the versions they were built under,
  // so the check is a comparison rather than a guess — and without it a bumped
  // rubric would show `rank: done` above three phases that are about to be
  // re-bought, which is the same lie the stale-phase rule above exists to stop.
  const boardVersion = input.boardVersion ?? input.versions.category_version;
  const currentRanking = ranking !== undefined && ranking.prompt_version === input.versions.prompt_version;
  const currentSnapshot =
    snapshot !== undefined &&
    snapshot.category_version === boardVersion &&
    snapshot.ranking.prompt_version === input.versions.prompt_version;

  const steps: StepStatus[] = PIPELINE_STEPS.map((step) => {
    if (step === 'rank') {
      return ranking === undefined || !currentRanking
        ? { step, state: 'pending' }
        : {
            step,
            state: 'done',
            calls: 0,
            detail: `${ranking.ranking.length} ${ranking.ranking.length === 1 ? 'product' : 'products'} ranked`,
          };
    }
    if (step === 'deliver') {
      return snapshot === undefined || !currentSnapshot
        ? { step, state: 'pending' }
        : { step, state: 'done', calls: 0, detail: `board republished ${snapshot.generated_at}` };
    }
    return describePhase(step, phases.get(step) ?? { state: 'absent' });
  });

  const failed = steps.find((step) => step.state === 'failed');
  const completed = steps.filter((step) => step.state === 'done' || step.state === 'skipped').length;

  return {
    slug: input.store.slug,
    state: runState({ steps, failed, snapshot: currentSnapshot }),
    steps,
    completed,
    total: PIPELINE_STEPS.length,
    versions: input.versions,
    votes_cached: (await readVoteCache(input.store, input.versions)).size,
    ...(snapshot === undefined || !currentSnapshot ? {} : { delivered_at: snapshot.generated_at }),
    ...(failed === undefined
      ? {}
      : {
          failure: {
            step: failed.step,
            message: failed.detail ?? 'That step failed.',
            retryable: failed.retryable === true,
          },
        }),
  };
}

/** One stored phase, turned into a line on the page. */
function describePhase(step: PipelineStep, stored: StoredPhase<unknown>): StepStatus {
  switch (stored.state) {
    case 'absent':
      return { step, state: 'pending' };
    case 'unstamped':
      return { step, state: 'pending' };
    case 'stale':
      // Deliberately `pending`. See the module header: this is work that has not
      // survived, and showing it as done makes the remaining time a lie.
      return { step, state: 'pending', detail: `re-running: ${stored.moved.join(' and ')}` };
    case 'failed':
      // `customerMessage`, never `failure.message`: the raw text names providers,
      // tool calls and schema fields, and it was reaching the page a customer
      // watches. The stored failure keeps every word for the support queue.
      return {
        step,
        state: 'failed',
        retryable: stored.result.failure.retryable,
        detail: customerMessage(stored.result.failure),
        calls: stored.result.cost.calls,
      };
    case 'reusable': {
      const result = stored.result;
      if (result.status === 'skipped') {
        return {
          step,
          state: 'skipped',
          calls: result.cost.calls,
          detail: result.skipped === 'no_sets' ? 'complete' : 'no buyer panel for this category',
        };
      }
      return { step, state: 'done', calls: result.cost.calls };
    }
  }
}

/**
 * The one line the page leads with.
 *
 * A terminal failure outranks everything: it is the only state where nothing
 * further happens without a person. A published snapshot means delivered.
 * Otherwise the run is somewhere between queued and running, and a retryable
 * failure sitting in the middle of it is `retrying` — free, and already moving.
 */
function runState(input: { steps: readonly StepStatus[]; failed: StepStatus | undefined; snapshot: boolean }): RunState {
  if (input.failed !== undefined) return input.failed.retryable === true ? 'retrying' : 'needs_support';
  if (input.snapshot) return 'delivered';
  const started = input.steps.some((step) => step.state !== 'pending');
  return started ? 'running' : 'queued';
}
