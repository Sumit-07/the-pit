/**
 * A real Postgres for the durable-store tests, with no server and no
 * `DATABASE_URL`. Not a test file.
 *
 * PGlite is Postgres itself compiled to WebAssembly and run in-process, so these
 * suites execute the SAME DDL and the SAME triggers a Neon deployment will:
 * `snapshots_body_immutable_trg`, `jobs_delivery_immutable_trg`, the
 * `(category_id, engine_id)` unique that pins `Product.id`, and the jsonb `||`
 * merge that keeps two concurrent Round 1 writers from clobbering each other.
 * A mock Drizzle handle would assert none of that — it would assert that this
 * suite's own fake behaves the way this suite's own fake was written to.
 *
 * `packages/db/test/support/pg.ts` does the same thing for the schema tests. It
 * is deliberately not imported: reaching into another package's test directory
 * makes this suite depend on a path that package is free to move, and the setup
 * is six lines.
 */

import { PGlite } from '@electric-sql/pglite';
import { readMigrations } from '@the-pit/db';
import * as schema from '@the-pit/db/schema';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from '@the-pit/db';

/** A migrated database and the handle to close it. */
export interface TestDatabase {
  pg: PGlite;
  db: Database;
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
  return { pg, db: drizzle(pg, { schema }), close: () => pg.close() };
}

/** The installed panels a run needs to exist before it may be enqueued (`01 §4`). */
export interface InstalledCategory {
  slug: string;
  name: string;
  promptVersion: string;
  personaVersion: string;
  categoryVersion: string;
}

/**
 * Install a category, the way an admin approval would.
 *
 * `PgPipelineStore` refuses to run against a slug with no row, so every test that
 * writes anything starts here — which is itself the assertion that the store does
 * not invent a category out of a slug it was handed.
 */
export async function installCategory(pg: PGlite, category: InstalledCategory): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
     VALUES ($1, $2, 'consumer', $3, $4, $5) RETURNING id`,
    [category.slug, category.name, category.promptVersion, category.personaVersion, category.categoryVersion],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`installCategory: ${category.slug} was not inserted`);
  return id;
}
