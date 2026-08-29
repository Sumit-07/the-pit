/**
 * Where a run's state lives — which is the engine's `RunStore`, unchanged.
 *
 * `brief §2.3` ("retry only the failed phase"), `brief` Part 6 ("someone who
 * closes the tab at 40s returns to live progress") and `the-pit-agent-prompts.md`
 * Phase 2 ("jobs resumable: persist each phase result as it lands, never
 * batch-commit at the end") are three demands on the same state, and the engine
 * already holds it: `packages/engine/src/run/store.ts` writes a version-stamped
 * `PersistedPhase` envelope the moment each phase lands.
 *
 * So this module adds no state of its own. It adds two READS the engine's
 * interface does not expose because the engine never needed them — the CLI reads
 * `results.json` and `ranking.json` off disk itself, in `src/cli/load.ts`, which
 * is not part of the published entry point. The status page and the snapshot
 * publisher need the same two files, so `PipelineStore` is `RunStore` plus those
 * two readers and nothing else.
 *
 * The interface is also the seam where a durable, non-filesystem store plugs in.
 * Vercel's filesystem is ephemeral, so `FilePipelineStore` is the local and
 * CI story; the Postgres-backed implementation belongs to whoever owns
 * `packages/db`'s schema, and it arrives by implementing this interface rather
 * than by changing anything above it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_WORKDIR,
  FileRunStore,
  MemoryRunStore,
  type Ranking,
  type RunResults,
  type RunStore,
} from '@the-pit/engine';

/**
 * The engine's `RunStore` plus the two documents a surface reads back.
 *
 * Both readers return `undefined` for "not written yet" rather than throwing.
 * A run that has not reached its `rank` step has no `results.json`, and that is
 * the normal state of every in-flight run the status page is asked about.
 */
export interface PipelineStore extends RunStore {
  readResults(): Promise<RunResults | undefined>;
  readRanking(): Promise<Ranking | undefined>;
}

/**
 * `cjr/runs/<slug>/` on disk, per `01 §3`.
 *
 * Extends the engine's `FileRunStore` rather than reimplementing its paths, so
 * the layout stays defined in exactly one file. `FileRunStore.path` is the
 * public getter it exposes for precisely this.
 */
export class FilePipelineStore extends FileRunStore implements PipelineStore {
  constructor(category: string, workdir: string = DEFAULT_WORKDIR) {
    super(category, workdir);
  }

  async readResults(): Promise<RunResults | undefined> {
    return (await readJson(join(this.path, 'results.json'))) as RunResults | undefined;
  }

  async readRanking(): Promise<Ranking | undefined> {
    return (await readJson(join(this.path, 'ranking.json'))) as Ranking | undefined;
  }
}

/**
 * The in-memory store, for tests and for a dry local run.
 *
 * `MemoryRunStore` already records `results`, `ranking` and an ordered `writes`
 * log; this only exposes the two reads. The `writes` log is what lets a test
 * assert "persisted as it landed" rather than "persisted eventually" — the claim
 * `the-pit-agent-prompts.md` Phase 2 actually makes.
 */
export class MemoryPipelineStore extends MemoryRunStore implements PipelineStore {
  readResults(): Promise<RunResults | undefined> {
    return Promise.resolve(this.results);
  }

  readRanking(): Promise<Ranking | undefined> {
    return Promise.resolve(this.ranking);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    // A file that has not been written yet is the normal case for an in-flight
    // run. Anything else — a permissions problem, a truncated write — is real and
    // is re-thrown, because reporting it as "not started" would tell a customer
    // their finished run had not begun.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
