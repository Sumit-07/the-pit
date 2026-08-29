/**
 * Building a `BoardSnapshot` — the one part of the snapshot story that needs the
 * engine at runtime, kept apart from the rest of it.
 *
 * `snapshot.ts` holds the envelope, the cache policy, the key layout and the two
 * filesystem/in-memory sinks, and imports the engine for TYPES only. This module
 * imports `ENGINE_VERSION` — a value — because `brief` Part 7 wants the build
 * that produced a ranking recorded on the document it produced.
 *
 * The split is not tidiness. `/boards/<slug>` reads its board through
 * `SnapshotSink` (`lib/boards/source.ts`), and `test/boards-read-path.test.ts`
 * walks the module graph from the public routes and fails if a runtime import of
 * `@the-pit/engine` appears anywhere on it — `brief` Part 3's "reads never touch
 * a model", enforced structurally rather than remembered. Leaving `buildSnapshot`
 * in `snapshot.ts` would put the engine on that graph the moment the read path
 * started using the sink it publishes through, which is the whole fix.
 *
 * Nothing on the read path calls this: a snapshot is BUILT by the `deliver` step
 * and only there.
 */

import { ENGINE_VERSION, type Ranking } from '@the-pit/engine';

import { SNAPSHOT_VERSION, type BoardSnapshot } from './snapshot';

/**
 * Build the snapshot for a delivered run.
 *
 * Takes no client, no store and no network — everything it needs is the ranking
 * the `rank` step already produced.
 */
export function buildSnapshot(input: {
  slug: string;
  ranking: Ranking;
  categoryVersion: string;
  generatedAt: Date;
}): BoardSnapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    slug: input.slug,
    category: input.ranking.category,
    generated_at: input.generatedAt.toISOString(),
    product_count: input.ranking.ranking.length,
    engine_version: ENGINE_VERSION,
    category_version: input.categoryVersion,
    ranking: input.ranking,
  };
}
