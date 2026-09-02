/**
 * The seed, end to end, against a real Postgres.
 *
 * This is the test that answers "do the migrations run cleanly against a fresh
 * database, and does the seed load the two existing boards into it" — on a
 * machine with no database. PGlite is Postgres in-process, so the migrations
 * applied here are the ones Neon will apply, and every constraint written in
 * `src/schema/` is enforced against the real seeded rows rather than against a
 * fixture chosen to satisfy them.
 *
 * It runs `insertSeedRows` — the same function `pnpm db:seed` calls, not a copy —
 * which is why `Database` is typed at the driver-independent `PgDatabase` level.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../../src/client.js';
import { readMigrations } from '../../src/migrations.js';
import * as schema from '../../src/schema/index.js';
import { buildSeedRows } from '../../src/seed/build.js';
import { insertSeedRows } from '../../src/seed/insert.js';
import { loadSeedInput, SEEDED_SLUGS } from '../../src/seed/load.js';

const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cjr');

/**
 * Whether the engine's own raw record sits beside both boards. `results.json` is
 * git-ignored (`load.ts`'s header), so this is true on the machine that produced
 * the runs and false in a fresh clone — and `buildSeedRows` takes its exact path
 * or its reconstruct-from-the-board path accordingly.
 */
const hasRawRecords = SEEDED_SLUGS.every((slug) => existsSync(join(WORKDIR, 'runs', slug, 'results.json')));

let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });

  for (const slug of SEEDED_SLUGS) {
    await insertSeedRows(db, buildSeedRows(await loadSeedInput(slug, WORKDIR)));
  }
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

/** `DECISIONS.md` S4. */
const EXPECTED = [
  { slug: 'developer-tools', type: 'b2b', products: 48 },
  { slug: 'health-fitness-wellness', type: 'consumer', products: 44 },
] as const;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await pg.query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

describe('the seeded database', () => {
  it('holds both categories with their archetypes', async () => {
    const rows = await pg.query<{ slug: string; type: string }>(`SELECT slug, type FROM categories ORDER BY slug`);
    expect(rows.rows).toEqual([
      { slug: 'developer-tools', type: 'b2b' },
      { slug: 'health-fitness-wellness', type: 'consumer' },
    ]);
  });

  it.each(EXPECTED)('holds $products products for $slug', async ({ slug, products }) => {
    expect(
      await count(`SELECT count(*) AS count FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = $1`, [
        slug,
      ]),
    ).toBe(products);
  });

  it('holds a raw score log, not just the reduced board', async () => {
    // `02 §7` and `brief` Part 7. Developer Tools is 48 products x 5 metrics x 6
    // jurors; Health, Fitness & Wellness is 44 x 4 x 6 — both read off the
    // installed jury files, whose metric counts `01 §4` Step 2 bounds at 3-6.
    const devTools = await loadSeedInput('developer-tools', WORKDIR);
    const health = await loadSeedInput('health-fitness-wellness', WORKDIR);

    expect(await count(`SELECT count(*) AS count FROM score_rows`)).toBe(
      48 * devTools.jury.metrics.length * 6 + 44 * health.jury.metrics.length * 6,
    );
  });

  it('gives every product exactly one cluster', async () => {
    expect(await count(`SELECT count(*) AS count FROM cluster_members`)).toBe(48 + 44);
    expect(
      await count(`SELECT count(*) AS count FROM (SELECT product_id FROM cluster_members GROUP BY product_id) t`),
    ).toBe(48 + 44);
  });

  it('ranks every product on its board', async () => {
    expect(await count(`SELECT count(*) AS count FROM rankings`)).toBe(48 + 44);
    expect(await count(`SELECT count(*) AS count FROM snapshots`)).toBe(2);
  });

  it('holds demand votes and can name the personas that cast them', async () => {
    expect(await count(`SELECT count(*) AS count FROM demand_votes`)).toBeGreaterThan(0);
    // Both panels have six personas (`01 §4` Step 3's target), and the two share
    // one name — Priya Raghunathan sits on both — so an exact seed names twelve
    // (category, persona) pairs. Seeded from the board alone the count is eleven,
    // and that is the documented lossiness rather than a collapsed pair: a `none`
    // answer attaches to no product's picks and so leaves no trace in
    // `ranking.json` (`build.ts`'s header), and in Health, Fitness & Wellness
    // Marguerite Sallis answered `none` to all eight clusters, so nothing on the
    // board records that she voted at all.
    expect(
      await count(`SELECT count(*) AS count FROM (SELECT DISTINCT category_id, persona_name FROM demand_votes) t`),
    ).toBe(hasRawRecords ? 12 : 11);
  });

  it('leaves the ledger and the auth tables empty — a seeded product was never bought', async () => {
    expect(await count(`SELECT count(*) AS count FROM attempts`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM orders`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM tokens`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM jobs`)).toBe(0);
    // And no accounts: `brief` Part 7 seeds listings as UNCLAIMED, and
    // `products_source_submitter` refuses a seeded row with a submitter, so
    // there is no verified address for the seed to make an account from.
    expect(await count(`SELECT count(*) AS count FROM accounts`)).toBe(0);
  });

  it('gives all 92 listings a public verdict page (brief Part 6)', async () => {
    // 48 + 44 from `DECISIONS.md` S4. This is the cold-start content: every
    // board row resolves to a permanent URL that works logged out, with no job,
    // no payer and no pitch ordinal behind it.
    expect(await count(`SELECT count(*) AS count FROM verdicts`)).toBe(48 + 44);
    expect(await count(`SELECT count(*) AS count FROM verdicts WHERE job_id IS NOT NULL`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM verdicts WHERE account_id IS NOT NULL`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM verdicts WHERE attempt_number IS NOT NULL`)).toBe(0);
    expect(
      await count(`SELECT count(*) AS count FROM (SELECT DISTINCT public_slug FROM verdicts) t`),
    ).toBe(48 + 44);
  });

  it('stamps each verdict with the size of the board it was issued against', async () => {
    // `brief` Part 5's product count. Read per category, because the two boards
    // are different sizes and a verdict that borrowed the other board's count
    // would put a rank against the wrong denominator.
    const rows = await pg.query<{ slug: string; product_count: number; n: string }>(
      `SELECT c.slug, v.product_count, count(*) AS n
         FROM verdicts v
         JOIN products p ON p.id = v.product_id
         JOIN categories c ON c.id = p.category_id
        GROUP BY c.slug, v.product_count ORDER BY c.slug`,
    );
    expect(rows.rows.map((row) => [row.slug, Number(row.product_count), Number(row.n)])).toEqual([
      ['developer-tools', 48, 48],
      ['health-fitness-wellness', 44, 44],
    ]);
  });

  it('refuses to rewrite a seeded verdict, so a cold-start URL is as permanent as a paid one', async () => {
    // The append-only guard, exercised against real seeded rows rather than a
    // fixture. `DECISIONS.md` §1.2 moves the board under these pages on the very
    // first placement; the freeze is what keeps them honest.
    const slug = await pg.query<{ public_slug: string }>(`SELECT public_slug FROM verdicts LIMIT 1`);
    let message: string | null = null;
    try {
      await pg.query(`UPDATE verdicts SET product_count = 1 WHERE public_slug = $1`, [
        slug.rows[0]?.public_slug ?? '',
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/append-only/);
  });

  it('serves a shared link from the slug index alone', async () => {
    // The public page is a lookup on `public_slug` and touches neither the
    // account nor the board — `brief §2.1`: "verdict URLs public", balance and
    // history behind the session.
    const plan = await pg.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT payload FROM verdicts WHERE public_slug = 'nothing-resolves-here'`,
    );
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('verdicts_public_slug_uk');
  });

  it('is idempotent: re-seeding writes nothing new', async () => {
    // Deterministic ids plus ON CONFLICT DO NOTHING. A seed that could only run
    // against an empty database is a seed nobody can re-run after a partial
    // failure.
    const before = await count(`SELECT count(*) AS count FROM score_rows`);
    for (const slug of SEEDED_SLUGS) {
      await insertSeedRows(db, buildSeedRows(await loadSeedInput(slug, WORKDIR)));
    }
    expect(await count(`SELECT count(*) AS count FROM score_rows`)).toBe(before);
    expect(await count(`SELECT count(*) AS count FROM products`)).toBe(48 + 44);
    // Including the append-only table: a re-seed must collide on the primary key
    // and do nothing, because `verdicts` has no UPDATE path to fall back on.
    expect(await count(`SELECT count(*) AS count FROM verdicts`)).toBe(48 + 44);
  });

  it('has a usable normalized_url on every row', async () => {
    // The column the per-product cap keys on (`brief §2.5`). Its check
    // constraints already ran on insert; this asserts none of them was satisfied
    // by an empty string.
    expect(await count(`SELECT count(*) AS count FROM products WHERE normalized_url = ''`)).toBe(0);
    expect(
      await count(`SELECT count(*) AS count FROM products WHERE normalized_url <> lower(normalized_url)`),
    ).toBe(0);
  });

  it('answers "which products share a normalized URL" from the index', async () => {
    // The Phase 3 submission-cap query, run for real against seeded data.
    const plan = await pg.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM products WHERE normalized_url = 'capgo.app'`,
    );
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('products_normalized_url_idx');
  });
});

describe('the raw record survives the round trip through Postgres', () => {
  it.skipIf(!hasRawRecords)('reads back the same score rows it wrote', async () => {
    const input = await loadSeedInput('developer-tools', WORKDIR);
    const built = buildSeedRows(input);

    const stored = await pg.query<{ juror_role: string; metric: string; score: number }>(
      `SELECT s.juror_role, s.metric, s.score
         FROM score_rows s
         JOIN products p ON p.id = s.product_id
         JOIN categories c ON c.id = p.category_id
        WHERE c.slug = 'developer-tools' AND p.engine_id = 6
        ORDER BY s.juror_role, s.metric`,
    );

    const expected = built.scoreRows
      .filter((row) => row.productId === built.products.find((p) => p.engineId === 6)?.id)
      .map((row) => ({ juror_role: row.jurorRole, metric: row.metric, score: row.score }))
      .sort((a, b) => a.juror_role.localeCompare(b.juror_role) || a.metric.localeCompare(b.metric));

    expect(stored.rows.map((row) => ({ ...row, score: Number(row.score) }))).toEqual(expected);
  });
});
