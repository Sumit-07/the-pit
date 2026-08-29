/**
 * The vote cache — `the-pit-agent-prompts.md` Phase 2: "Vote cache keyed on
 * `(juror_id, product_id, prompt_version)` so retries are free."
 *
 * ## It is a view, not a store
 *
 * The temptation here is to write a `votes` table and populate it as each juror
 * answers. That would be a second copy of state the engine already keeps: every
 * juror's scores for every product are in the persisted Score-phase envelope at
 * `cjr/runs/<slug>/phases/score.json`, and each `ScoreLogEntry` carries its own
 * `prompt_version`. Two copies of the same votes is two things to keep in
 * agreement, and the failure mode is the expensive direction — a cache that says
 * "hit" for a phase the engine will re-run charges the customer twice for one
 * board while reporting the retry as free.
 *
 * So this module indexes what is already stored. `size` is a count of rows the
 * engine will NOT re-buy on a retry, derived from the same file the engine reads
 * back, which means the number on the status page cannot disagree with what the
 * next attempt actually does.
 *
 * ## Why the key carries `prompt_version`
 *
 * `01 §4` Step 2 says to bump `prompt_version` on any edit to the rubric or the
 * mandates, and `brief §1.3` exists so that a bump invalidates caches. Keys are
 * built from `ScoreLogEntry.prompt_version` — the version the vote was actually
 * cast under, not the version the run is asking for — so a bumped rubric misses
 * every key by construction. There is no invalidation pass to forget to run.
 *
 * `juror_id` is the juror's `role`. `01 §6.6` and the whole score log identify a
 * juror by role; there is no other id, and inventing one would key the cache on
 * something the stored votes do not carry.
 *
 * ## The Floor's votes
 *
 * Persona choices are cached by the same mechanism one level up: the Customer
 * phase is persisted whole, stamped with `persona_version`, and reused by the
 * same version gate. They are not indexed here because a forced choice is keyed
 * to a `(persona, cluster_id)` pair rather than to a product, and `brief §1.5`
 * makes the cluster roster the thing that invalidates them.
 */

import type { PhaseVersions, ScoreLogEntry, ScoreRow } from '@the-pit/engine';

import { readStoredPhase } from './resume';
import type { PipelineStore } from './store';

/** The stored Score-phase payload this module indexes. */
interface ScorePayload {
  scoreLog: ScoreLogEntry[];
}

/**
 * `(juror_id, product_id, prompt_version)`, rendered.
 *
 * Field-tagged and `|`-separated so a role containing a separator cannot collide
 * with another key, and so a key is readable in a log line without a decoder.
 */
export function voteCacheKey(jurorRole: string, productId: number, promptVersion: string): string {
  return `juror=${jurorRole}|product=${productId}|prompt=${promptVersion}`;
}

/**
 * One juror's scores for one product, as they were stored.
 *
 * The whole `ScoreRow` rather than a number: the row carries every metric, every
 * deduction and its reason, which is what a re-run would have had to pay for.
 */
export interface VoteCache {
  /** Rows a retry does not have to re-buy. */
  readonly size: number;
  get(jurorRole: string, productId: number, promptVersion: string): ScoreRow | undefined;
  has(jurorRole: string, productId: number, promptVersion: string): boolean;
  readonly keys: readonly string[];
}

/** Index a score log by `(juror_id, product_id, prompt_version)`. */
export function buildVoteCache(scoreLog: readonly ScoreLogEntry[]): VoteCache {
  const rows = new Map<string, ScoreRow>();
  for (const entry of scoreLog) {
    for (const row of entry.scores) {
      rows.set(voteCacheKey(entry.juror_role, row.id, entry.prompt_version), row);
    }
  }

  return {
    get size(): number {
      return rows.size;
    },
    get(jurorRole, productId, promptVersion) {
      return rows.get(voteCacheKey(jurorRole, productId, promptVersion));
    },
    has(jurorRole, productId, promptVersion) {
      return rows.has(voteCacheKey(jurorRole, productId, promptVersion));
    },
    get keys(): readonly string[] {
      return [...rows.keys()];
    },
  };
}

/**
 * The votes a retry of this run would not have to re-buy.
 *
 * Reads through `readStoredPhase`, so a Score phase stored under a superseded
 * version is not counted: the engine will re-run it, and a cache that claimed
 * those rows would be promising a saving that is not going to happen. An empty
 * cache is returned for every non-`reusable` state, including a stored failure —
 * `brief §2.3` retries a failed phase in full.
 */
export async function readVoteCache(store: PipelineStore, versions: PhaseVersions): Promise<VoteCache> {
  const stored = await readStoredPhase<ScorePayload>(store, 'score', versions);
  if (stored.state !== 'reusable' || stored.result.status !== 'ok') return buildVoteCache([]);
  return buildVoteCache(stored.result.value.scoreLog);
}
