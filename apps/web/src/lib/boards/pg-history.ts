/**
 * The board before this one. Reached ONLY by dynamic import.
 *
 * Same seam as `pg-recent.ts`, for the same reason: `lib/boards/recent.ts` sits
 * on the board read path and may not name `@the-pit/db` as a static edge, so this
 * module is on the far side of an `await import` and is forbidden by name in
 * `test/boards-read-path.test.ts`. In filesystem mode it is never evaluated,
 * `previousRanks` is never called, and every row's movement mark is absent —
 * which is correct, because there is exactly ONE snapshot on disk and a dash
 * against every row would be a claim about a comparison nobody made.
 *
 * ## Why `snapshots.document` and not the `rankings` table
 *
 * `rankings` is the obvious place to look — it is literally `(snapshot_id,
 * product_id, rank)` — and it is the wrong one, because nothing writes it on a
 * placement. `lib/pipeline/pg-store.ts` says so in its own header: a `RunStore`
 * has six methods and none of them is "project the score log", so `score_rows`,
 * `cluster_members`, `demand_votes` and `rankings` are left to the recompute
 * worker, which does not exist yet. The only rows in `rankings` today are the
 * ones `insertSeedRows` put there at cold start. A movement mark derived from it
 * would compare every rebuilt board against the seed, forever, and would report a
 * placement's reshuffle as movement away from a board that is months old.
 *
 * `snapshots.document` is written by `writeRanking` on every placement, in the
 * transaction that also moves `categories.category_snapshot_version`. It is the
 * engine's `Ranking` verbatim, so `document.ranking[].{id, rank}` is the board
 * itself rather than a projection of it that may or may not have been maintained.
 * One read, one column, no join to a table nothing fills.
 *
 * ## "Previous" is addressed by version, not by "second newest"
 *
 * The board on the page came out of the snapshot SINK — a bucket behind a CDN —
 * and carries the `category_version` it was published under. So the current board
 * is located in `snapshots` by that version, and the previous one is the newest
 * row strictly older than it. Taking "the second newest row" instead would be
 * right only while the bucket and the table agree, and wrong in exactly the window
 * where it matters: a placement writes the snapshot row and publishes to the
 * bucket, and a CDN serving the old board for another second would have every row
 * measured against itself.
 *
 * A version that is not in the table returns `undefined` — no comparison, no
 * marks. The alternative is guessing which board this one followed, and a guess
 * printed as `▼2` beside somebody's product is worse than a blank column.
 */

import { and, desc, eq, lt } from 'drizzle-orm';

import { categories, createDatabase, snapshots } from '@the-pit/db';

/** One row of the previous board, reduced to what `rankMovement` compares. */
export interface PreviousRank {
  readonly key: number;
  readonly rank: number;
}

/**
 * The ranks on the board immediately before `currentVersion`, or `undefined`.
 *
 * `undefined` means "there is no previous board to compare against", and it
 * covers three real states that a surface must treat identically: the category
 * has been ranked exactly once, the current board's version is not in this
 * database, and the previous document is not shaped like a ranking. All three
 * render nothing.
 */
export async function previousRanks(
  slug: string,
  currentVersion: string,
): Promise<readonly PreviousRank[] | undefined> {
  const { db } = createDatabase(undefined, 1);

  const [current] = await db
    .select({ createdAt: snapshots.createdAt })
    .from(snapshots)
    .innerJoin(categories, eq(categories.id, snapshots.categoryId))
    .where(and(eq(categories.slug, slug), eq(snapshots.categorySnapshotVersion, currentVersion)))
    .limit(1);
  if (current === undefined) return undefined;

  const [previous] = await db
    .select({ document: snapshots.document })
    .from(snapshots)
    .innerJoin(categories, eq(categories.id, snapshots.categoryId))
    .where(and(eq(categories.slug, slug), lt(snapshots.createdAt, current.createdAt)))
    // `snapshots_category_created_idx` is `(category_id, created_at)`, so this is
    // one index scan taking the row immediately behind the current one.
    .orderBy(desc(snapshots.createdAt))
    .limit(1);
  if (previous === undefined) return undefined;

  return ranksIn(previous.document);
}

/** `document.ranking[].{id, rank}`, or `undefined` if the document is not a ranking. */
function ranksIn(document_: unknown): PreviousRank[] | undefined {
  if (typeof document_ !== 'object' || document_ === null) return undefined;
  const rows = (document_ as { ranking?: unknown }).ranking;
  if (!Array.isArray(rows)) return undefined;

  const ranks: PreviousRank[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { id, rank } = row as { id?: unknown; rank?: unknown };
    if (typeof id === 'number' && typeof rank === 'number') ranks.push({ key: id, rank });
  }
  return ranks;
}
