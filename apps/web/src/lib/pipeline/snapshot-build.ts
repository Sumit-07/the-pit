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

import { redactRanking } from '@/lib/anon';

import { SNAPSHOT_VERSION, type BoardSnapshot } from './snapshot';

/**
 * The engine ids a ranking is already publishing anonymously.
 *
 * A blank `url` is the sentinel, and it is a reliable one rather than a
 * convention: `products.url` is `NOT NULL` and the engine's `Product.url` is a
 * required field, so no named row can reach a ranking with an empty address. The
 * paid path blanks it in `lib/pipeline/pg-catalog.ts`, BEFORE the panel is asked
 * anything — which is also why a juror never sees an anonymous product's real
 * name and so cannot write it into a deduction reason.
 */
function anonymousIdsIn(ranking: Ranking): number[] {
  return ranking.ranking.filter((row) => row.url === '').map((row) => row.id);
}

/**
 * Build the snapshot for a delivered run.
 *
 * Takes no client, no store and no network — everything it needs is the ranking
 * the `rank` step already produced.
 *
 * ## The redaction happens here, not on the way out to HTML
 *
 * `redactRanking` runs before the document is wrapped, so an anonymous listing's
 * name and URL are absent from the object that is published. That matters because
 * this document is served verbatim: `app/api/boards/[slug]/route.ts` returns the
 * snapshot as JSON, and it is written to a bucket behind a CDN. Redacting only in
 * the HTML renderer would leave the name one `curl` away from anyone who noticed
 * the API — a privacy leak rather than a cosmetic slip.
 *
 * It is idempotent by construction (see `lib/anon/redact.ts`), so running it here
 * over rows `pg-catalog` already anonymized is a no-op that re-derives the same
 * designations rather than a second, different answer.
 */
export function buildSnapshot(input: {
  slug: string;
  ranking: Ranking;
  categoryVersion: string;
  generatedAt: Date;
  /**
   * Which engine ids to publish anonymously. Defaults to the rows the ranking
   * already presents that way, which is what the paid path produces.
   */
  anonymousIds?: readonly number[];
}): BoardSnapshot {
  const anonymousIds = [...(input.anonymousIds ?? anonymousIdsIn(input.ranking))].sort((a, b) => a - b);
  const ranking = redactRanking(input.ranking, anonymousIds, input.slug);

  return {
    snapshot_version: SNAPSHOT_VERSION,
    slug: input.slug,
    category: ranking.category,
    generated_at: input.generatedAt.toISOString(),
    product_count: ranking.ranking.length,
    engine_version: ENGINE_VERSION,
    category_version: input.categoryVersion,
    anonymous_ids: anonymousIds,
    ranking,
  };
}
