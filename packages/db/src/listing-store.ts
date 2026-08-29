/**
 * The one read the submission guards cannot run without: what is already on the
 * board at a normalized URL.
 *
 * ## Why this query exists
 *
 * `brief §2.4` caps submissions at "one pitch per product per recalibration
 * cycle", and `§2.5` says to key that cap on the normalized URL. `§2.4` also
 * requires "materially changed description text" on a re-pitch, and
 * `packages/payments`' `materialChange` needs the PREVIOUS description's tokens
 * to answer that — not its hash. Both rules therefore need one row fetched by one
 * indexed column, and `products_normalized_url_idx` exists for exactly this
 * lookup; `schema/products.ts` says so in its own words.
 *
 * The result is shaped to `ListingSnapshot` in `@the-pit/payments`, structurally
 * rather than by import, for the reason `identity.ts` and `payments-store.ts`
 * already give: `apps/web` depends on this package and must not have the payments
 * package dragged into its published type surface. The web app maps one to the
 * other in a single function, and `test/listing-store.test.ts` pins the field
 * names against that shape.
 *
 * ## Where each field actually comes from, and why not from `submissions`
 *
 * `lastPitchedAt` is the tempting one to read off `submissions.created_at`, and
 * it would be wrong. A `submissions` row is written BEFORE the buyer leaves for
 * Dodo, so keying the cycle lock on it would let anyone lock a product out of
 * tonight's board by opening a checkout and never paying — a self-inflicted
 * lockout for an honest user who changed their mind, and a free griefing lever
 * against anybody else's product. The cap has to hang off a pitch that was
 * actually PAID for, and the first artifact of a paid pitch is the `products`
 * row the placement writes.
 *
 * So, per column:
 *
 * | `ListingSnapshot` | Source | Why |
 * |---|---|---|
 * | `listingId` | `products.id` | the app's identity for a listing |
 * | `accountId` | `accounts.id` via `products.submitted_by_email` | `brief §2.1` — the payer's address is the only identity `products` holds |
 * | `description` | `products.description` | in full: `materialChange` needs tokens |
 * | `attemptNumber` | latest `verdicts.attempt_number`, else 1 for a paid row, else 0 | "counts pitches and not runs" — a free retry does not advance it |
 * | `lastPitchedAt` | `greatest(products.created_at, latest verdicts.delivered_at)`, NULL when seeded | the row's creation is the first pitch; each re-pitch delivers a verdict |
 * | `clusterId` | latest `cluster_members.cluster_id` | `planRepitch`'s `keep_joined_cluster` needs it; the guards do not read it |
 * | `currentVerdictId` | latest `verdicts.id` | what a re-pitch supersedes |
 *
 * A SEEDED listing reports `lastPitchedAt: null` and `attemptNumber: 0`, which is
 * what `guards.ts` documents it must: both the cycle lock and the
 * materially-changed-text rule are rules about RE-pitching, and a founder
 * claiming their own unclaimed row is making a first pitch. Using the seed date
 * would cycle-lock a product nobody has ever pitched; comparing against seed text
 * would reject a founder for being too close to a description somebody else wrote
 * about them.
 *
 * ## What this does NOT do
 *
 * It does not resolve link shorteners. `normalizeUrl` performs no I/O by design
 * (`schema/products.ts` and `packages/engine/src/ingest/normalize-url.ts` both
 * say why: it needs an SSRF-guarded fetcher), so `bit.ly/x` and the address it
 * points at are two different products to this lookup, and the per-product cap
 * does not catch that. It is the largest known evasion route and it is open.
 */

import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/**
 * What is on the board at one normalized URL.
 *
 * Mirrors `ListingSnapshot` in `@the-pit/payments` field for field. See the
 * module header for why it is mirrored rather than imported.
 */
export interface ListingSnapshotRow {
  readonly listingId: string;
  /** Null on a seeded row: `brief` Part 7's unclaimed listings have no submitter. */
  readonly accountId: string | null;
  readonly normalizedUrl: string;
  readonly categorySlug: string;
  /** In full, not hashed — `materialChange` compares tokens. */
  readonly description: string;
  readonly descriptionHash: string;
  /** Paid pitches so far. `0` on a seeded listing, which nobody has pitched. */
  readonly attemptNumber: number;
  /** When the most recent PAID pitch landed, or null if there has never been one. */
  readonly lastPitchedAt: Date | null;
  readonly clusterId: string | null;
  readonly currentVerdictId: string | null;
}

export interface PostgresListingStore {
  /**
   * The listing at this normalized URL, or `null` if the product has never been
   * on a board.
   *
   * `products_normalized_url_idx` is deliberately NOT unique — `schema/products.ts`
   * explains that a re-pitch can legitimately leave two rows sharing a URL while
   * one is superseded — so this takes the most recently created row, which is the
   * live listing under every reading of `DECISIONS.md` S8.
   */
  findByNormalizedUrl(normalizedUrl: string): Promise<ListingSnapshotRow | null>;
}

/** `db.execute` is an array under postgres-js and `{ rows }` under some drivers. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function int(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function nullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function createPostgresListingStore(db: Database): PostgresListingStore {
  return {
    async findByNormalizedUrl(normalizedUrl: string): Promise<ListingSnapshotRow | null> {
      if (normalizedUrl === '') return null;

      const result: unknown = await db.execute(sql`
        select p.id, p.normalized_url, p.description, p.description_hash, p.source,
               p.created_at, c.slug as category_slug, a.id as account_id,
               v.id as verdict_id, v.attempt_number, v.delivered_at,
               cm.cluster_id
          from products p
          join categories c on c.id = p.category_id
          -- The payer's address resolved to an account INSIDE the statement, the
          -- same way account-store.ts does it: a caller that supplied both would
          -- be trusted about the pairing.
          left join accounts a on a.email = p.submitted_by_email
          left join lateral (
                 select id, attempt_number, delivered_at
                   from verdicts
                  where product_id = p.id
                  order by delivered_at desc
                  limit 1
               ) v on true
          left join lateral (
                 select cluster_id
                   from cluster_members
                  where product_id = p.id
                  order by created_at desc
                  limit 1
               ) cm on true
         where p.normalized_url = ${normalizedUrl}
         order by p.created_at desc, p.id
         limit 1
      `);

      const row = rowsOf<Record<string, unknown>>(result)[0];
      if (row === undefined) return null;

      const seeded = String(row['source']) === 'seeded';
      const delivered = nullableDate(row['delivered_at']);
      const created = nullableDate(row['created_at']);

      // A seeded row has never been pitched. Both nulls below are load-bearing:
      // `checkSubmissionLocal` skips the cycle lock AND the material-change rule
      // when `lastPitchedAt` is null, which is what makes claiming an unclaimed
      // listing a first pitch rather than a re-pitch. See the module header.
      const lastPitchedAt = seeded ? null : latest(created, delivered);

      const storedAttempt = row['attempt_number'];
      const attemptNumber = seeded
        ? 0
        : storedAttempt === null || storedAttempt === undefined
          ? // Paid, placed, and no verdict delivered yet: one pitch has happened.
            1
          : int(storedAttempt);

      return {
        listingId: String(row['id']),
        accountId: nullableText(row['account_id']),
        normalizedUrl: String(row['normalized_url']),
        categorySlug: String(row['category_slug']),
        description: String(row['description']),
        descriptionHash: String(row['description_hash']),
        attemptNumber,
        lastPitchedAt,
        clusterId: nullableText(row['cluster_id']),
        currentVerdictId: nullableText(row['verdict_id']),
      };
    },
  };
}

/** The later of two instants, ignoring nulls. `GREATEST`, in TypeScript. */
function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
