/**
 * Re-resolve `products.normalized_url` for the rows that predate shortener
 * resolution.
 *
 * ## Why a backfill is part of the change and not a follow-up
 *
 * `brief §2.4`'s per-product cap is a lookup on one indexed column, and
 * `brief §2.5` says which value that column holds: the submitted URL followed to
 * its target. `@the-pit/fetch`'s `resolveProductUrl` produces it and
 * `apps/web`'s submission path now stores it — but only for rows written from
 * that point on. Every earlier row holds the offline key, so a `bit.ly/x` row
 * from last month and a resolved submission tonight are still two products, and
 * the cap still misses exactly the case it was closed for. The wiring is not
 * finished until this has run.
 *
 * ## Idempotent, and safe to re-run
 *
 * The operation is `normalized_url := resolve(url)`, which is a function of the
 * row's own `url` and nothing else — not of the current `normalized_url`, and not
 * of how many times this has run. A second pass re-resolves, finds the stored
 * value already equal, and writes nothing; `rewritten` comes back `0`, which is
 * how a caller can tell a run was a no-op. The `UPDATE` carries `where
 * normalized_url <> :next` so a concurrent run cannot double-write either.
 *
 * It is also safe to INTERRUPT. Rows are taken in `id` order in batches, each
 * batch commits on its own, and `startAfterId` resumes from the last id reported.
 * A run killed halfway leaves a consistent table with some rows resolved and some
 * not — which is precisely the state it started in, only smaller.
 *
 * ## What it refuses to do
 *
 * **It never guesses.** A row whose URL cannot be resolved is left exactly as it
 * is and counted under `refused`. These rows are on live boards with verdicts
 * pointing at them; blanking a key or dropping a row to tidy a report would cost
 * evidence, and `brief` Part 7 keeps the score log as the integrity record. The
 * same reasoning as `cli/migrate.ts`'s missing `down`: a mistake is corrected by
 * another forward pass.
 *
 * **It does not merge rows.** Re-keying two rows onto one value is the whole
 * point — that is what makes the shortener and its target one product — and
 * `products_normalized_url_idx` is deliberately not unique, so both rows survive
 * and `findByNormalizedUrl` returns the most recent, which is what
 * `DECISIONS.md` S8 says the live listing is. A collision is COUNTED (`collided`)
 * because two rows sharing a key is a thing a human should see once, not because
 * anything needs fixing.
 *
 * ## The resolver is injected
 *
 * This module imports nothing that opens a socket. `cli/backfill-urls.ts` binds
 * the real `@the-pit/fetch` fetcher; the tests bind a `Map` and run offline. That
 * is the same seam `packages/fetch` uses for its own transport and resolver, and
 * it is why "the backfill is idempotent" is a property this repository can
 * execute rather than assert.
 */

import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';

/**
 * What the backfill needs from `@the-pit/fetch`, stated as a function so this
 * package keeps performing no I/O of its own.
 *
 * `ok: false` must mean "do not write anything for this row" — the resolver, not
 * the backfill, decides whether an unreachable host falls back to its offline key
 * or refuses outright, because that judgement is `brief §2.5`'s and it already
 * lives in `resolveProductUrl`.
 */
export type BackfillUrlResolver = (
  url: string,
) => Promise<{ readonly ok: true; readonly normalizedUrl: string } | { readonly ok: false; readonly reason: string }>;

export interface BackfillOptions {
  /**
   * Only rows whose current key is on a known shortener host.
   *
   * The narrow pass, for an operator who wants the evasion route closed in
   * minutes rather than the whole table re-fetched. `false` — every row — is the
   * default and the correct one: the cross-host rule catches shorteners nobody
   * has heard of, and a list-driven pass would miss exactly the rows a
   * list-driven detector would have missed.
   */
  readonly shortenerHostsOnly?: boolean;
  /** Hosts `shortenerHostsOnly` selects on. `SHORTENER_HOSTS` from `@the-pit/fetch`. */
  readonly shortenerHosts?: ReadonlySet<string>;
  /** Rows read per round trip. */
  readonly batchSize?: number;
  /** Resume point: only rows with a greater `id`. From a previous run's `lastId`. */
  readonly startAfterId?: string | null;
  /** Resolve and count, write nothing. */
  readonly dryRun?: boolean;
  /** Called once per row that would change, before the write. For a log. */
  readonly onChange?: (change: NormalizedUrlChange) => void;
}

export interface NormalizedUrlChange {
  readonly productId: string;
  readonly url: string;
  readonly from: string;
  readonly to: string;
}

export interface BackfillReport {
  /** Rows read. */
  readonly scanned: number;
  /** Resolved to the value already stored. The steady state, and what a re-run is entirely made of. */
  readonly unchanged: number;
  /** Resolved to a different value and rewritten. `0` under `dryRun`. */
  readonly rewritten: number;
  /** Would have been rewritten. Equals `rewritten` outside `dryRun`. */
  readonly changes: number;
  /** The resolver refused. Left untouched; see the header. */
  readonly refused: number;
  /** Rewritten onto a key another row already holds — now one product, as intended. */
  readonly collided: number;
  /** The last id examined, for `startAfterId`. `null` when nothing was scanned. */
  readonly lastId: string | null;
  /** One line per refusal, capped, so a run's output stays readable. */
  readonly refusals: readonly { readonly productId: string; readonly url: string; readonly reason: string }[];
}

const DEFAULT_BATCH = 200;
const MAX_REPORTED_REFUSALS = 50;

/** `db.execute` is an array under postgres-js and `{ rows }` under some drivers. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** The host of a normalized key: everything before the first `/`, port stripped. */
function hostOf(normalizedUrl: string): string {
  const host = normalizedUrl.split('/')[0] ?? '';
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Walk `products` in `id` order, re-resolving each row's `url` and rewriting
 * `normalized_url` where the answer differs.
 *
 * Returns counts rather than throwing on a refusal: one unreachable product site
 * in a table of a thousand is not a reason to abandon the other nine hundred and
 * ninety-nine, and the refusals are named in the report so the run can be
 * repeated for them later.
 */
export async function backfillNormalizedUrls(
  db: Database,
  resolve: BackfillUrlResolver,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const dryRun = options.dryRun ?? false;
  const shortenerHosts = options.shortenerHosts ?? new Set<string>();
  const shortenerHostsOnly = options.shortenerHostsOnly ?? false;

  let cursor: string | null = options.startAfterId ?? null;
  let scanned = 0;
  let unchanged = 0;
  let rewritten = 0;
  let changes = 0;
  let refused = 0;
  let collided = 0;
  let lastId: string | null = null;
  const refusals: { productId: string; url: string; reason: string }[] = [];

  for (;;) {
    // Ordered by id and paged with a strict `>` cursor, so a row rewritten by
    // this very loop cannot be visited twice and no row can be skipped. Ordering
    // on `normalized_url` would do neither, since that is the column being
    // written.
    const result: unknown = await db.execute(
      cursor === null
        ? sql`select id, url, normalized_url from products order by id limit ${batchSize}`
        : sql`select id, url, normalized_url from products where id > ${cursor} order by id limit ${batchSize}`,
    );
    const batch = rowsOf<Record<string, unknown>>(result);
    if (batch.length === 0) break;

    for (const row of batch) {
      const productId = String(row['id']);
      const url = String(row['url']);
      const current = String(row['normalized_url']);
      cursor = productId;
      lastId = productId;

      if (shortenerHostsOnly && !shortenerHosts.has(hostOf(current))) continue;
      scanned += 1;

      const resolved = await resolve(url);
      if (!resolved.ok) {
        refused += 1;
        if (refusals.length < MAX_REPORTED_REFUSALS) {
          refusals.push({ productId, url, reason: resolved.reason });
        }
        continue;
      }

      if (resolved.normalizedUrl === current) {
        unchanged += 1;
        continue;
      }

      changes += 1;
      options.onChange?.({ productId, url, from: current, to: resolved.normalizedUrl });

      // Asked BEFORE the write and in dry-run too, so `--dry-run` can tell an
      // operator how many products are about to become one. A collision is the
      // intended outcome — the shortener row and the target row joining — and
      // `products_normalized_url_idx` is not unique precisely so it can happen.
      const others: unknown = await db.execute(sql`
        select 1 from products
         where normalized_url = ${resolved.normalizedUrl} and id <> ${productId}
         limit 1
      `);
      const collidedThisRow = rowsOf<unknown>(others).length > 0 ? 1 : 0;
      collided += collidedThisRow;

      if (dryRun) continue;

      // `<>` in the predicate as well as in the branch above: two operators
      // racing the same table both read `current` before either wrote, and the
      // second one's UPDATE should find nothing rather than rewrite an identical
      // value and report a change that did not happen.
      const updated: unknown = await db.execute(sql`
        update products
           set normalized_url = ${resolved.normalizedUrl},
               updated_at = now()
         where id = ${productId}
           and normalized_url <> ${resolved.normalizedUrl}
        returning id
      `);
      if (rowsOf<unknown>(updated).length === 0) {
        // Somebody else got there first with the same answer. Not a change.
        changes -= 1;
        collided -= collidedThisRow;
        unchanged += 1;
        continue;
      }
      rewritten += 1;
    }

    if (batch.length < batchSize) break;
  }

  return { scanned, unchanged, rewritten, changes, refused, collided, lastId, refusals };
}
