/**
 * Resolve every seeded product's favicon and store it beside its board.
 *
 *     pnpm --filter @the-pit/web run favicons
 *     pnpm --filter @the-pit/web run favicons -- --retry-misses
 *     pnpm --filter @the-pit/web run favicons -- developer-tools --refresh
 *
 * The only place in this feature that opens a socket, and it opens it through
 * `@the-pit/fetch`'s `createNodeFetcher` — the same resolver, the same pinned
 * transport, the same address checks on every redirect hop that guard the
 * submission form. There is no second fetch path here and there must never be
 * one; the guards are the reason dereferencing ninety-two URLs a stranger chose
 * is safe at all.
 *
 * It runs under bare Node with type-stripping and a fifteen-line resolver hook
 * (`scripts/ts-resolve.mjs`) rather than a task runner, so the feature adds no
 * dependency to the app it belongs to.
 *
 * ## Checkpointing
 *
 * The index is written back after every settled product, not once at the end.
 * Ninety-two URLs over eight workers takes under a minute, but several of them
 * spend the full five-second budget timing out, and a run killed at second forty
 * should not have to re-do the thirty hosts that already answered. Combined with
 * the skip rules in `resolveBoardFavicons`, that makes the whole thing resumable
 * by just running it again.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createNodeFetcher } from '@the-pit/fetch/node';

import { resolveBoardFavicons, type BackfillEvent, type FaviconTarget } from '../src/lib/boards/favicon-backfill';
import { readFaviconIndex, writeFaviconIndex } from '../src/lib/boards/favicon-store';
import { resolveWorkdir } from '../src/lib/boards/source';

interface Args {
  slugs: string[];
  refresh: boolean;
  retryMisses: boolean;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { slugs: [], refresh: false, retryMisses: false, concurrency: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--refresh') args.refresh = true;
    else if (arg === '--retry-misses') args.retryMisses = true;
    else if (arg === '--concurrency') {
      i += 1;
      args.concurrency = Math.max(1, Number(argv[i] ?? '8') || 8);
    } else if (!arg.startsWith('-')) args.slugs.push(arg);
  }
  return args;
}

/** Every product on one seeded board, as `{ url, name }`. */
async function targetsFor(workdir: string, slug: string): Promise<FaviconTarget[]> {
  const path = join(workdir, 'runs', slug, 'ranking.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    ranking?: { url?: unknown; name?: unknown }[];
  };
  return (raw.ranking ?? [])
    .filter((row): row is { url: string; name: string } => typeof row.url === 'string' && typeof row.name === 'string')
    .map((row) => ({ url: row.url, name: row.name }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workdir = resolveWorkdir();
  const { readdir } = await import('node:fs/promises');
  const slugs =
    args.slugs.length > 0
      ? args.slugs
      : (await readdir(join(workdir, 'runs'), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();

  // One fetcher for the whole run: the caps are the package's own defaults, and
  // a script that lowered them would be a second opinion about them.
  const fetcher = createNodeFetcher();

  let totalProducts = 0;
  let totalResolved = 0;
  let totalStoredBytes = 0;

  for (const slug of slugs) {
    let targets: FaviconTarget[];
    try {
      targets = await targetsFor(workdir, slug);
    } catch {
      console.log(`${slug}: no ranking.json — skipped`);
      continue;
    }
    const existing = await readFaviconIndex(workdir, slug);
    console.log(`\n${slug}: ${targets.length} products (${Object.keys(existing.icons).length} already stored)`);

    // The checkpoint: a copy of the index that this loop keeps up to date as
    // results land, flushed to disk after each one. Serialised through a single
    // promise chain so eight workers finishing at once cannot interleave two
    // writes to the same file.
    const live = { ...existing, icons: { ...existing.icons }, misses: { ...existing.misses } };
    let flush: Promise<void> = Promise.resolve();
    let settled = 0;

    const summary = await resolveBoardFavicons(slug, targets, fetcher, existing, {
      concurrency: args.concurrency,
      refresh: args.refresh,
      retryMisses: args.retryMisses,
      onProgress: (event: BackfillEvent) => {
        settled += 1;
        const head = `  [${String(settled).padStart(3)}/${targets.length}]`;
        const label = event.target.name.slice(0, 44).padEnd(44);
        if (event.kind === 'hit') {
          live.icons[event.target.url] = event.icon;
          delete live.misses[event.target.url];
          console.log(`${head} ok   ${label} ${event.icon.format} ${event.icon.width}x${event.icon.height} ${event.icon.bytes}B`);
        } else if (event.kind === 'miss') {
          live.misses[event.target.url] = event.miss;
          delete live.icons[event.target.url];
          console.log(`${head} --   ${label} ${event.miss.code}: ${event.miss.reason.slice(0, 90)}`);
        } else {
          return;
        }
        live.updatedAt = new Date().toISOString();
        flush = flush.then(() => writeFaviconIndex(workdir, live)).catch(() => undefined);
      },
    });
    await flush;
    // The authoritative write. `summary.index` is the whole answer for this
    // board; the checkpoints above only existed so an interrupted run leaves
    // something to resume from.
    await writeFaviconIndex(workdir, summary.index);

    const stored = Object.values(summary.index.icons);
    const bytes = stored.reduce((total, icon) => total + icon.bytes, 0);
    totalProducts += targets.length;
    totalResolved += stored.length;
    totalStoredBytes += bytes;
    console.log(
      `${slug}: ${stored.length}/${targets.length} resolved · ${(bytes / 1024).toFixed(1)} KB of icon bytes · ` +
        `${summary.resolved} new, ${summary.missed} missed, ${summary.skipped} skipped`,
    );
    for (const [code, count] of countBy(Object.values(summary.index.misses).map((miss) => miss.code))) {
      console.log(`    ${String(count).padStart(3)} × ${code}`);
    }
  }

  console.log(
    `\ntotal: ${totalResolved}/${totalProducts} resolved · ${(totalStoredBytes / 1024).toFixed(1)} KB stored · ` +
      `${(totalStoredBytes / Math.max(1, totalResolved)).toFixed(0)} B average`,
  );
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

await main();
