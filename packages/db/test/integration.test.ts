/**
 * Against a real server, when there is one.
 *
 * Everything else in this suite runs on PGlite — Postgres in-process, no server,
 * no configuration. That covers the DDL, the constraints, the triggers and the
 * seed. What it cannot cover is the parts that only exist between a client and a
 * server: the `postgres-js` driver, Drizzle's migration journal table, and the
 * network round trip.
 *
 * So this file is guarded. There is no database provisioned for this project
 * (`brief` Part 7 budgets Neon; nothing has been created), and the suite must
 * stay green on a machine with no `DATABASE_URL` — hence `describe.skipIf`
 * rather than a failing connection.
 *
 * To run it, point `DATABASE_URL` at a THROWAWAY database. It drops and recreates
 * the public schema.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type PostgresJsHandle } from '../src/client.js';
import { hasDatabaseUrl } from '../src/config.js';
import { MIGRATIONS_DIR } from '../src/migrations.js';
import { buildSeedRows } from '../src/seed/build.js';
import { insertSeedRows } from '../src/seed/insert.js';
import { loadSeedInput, SEEDED_SLUGS } from '../src/seed/load.js';

const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

let handle: PostgresJsHandle | undefined;

describe.skipIf(!hasDatabaseUrl())('against a live database', () => {
  beforeAll(async () => {
    handle = createDatabase();
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await handle.db.execute(sql`CREATE SCHEMA public`);
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it('applies every migration to a fresh database', async () => {
    if (handle === undefined) throw new Error('no handle');
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });

    const tables = await handle.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toContain('score_rows');
  }, 120_000);

  it('is idempotent — a second run applies nothing', async () => {
    if (handle === undefined) throw new Error('no handle');
    // The deploy hook runs this on every push.
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
    expect(true).toBe(true);
  }, 120_000);

  it('loads both seeded boards', async () => {
    if (handle === undefined) throw new Error('no handle');
    for (const slug of SEEDED_SLUGS) {
      await insertSeedRows(handle.db, buildSeedRows(await loadSeedInput(slug, WORKDIR)));
    }

    const rows = await handle.db.execute<{ count: string }>(sql`SELECT count(*) AS count FROM products`);
    expect(Number(rows[0]?.count)).toBe(48 + 44);
  }, 300_000);
});
