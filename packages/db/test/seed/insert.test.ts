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
    // Both panels have six personas (`01 §4` Step 3's target).
    expect(
      await count(`SELECT count(*) AS count FROM (SELECT DISTINCT category_id, persona_name FROM demand_votes) t`),
    ).toBe(12);
  });

  it('leaves the ledger and the auth tables empty — a seeded product was never bought', async () => {
    expect(await count(`SELECT count(*) AS count FROM attempts`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM orders`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM tokens`)).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM jobs`)).toBe(0);
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
  const hasRawRecords = SEEDED_SLUGS.every((slug) => existsSync(join(WORKDIR, 'runs', slug, 'results.json')));

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
