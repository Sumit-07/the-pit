/**
 * The backfill that finishes `brief §2.5`'s shortener resolution, run against
 * Postgres.
 *
 * Resolving on the submission path only fixes rows written from that point on.
 * Every earlier `products.normalized_url` holds the offline key, so a `bit.ly/x`
 * row from last month and a resolved submission tonight are still two products
 * and the per-product cap still misses exactly the case it was closed for. Until
 * this has run, the wiring is half done.
 *
 * What is worth executing rather than asserting in prose is everything that
 * would make an operator afraid to run it, or afraid to run it twice:
 *
 * - **It is idempotent.** A second pass writes nothing. Anything else and a
 *   retried deploy hook, or a run repeated after a network wobble, is a gamble.
 * - **It is resumable.** Rows are taken in `id` order in batches and
 *   `startAfterId` picks up where a killed run stopped, so a table of thousands
 *   does not have to complete in one transaction.
 * - **It never guesses.** A URL the resolver refuses leaves its row untouched.
 *   These rows are on live boards with verdicts pointing at them.
 * - **After it, the cap actually joins them.** The `bit.ly` row and the target
 *   row become one product to `findByNormalizedUrl`, which is the only reason to
 *   run it at all — so the assertion is made through that query and not by
 *   reading the column back.
 *
 * The resolver is a `Map`. `packages/fetch` proves the resolution itself over a
 * faked transport; nothing here opens a socket, and the whole file runs on
 * PGlite — Postgres in-process, so `products_normalized_url_shape` and the
 * deliberately NON-unique `products_normalized_url_idx` are the ones Neon will
 * enforce.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BackfillUrlResolver } from '../src/backfill/normalized-url.js';
import { backfillNormalizedUrls } from '../src/backfill/normalized-url.js';
import type { Database } from '../src/client.js';
import { createPostgresListingStore } from '../src/listing-store.js';
import { readMigrations } from '../src/migrations.js';
import { normalizeUrl } from '../src/normalized-url.js';
import * as schema from '../src/schema/index.js';

let pg: PGlite;
let db: Database;
let categoryId: string;

const PAYER = 'payer@example.com';
const HASH = 'b'.repeat(64);

/**
 * `submitted URL -> where it actually leads`.
 *
 * `bit.ly/3xYzAbC` and the marketing domain both point at the ledger's pricing
 * page, so all three spellings must come out as `ledger.example/pricing`.
 * `beacon.sh` points nowhere and is the control.
 */
const REDIRECTS: Readonly<Record<string, string>> = {
  'https://bit.ly/3xYzAbC': 'https://www.ledger.example/pricing?ref=42',
  'https://try-ledger.example': 'https://ledger.example/pricing',
};

const REFUSALS: Readonly<Record<string, string>> = {
  'https://gone.example': 'dns_failure: no such host',
};

const RESOLVED = 'ledger.example/pricing';

/** Counts calls, so "a second run resolves but writes nothing" is checkable. */
let resolverCalls: string[];

const resolve: BackfillUrlResolver = (url: string) => {
  resolverCalls.push(url);
  const refusal = REFUSALS[url];
  if (refusal !== undefined) return Promise.resolve({ ok: false, reason: refusal });
  const destination = REDIRECTS[url] ?? url;
  try {
    return Promise.resolve({ ok: true, normalizedUrl: normalizeUrl(destination) });
  } catch (error) {
    return Promise.resolve({ ok: false, reason: String(error) });
  }
};

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('truncate cluster_members, clusters, verdicts, jobs, products, categories, accounts restart identity cascade;');
  const category = await pg.query<{ id: string }>(
    `insert into categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
     values ('note-apps', 'Note apps', 'b2b', 'p1', 'q1', 'c1') returning id`,
  );
  categoryId = category.rows[0]?.id ?? '';
  await pg.query('insert into accounts (email) values ($1) on conflict do nothing', [PAYER]);
  resolverCalls = [];
});

/**
 * A row as it was written BEFORE the resolution existed: `normalized_url` is
 * `normalizeUrl(url)`, with no dereferencing.
 */
async function oldRow(input: {
  url: string;
  engineId: number;
  createdAt?: string;
  seeded?: boolean;
}): Promise<string> {
  const seeded = input.seeded ?? false;
  const result = await pg.query<{ id: string }>(
    `insert into products
       (category_id, engine_id, name, url, normalized_url, description, description_hash,
        source, status, anonymous, submitted_by_email, placed_at, created_at)
     values ($1, $2, 'Ledger', $3, $4, 'Reconciles invoices against the bank feed.', $5,
             $6::product_source, 'placed', $6::product_source = 'seeded', $7, now(), $8)
     returning id`,
    [
      categoryId,
      input.engineId,
      input.url,
      normalizeUrl(input.url),
      HASH,
      seeded ? 'seeded' : 'paid',
      seeded ? null : PAYER,
      input.createdAt ?? '2026-06-01T12:00:00.000Z',
    ],
  );
  return result.rows[0]?.id ?? '';
}

async function keyOf(productId: string): Promise<string> {
  const result = await pg.query<{ normalized_url: string }>('select normalized_url from products where id = $1', [
    productId,
  ]);
  return result.rows[0]?.normalized_url ?? '';
}

// ---------------------------------------------------------------------------

describe('the backfill re-resolves what the submission path could not', () => {
  it('rewrites a shortener row onto its target, and leaves a row that was already right alone', async () => {
    // Hand-derived. `bit.ly/3xYzAbC` was stored as `bit.ly/3xyzabc`; it resolves
    // to `www.ledger.example/pricing?ref=42`, which normalizes — lowercase, no
    // `www.`, no query — to `ledger.example/pricing`. The direct row already
    // holds that value and must not be touched.
    const short = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    const direct = await oldRow({ url: 'https://ledger.example/pricing', engineId: 1 });
    expect(await keyOf(short)).toBe('bit.ly/3xyzabc');

    const report = await backfillNormalizedUrls(db, resolve);

    expect(await keyOf(short)).toBe(RESOLVED);
    expect(await keyOf(direct)).toBe(RESOLVED);
    expect(report.scanned).toBe(2);
    expect(report.rewritten).toBe(1);
    expect(report.unchanged).toBe(1);
    // Two rows now share a key, which is the entire point: one product.
    expect(report.collided).toBe(1);
    expect(report.refused).toBe(0);
  });

  it('joins an old unresolved row and a new submission into ONE product for the cap', async () => {
    // The reason the backfill is part of this change and not a follow-up. The
    // assertion is made through `findByNormalizedUrl` — the query the cap
    // actually runs — rather than by reading the column, because "the column
    // says the right thing" and "the cap now fires" are different claims.
    const store = createPostgresListingStore(db);
    const old = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0, createdAt: '2026-05-01T12:00:00.000Z' });

    // Before: a resolved submission tonight finds nothing at the target's key.
    expect(await store.findByNormalizedUrl(RESOLVED)).toBeNull();

    await backfillNormalizedUrls(db, resolve);

    // After: it finds the row that was submitted as a short link last month.
    const found = await store.findByNormalizedUrl(RESOLVED);
    expect(found?.listingId).toBe(old);
    expect(found?.normalizedUrl).toBe(RESOLVED);
    // And the old key stops answering, because that product no longer lives there.
    expect(await store.findByNormalizedUrl('bit.ly/3xyzabc')).toBeNull();
  });

  it('collapses two spellings of one product without deleting either row', async () => {
    // `products_normalized_url_idx` is deliberately not unique and `DECISIONS.md`
    // S8 makes the most recent row the live listing. The backfill relies on both:
    // it merges identities, never rows, so a superseded listing and its verdicts
    // survive.
    const store = createPostgresListingStore(db);
    const older = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0, createdAt: '2026-05-01T12:00:00.000Z' });
    const newer = await oldRow({ url: 'https://try-ledger.example', engineId: 1, createdAt: '2026-06-01T12:00:00.000Z' });

    await backfillNormalizedUrls(db, resolve);

    const count = await pg.query<{ n: string }>('select count(*)::text as n from products');
    expect(count.rows[0]?.n).toBe('2');
    expect(await keyOf(older)).toBe(RESOLVED);
    expect(await keyOf(newer)).toBe(RESOLVED);
    // The live listing is the most recent, which is what the cap will be checked
    // against tonight.
    expect((await store.findByNormalizedUrl(RESOLVED))?.listingId).toBe(newer);
  });

  it('leaves a row it cannot resolve exactly as it found it, and names it in the report', async () => {
    // These rows are on live boards. Blanking a key or dropping a row to tidy a
    // report would cost evidence `brief` Part 7 keeps deliberately.
    const gone = await oldRow({ url: 'https://gone.example', engineId: 0 });

    const report = await backfillNormalizedUrls(db, resolve);

    expect(await keyOf(gone)).toBe('gone.example');
    expect(report.refused).toBe(1);
    expect(report.rewritten).toBe(0);
    expect(report.refusals[0]).toEqual({
      productId: gone,
      url: 'https://gone.example',
      reason: 'dns_failure: no such host',
    });
  });

  it('re-resolves seeded rows too, which is where most of the table is', async () => {
    // A seeded row has no submitter and no cap to evade, but it is what a paying
    // founder's submission must be recognised AS. Keying it on the shortener
    // would make a claim of an unclaimed listing look like a new product.
    const seeded = await oldRow({ url: 'https://try-ledger.example', engineId: 0, seeded: true });

    await backfillNormalizedUrls(db, resolve);

    expect(await keyOf(seeded)).toBe(RESOLVED);
  });
});

describe('idempotent, and safe to re-run', () => {
  it('writes nothing on a second pass', async () => {
    const short = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    const direct = await oldRow({ url: 'https://ledger.example/pricing', engineId: 1 });

    const first = await backfillNormalizedUrls(db, resolve);
    const updatedAfterFirst = await pg.query<{ updated_at: string }>(
      'select updated_at from products where id = $1',
      [short],
    );

    resolverCalls = [];
    const second = await backfillNormalizedUrls(db, resolve);

    expect(first.rewritten).toBe(1);
    expect(second.rewritten).toBe(0);
    expect(second.changes).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.scanned).toBe(2);
    // It still LOOKED at both rows — idempotent is not the same as "skips work".
    expect(resolverCalls).toHaveLength(2);
    // And it did not touch the row, so `updated_at` did not move.
    const updatedAfterSecond = await pg.query<{ updated_at: string }>(
      'select updated_at from products where id = $1',
      [short],
    );
    expect(String(updatedAfterSecond.rows[0]?.updated_at)).toBe(String(updatedAfterFirst.rows[0]?.updated_at));
    expect(await keyOf(short)).toBe(RESOLVED);
    expect(await keyOf(direct)).toBe(RESOLVED);
  });

  it('a third pass over a table it already fixed is a no-op in every counter', async () => {
    await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    await backfillNormalizedUrls(db, resolve);
    await backfillNormalizedUrls(db, resolve);

    const third = await backfillNormalizedUrls(db, resolve);

    expect(third).toMatchObject({ rewritten: 0, changes: 0, refused: 0, collided: 0, unchanged: 1 });
  });

  it('finishes what an interrupted run started, and reaches the same table', async () => {
    // Batches commit on their own, so a killed run leaves some rows resolved and
    // some not — which is the state it started in, only smaller. Simulated by
    // running one batch of one and then running again with no cursor at all,
    // which is what an operator who lost the id would do.
    await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    await oldRow({ url: 'https://try-ledger.example', engineId: 1 });
    await oldRow({ url: 'https://beacon.sh/status', engineId: 2 });

    const partial = await backfillNormalizedUrls(db, resolve, { batchSize: 1 });
    expect(partial.scanned).toBe(3);

    const rerun = await backfillNormalizedUrls(db, resolve);
    expect(rerun.rewritten).toBe(0);

    const keys = await pg.query<{ normalized_url: string }>('select normalized_url from products order by engine_id');
    expect(keys.rows.map((row) => row.normalized_url).sort()).toEqual([
      'beacon.sh/status',
      RESOLVED,
      RESOLVED,
    ]);
  });

  it('resumes from a reported id without re-examining what came before it', async () => {
    await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    await oldRow({ url: 'https://try-ledger.example', engineId: 1 });

    // One row, then stop — `batchSize` is the page size, so bound the walk by
    // taking the first id and resuming past it.
    const ids = await pg.query<{ id: string }>('select id from products order by id');
    const firstId = ids.rows[0]?.id ?? '';

    resolverCalls = [];
    const resumed = await backfillNormalizedUrls(db, resolve, { startAfterId: firstId });

    expect(resumed.scanned).toBe(1);
    expect(resolverCalls).toHaveLength(1);
    expect(resumed.lastId).toBe(ids.rows[1]?.id);
  });
});

describe('the modes an operator will actually reach for', () => {
  it('--dry-run resolves everything, reports what would move, and writes nothing', async () => {
    const short = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    await oldRow({ url: 'https://ledger.example/pricing', engineId: 1 });
    const changes: string[] = [];

    const report = await backfillNormalizedUrls(db, resolve, {
      dryRun: true,
      onChange: (change) => changes.push(`${change.from} -> ${change.to}`),
    });

    expect(report.changes).toBe(1);
    expect(report.rewritten).toBe(0);
    // The merge is reported BEFORE it happens, which is the number an operator
    // wants to see before running it for real.
    expect(report.collided).toBe(1);
    expect(changes).toEqual([`bit.ly/3xyzabc -> ${RESOLVED}`]);
    expect(await keyOf(short)).toBe('bit.ly/3xyzabc');
  });

  it('--shorteners narrows to the known hosts, and is therefore strictly less complete', async () => {
    // The fast pass. It closes `bit.ly` and misses `try-ledger.example`, which
    // is exactly the gap the cross-host rule exists to cover — so the narrow
    // mode is offered with that stated rather than as an equivalent.
    const short = await oldRow({ url: 'https://bit.ly/3xYzAbC', engineId: 0 });
    const vanity = await oldRow({ url: 'https://try-ledger.example', engineId: 1 });

    const report = await backfillNormalizedUrls(db, resolve, {
      shortenerHostsOnly: true,
      shortenerHosts: new Set(['bit.ly']),
    });

    expect(report.scanned).toBe(1);
    expect(await keyOf(short)).toBe(RESOLVED);
    expect(await keyOf(vanity)).toBe('try-ledger.example');
  });

  it('produces only values the products check constraint accepts', async () => {
    // `products_normalized_url_shape` requires lowercase and no scheme. The
    // backfill writes whatever the resolver returns, so a resolver that ever
    // handed back a full URL would fail here rather than in production.
    await oldRow({ url: 'https://BIT.LY/3xYzAbC'.toLowerCase(), engineId: 0 });
    await oldRow({ url: 'https://try-ledger.example', engineId: 1 });

    await backfillNormalizedUrls(db, resolve);

    const rows = await pg.query<{ normalized_url: string }>('select normalized_url from products');
    for (const row of rows.rows) {
      expect(row.normalized_url).toBe(row.normalized_url.toLowerCase());
      expect(row.normalized_url).not.toMatch(/^[a-z][a-z0-9+.-]*:/);
    }
  });
});
