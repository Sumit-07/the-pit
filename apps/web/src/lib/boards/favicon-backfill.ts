/**
 * The backfill: resolve a favicon for every product on a board, once, offline.
 *
 * Nothing on a render path calls this. It is driven by
 * `apps/web/scripts/backfill-favicons.ts`, it takes its fetcher as an argument
 * so the whole thing is testable with no socket in sight, and its only output is
 * the sidecar `favicon-store.ts` writes.
 *
 * ## Designed for the web that exists
 *
 * Ninety-two product URLs, fetched from a laptop. What actually happens to them:
 * a third answer instantly, a handful 404, several time out, several redirect
 * twice before answering, a few serve their HTML error page with
 * `Content-Type: image/png`, and one or two serve a 1×1 GIF. **A product with no
 * favicon is the ordinary outcome, not a failure of this program.** So:
 *
 * - Nothing here throws on a miss. A miss is RECORDED, with the code and the
 *   sentence, and the board renders a fallback mark for that row.
 * - Every miss is stored, which is what makes a re-run cheap. Re-asking a dead
 *   host is the same five-second timeout it was the first time, and there are
 *   enough of them to dominate the run.
 *
 * ## Idempotent, and resumable
 *
 * `resolveBoardFavicons` skips any product that already has an icon, and any
 * product with a recorded miss, unless explicitly told otherwise. So:
 *
 * - Running it twice does no network work the second time and produces a
 *   byte-identical file (keys are sorted by the store).
 * - Killing it half way and running it again picks up exactly where it stopped,
 *   because `onProgress` lets the script checkpoint the index to disk as results
 *   land rather than only at the end.
 * - `retryMisses` re-asks the failures without disturbing the hits, which is the
 *   thing you want a week later when three of those hosts have come back.
 *
 * ## Bounded concurrency
 *
 * A previous backfill in this repo was written serially and took five seconds
 * per URL — over seven minutes for ninety-two products, nearly all of it spent
 * waiting. This runs a fixed pool of workers over one shared cursor: the pool
 * size is the only knob, there is no unbounded `Promise.all` over the whole
 * list, and the wall-clock cost falls to roughly the serial time divided by the
 * pool size. Eight is polite — these are ninety-two different hosts, so it is
 * never eight requests at one server — and it takes the run under a minute.
 *
 * ## Two candidates per product, in order
 *
 * 1. Whatever the product's own page declares. `fetchPageMetadata` reads
 *    `<link rel="icon">` out of the `<head>` under the same guards, and already
 *    falls back to `/favicon.ico` on the document's FINAL origin — which matters,
 *    because a product URL that redirects to a different host should be asked for
 *    that host's icon.
 * 2. `/favicon.ico` on the ORIGINALLY submitted origin, when that is a different
 *    URL from the first candidate. This is the case where a page is unreadable
 *    (a JS-only shell, a 403 to a bot user-agent) but the conventional path is
 *    right there.
 *
 * The first candidate that produces a storable image wins. Later candidates are
 * only tried when an earlier one failed, so a site that works costs one page
 * fetch and one icon fetch.
 *
 * ## Four gates, in cost order
 *
 * A candidate has to clear all of them, and they run cheapest first so that the
 * expensive checks only ever see plausible input:
 *
 * 1. `fetchAsset` — the guards, the status, and an image content type decided
 *    from the response headers before a byte of body is read.
 * 2. `inspectImage` — the magic bytes, because the header was a claim. This is
 *    what catches an HTML error page served as `image/png`, a 1×1 pixel and a
 *    banner behind `rel="icon"`.
 * 3. The compressed-weight budget, applied here, on the base64 that will
 *    actually go into a board document.
 *
 * Failing any of them moves to the next candidate rather than ending the
 * product, which is why a site whose declared icon is an SVG can still resolve
 * through its `/favicon.ico`.
 */

import { gzipSync } from 'node:zlib';

import type { FetchOutcome, GuardedFetcher, PageMetadata } from '@the-pit/fetch';
import { fetchPageMetadata } from '@the-pit/fetch';

import { emptyFaviconIndex, type FaviconIndex, type FaviconMiss, type StoredFavicon } from './favicon';
import { FAVICON_WEIGHT_LIMIT, inspectImage } from './favicon-image';

/** The one product fact this needs. Deliberately not a `RankedProduct`. */
export interface FaviconTarget {
  /** The product URL exactly as `ranking.json` spells it. Also the index key. */
  url: string;
  /** For the log line only. */
  name: string;
}

export interface BackfillOptions {
  /** How many products are in flight at once. */
  concurrency?: number;
  /** Re-resolve products that already have a stored icon. */
  refresh?: boolean;
  /** Re-ask products with a recorded miss. */
  retryMisses?: boolean;
  /** Injectable clock, so a test's output is deterministic. */
  now?: () => Date;
  /** Called as each product settles, so the caller can checkpoint. */
  onProgress?: (event: BackfillEvent) => void;
}

export type BackfillEvent =
  | { kind: 'hit'; target: FaviconTarget; icon: StoredFavicon }
  | { kind: 'miss'; target: FaviconTarget; miss: FaviconMiss }
  | { kind: 'skipped'; target: FaviconTarget; because: 'has-icon' | 'known-miss' };

export interface BackfillSummary {
  index: FaviconIndex;
  attempted: number;
  resolved: number;
  missed: number;
  skipped: number;
}

const DEFAULT_CONCURRENCY = 8;

/**
 * Resolve icons for one board, mutating a COPY of the index it was given.
 *
 * The input index is never modified, so a caller holding the on-disk state can
 * compare, and a half-finished run cannot corrupt what was already good.
 */
export async function resolveBoardFavicons(
  slug: string,
  targets: readonly FaviconTarget[],
  fetcher: GuardedFetcher,
  existing: FaviconIndex = emptyFaviconIndex(slug),
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const now = options.now ?? ((): Date => new Date());
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const index: FaviconIndex = {
    ...existing,
    slug,
    icons: { ...existing.icons },
    misses: { ...existing.misses },
  };

  // Deduplicated: two rows sharing a URL are one product with two entries, and
  // asking its server twice would be rude as well as pointless.
  const queue: FaviconTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.url === '' || seen.has(target.url)) continue;
    seen.add(target.url);
    queue.push(target);
  }

  let cursor = 0;
  let resolved = 0;
  let missed = 0;
  let skipped = 0;

  const report = (event: BackfillEvent): void => options.onProgress?.(event);

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue[cursor];
      cursor += 1;
      if (target === undefined) return;

      if (index.icons[target.url] !== undefined && options.refresh !== true) {
        skipped += 1;
        report({ kind: 'skipped', target, because: 'has-icon' });
        continue;
      }
      if (index.misses[target.url] !== undefined && options.retryMisses !== true && options.refresh !== true) {
        skipped += 1;
        report({ kind: 'skipped', target, because: 'known-miss' });
        continue;
      }

      const outcome = await resolveOne(target.url, fetcher, now);
      if (outcome.ok) {
        index.icons[target.url] = outcome.value;
        // A product that has just resolved is no longer a miss. Leaving the old
        // record would make the file say two things about one product.
        delete index.misses[target.url];
        resolved += 1;
        report({ kind: 'hit', target, icon: outcome.value });
      } else {
        index.misses[target.url] = outcome.miss;
        delete index.icons[target.url];
        missed += 1;
        report({ kind: 'miss', target, miss: outcome.miss });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  // Stamped only when something actually settled. A run that resolved nothing
  // new must produce a BYTE-IDENTICAL file: this document is committed beside
  // the board it describes, and a timestamp that moved on every invocation
  // would put a diff in front of a reviewer on every run — the exact noise
  // `writeFaviconIndex`'s key sorting exists to avoid. "When we last learned
  // something" is the useful reading of this field; "when someone last ran the
  // script" is not.
  if (resolved + missed > 0) index.updatedAt = now().toISOString();
  return { index, attempted: resolved + missed, resolved, missed, skipped };
}

type OneOutcome = { ok: true; value: StoredFavicon } | { ok: false; miss: FaviconMiss };

/**
 * One product: read its page for a declared icon, then fall back to the
 * conventional path, and store the first candidate whose BYTES are an icon.
 *
 * The refusal that gets recorded is the LAST one, because the last candidate is
 * the conventional `/favicon.ico` and "404 on /favicon.ico" is the most
 * informative single sentence about a site that has no icon.
 */
export async function resolveOne(productUrl: string, fetcher: GuardedFetcher, now: () => Date): Promise<OneOutcome> {
  const checkedAt = now().toISOString();
  const candidates: string[] = [];
  let lastMiss: FaviconMiss = { code: 'no_candidate', reason: 'no icon URL could be formed for this product', checkedAt };

  const page: FetchOutcome<PageMetadata> = await fetchPageMetadata(productUrl, fetcher);
  if (page.ok) {
    if (page.value.faviconUrl !== undefined) candidates.push(page.value.faviconUrl);
  } else {
    // Not fatal, and worth keeping: when both candidates fail, "the page itself
    // timed out" explains the blank row better than "/favicon.ico 404ed" does.
    lastMiss = { code: page.refusal.code, reason: page.refusal.reason, checkedAt };
  }

  const conventional = defaultIconUrl(productUrl);
  if (conventional !== undefined && !candidates.includes(conventional)) candidates.push(conventional);

  for (const candidate of candidates) {
    const asset = await fetcher.fetchAsset(candidate);
    if (!asset.ok) {
      lastMiss = { code: asset.refusal.code, reason: asset.refusal.reason, checkedAt };
      continue;
    }
    // The header said it was an image. These bytes decide whether it is one.
    const verdict = inspectImage(asset.value.bytes);
    if (!verdict.ok) {
      lastMiss = { code: verdict.code, reason: `${asset.value.finalUrl}: ${verdict.reason}`, checkedAt };
      continue;
    }
    // The last gate, and the one that decides page weight: what this icon costs
    // a reader once the response is compressed. `FAVICON_WEIGHT_LIMIT` says why
    // the budget is measured here rather than on the file size — the short
    // version is that an `.ico` compresses to a third of itself and a PNG does
    // not, so a byte budget prices them backwards.
    //
    // Measured on the base64, because base64 is the form that goes into the
    // document. Rejected rather than truncated: an icon is whole or it is
    // absent, and the board has a considered mark for absent.
    const data = base64(verdict.bytes);
    const weight = gzipSync(Buffer.from(data, 'ascii'), { level: 9 }).byteLength;
    if (weight > FAVICON_WEIGHT_LIMIT) {
      lastMiss = {
        code: 'too_costly',
        reason: `${asset.value.finalUrl}: a ${verdict.width}x${verdict.height} ${verdict.format} costing ${weight} compressed bytes, over the ${FAVICON_WEIGHT_LIMIT}-byte page-weight budget for one row`,
        checkedAt,
      };
      continue;
    }

    return {
      ok: true,
      value: {
        source: asset.value.finalUrl,
        format: verdict.format,
        mime: verdict.mime,
        width: verdict.width,
        height: verdict.height,
        bytes: verdict.bytes.byteLength,
        weight,
        data,
        fetchedAt: checkedAt,
      },
    };
  }

  return { ok: false, miss: lastMiss };
}

/** `/favicon.ico` on the submitted URL's own origin, or nothing if that is not a URL. */
function defaultIconUrl(productUrl: string): string | undefined {
  try {
    const url = new URL(productUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return new URL('/favicon.ico', url.origin).href;
  } catch {
    return undefined;
  }
}

/**
 * Bytes to base64.
 *
 * `Buffer` because this runs on Node under a script and nowhere else — the read
 * path never decodes anything, it concatenates a stored string into a `data:`
 * URL. Keeping the only Buffer in the feature on the write side is what lets
 * `favicon.ts` stay dependency-free.
 */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
