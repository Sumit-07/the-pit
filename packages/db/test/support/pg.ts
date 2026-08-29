/**
 * A real Postgres for the schema tests, with no server and no `DATABASE_URL`.
 *
 * PGlite is Postgres itself compiled to WebAssembly and run in-process, so these
 * tests execute the SAME DDL a Neon deployment will, and every assertion below
 * reads `pg_catalog` — the constraints and indexes Postgres actually created,
 * not a string match against a `.sql` file. A regex over the generated SQL would
 * pass on DDL Postgres rejects; this cannot.
 *
 * The requirement it satisfies is "schema-level tests that run without a live
 * database". PGlite is not a live database: nothing is provisioned, nothing
 * listens on a port, and the whole instance is discarded with the suite. The
 * genuinely-needs-a-server tests are the ones guarded by
 * `describe.skipIf(!process.env.DATABASE_URL)` in `test/integration.test.ts`.
 */

import { PGlite } from '@electric-sql/pglite';

import { readMigrations } from '../../src/migrations.js';

/** A migrated database, and the handle to close it. */
export interface TestDatabase {
  pg: PGlite;
  close: () => Promise<void>;
}

/** Boot an empty Postgres and apply every migration in journal order. */
export async function migratedDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create();
  const migrations = await readMigrations();

  if (migrations.length === 0) {
    throw new Error('No migrations found. Run `pnpm --filter @the-pit/db db:generate`.');
  }

  for (const migration of migrations) {
    for (const statement of migration.statements) {
      try {
        await pg.exec(statement);
      } catch (cause) {
        throw new Error(`${migration.tag}: ${statement.slice(0, 120)}`, { cause });
      }
    }
  }

  return { pg, close: () => pg.close() };
}

/** Run a statement and return the error message, or `null` if it succeeded. */
export async function expectRejection(pg: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pg.query(sql, params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every constraint on a table, as `pg_constraint` holds it. */
export async function constraintsOf(pg: PGlite, table: string): Promise<Map<string, string>> {
  const result = await pg.query<{ conname: string; def: string }>(
    // `contype = 'n'` is Postgres 17+'s NOT NULL constraint, which is a column
    // property rather than a named rule anyone declared. Excluded so the map
    // holds only what the schema actually names.
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype <> 'n'`,
    [table],
  );
  return new Map(result.rows.map((row) => [row.conname, row.def]));
}

/** Every index on a table, name to definition. */
export async function indexesOf(pg: PGlite, table: string): Promise<Map<string, string>> {
  const result = await pg.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
}

/** Column names of a table, in ordinal order. */
export async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const result = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

/** Every base table in the public schema. */
export async function tablesOf(pg: PGlite): Promise<string[]> {
  const result = await pg.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

/** Enum labels, in declaration order. */
export async function enumLabels(pg: PGlite, name: string): Promise<string[]> {
  const result = await pg.query<{ enumlabel: string }>(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = $1 ORDER BY e.enumsortorder`,
    [name],
  );
  return result.rows.map((row) => row.enumlabel);
}
