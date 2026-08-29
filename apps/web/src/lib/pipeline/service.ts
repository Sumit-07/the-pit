/**
 * The deployment's wiring: which store, which catalogue, which snapshot sink —
 * and the one read the status surfaces share.
 *
 * Kept apart from `inngest.ts` on purpose. The status endpoint and the status
 * page are reads; they must not drag the Inngest SDK into their bundle, and more
 * to the point they must not be able to enqueue anything. `02 §4` puts the same
 * rule on the board: "reads never touch a model". Nothing in this module takes or
 * constructs a `ModelClient`.
 */

import { phaseVersions, type PhaseVersions } from '@the-pit/engine';

import { FileCategorySource, type CategorySource } from './catalog';
import { readRunStatus, type RunStatus } from './status';
import { FileSnapshotSink, type SnapshotSink } from './snapshot';
import { FilePipelineStore, type PipelineStore } from './store';

/** The four things a deployment binds. */
export interface RunnerBindings {
  categories: CategorySource;
  store: (category: string) => PipelineStore;
  snapshots: SnapshotSink;
}

/**
 * `cjr/` on disk and a snapshot directory beside it.
 *
 * `PIT_WORKDIR` and `PIT_SNAPSHOT_ROOT` exist so a deployment can point both at a
 * mounted volume. Vercel's filesystem is ephemeral, so this is the local and CI
 * story; a Postgres-backed `PipelineStore` and a bucket-backed `SnapshotSink`
 * drop in here without anything above them changing.
 */
export function defaultBindings(): RunnerBindings {
  const workdir = process.env['PIT_WORKDIR'] ?? 'cjr';
  const snapshotRoot = process.env['PIT_SNAPSHOT_ROOT'] ?? `${workdir}/public`;
  return {
    categories: new FileCategorySource(workdir),
    store: (category: string) => new FilePipelineStore(category, workdir),
    snapshots: new FileSnapshotSink(snapshotRoot),
  };
}

/** A run whose category is not seeded here — a 404, not a failure. */
export type RunStatusLookup = { found: true; status: RunStatus } | { found: false };

/**
 * The status of one run, reconstructed from its persisted artifacts.
 *
 * The versions come from the installed panels and the requested category version,
 * through the engine's own `phaseVersions` — the same function the pipeline
 * stamps envelopes with. That is what makes "this stored phase is stale" mean the
 * same thing on the page as it does in the next attempt.
 */
export async function loadRunStatus(
  slug: string,
  bindings: RunnerBindings = defaultBindings(),
  categoryVersion?: string,
): Promise<RunStatusLookup> {
  const input = await bindings.categories.load(
    slug,
    categoryVersion === undefined ? {} : { categoryVersion },
  );
  if (input === undefined) return { found: false };

  const versions: PhaseVersions = phaseVersions(input);
  const status = await readRunStatus({
    store: bindings.store(input.category),
    versions,
    snapshots: bindings.snapshots,
  });
  return { found: true, status };
}
