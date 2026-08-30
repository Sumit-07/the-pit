/**
 * Where a board's icons live on disk: one JSON file per category, beside the
 * `ranking.json` it belongs to.
 *
 *     cjr/runs/<slug>/ranking.json    the engine's ranking, unchanged
 *     cjr/runs/<slug>/favicons.json   this
 *
 * ## Why beside the ranking, and not in `public/`
 *
 * The tempting alternative is 92 files under `apps/web/public/icons/` and an
 * `<img src="/icons/<hash>.png">` in each row. It has real advantages — one
 * request each, content-addressed, cached forever, shared between the homepage
 * and the board — and it is the wrong answer here for one structural reason.
 *
 * `lib/boards/source.ts`'s own header records the bug this repo already had: the
 * write side published boards to a bucket while the read side read a directory,
 * so a paid placement never appeared on the public board and nothing failed. A
 * board document that lives in a bucket and refers to icon files that live in an
 * app build is that same shape again — the board would move without them, and a
 * product placed after the last deploy would point at an icon nobody ever wrote.
 *
 * A sidecar keyed by product URL travels with the board data, is read by the
 * same `readFile` on the same path, and is committed alongside the run it
 * describes. There is one document, and it moves in one piece.
 *
 * ## This file is on the board read path
 *
 * `test/boards-read-path.test.ts` walks the module graph from every public board
 * route. The read half of this module is therefore `node:fs/promises` and JSON
 * and nothing else — no fetcher, no engine, no database. The write half is
 * `writeFile`, called only by the backfill script, which is not reachable from a
 * route.
 *
 * ## Missing is not an error
 *
 * A category with no `favicons.json` is a category whose backfill has not run.
 * Every read here answers with an empty index rather than throwing, exactly as
 * `readJson` next door treats a missing `results.json`: the board renders, every
 * row shows its fallback mark, and running the backfill fills it in.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { emptyFaviconIndex, isFaviconIndex, type FaviconIndex } from './favicon';

/** The file name, in one place, so the reader and the writer cannot disagree. */
export const FAVICON_FILE = 'favicons.json';

export function faviconIndexPath(workdir: string, slug: string): string {
  return join(workdir, 'runs', slug, FAVICON_FILE);
}

/**
 * One board's icon index, or an empty one.
 *
 * Missing, unreadable, malformed and written-by-an-older-version all mean the
 * same thing to a reader: no icons here yet. A board that threw on a
 * half-written index would take the whole homepage down during a backfill.
 */
export async function readFaviconIndex(workdir: string, slug: string): Promise<FaviconIndex> {
  try {
    const raw: unknown = JSON.parse(await readFile(faviconIndexPath(workdir, slug), 'utf8'));
    if (!isFaviconIndex(raw)) return emptyFaviconIndex(slug);
    return raw;
  } catch {
    return emptyFaviconIndex(slug);
  }
}

/**
 * Write the index back.
 *
 * Keys are sorted and the JSON is indented, because this file is committed: an
 * unordered map would produce a diff on every run in which nothing changed, and
 * a diff that is always noise is a diff nobody reads. Sorting is what makes a
 * re-run that resolved nothing new a genuinely EMPTY commit.
 */
export async function writeFaviconIndex(workdir: string, index: FaviconIndex): Promise<void> {
  const path = faviconIndexPath(workdir, index.slug);
  await mkdir(dirname(path), { recursive: true });
  const ordered = {
    version: index.version,
    slug: index.slug,
    updatedAt: index.updatedAt,
    icons: sortKeys(index.icons),
    misses: sortKeys(index.misses),
  };
  await writeFile(path, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
