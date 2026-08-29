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
import type { Jury, PersonaPanel, Product } from '@the-pit/engine';

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

/**
 * Approve a jury and a persona panel for a category, the way `01 §4` Steps 2 and
 * 3 would once a human had fired the two gates.
 *
 * The versions are the panels' own, so a caller can install a panel under a
 * version the category does NOT point at and watch `PgCategorySource` refuse to
 * run — which is the whole reason those are separate columns.
 */
export async function installPanels(
  pg: PGlite,
  categoryId: string,
  panels: { jury: Jury; personas: PersonaPanel },
): Promise<void> {
  await pg.query(
    `INSERT INTO jury_versions (category_id, version, metrics, jurors, approved_by)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 'test-approver')`,
    [categoryId, panels.jury.prompt_version, JSON.stringify(panels.jury.metrics), JSON.stringify(panels.jury.jurors)],
  );
  await pg.query(
    `INSERT INTO persona_versions (category_id, version, personas, approved_by)
     VALUES ($1, $2, $3::jsonb, 'test-approver')`,
    [categoryId, panels.personas.persona_version, JSON.stringify(panels.personas.personas)],
  );
}

/**
 * Put a category's population in `products`.
 *
 * `status` is a parameter because it is load-bearing: `held` is `DECISIONS.md`
 * S9's flag-not-drop and has never been scored, so a source that included it
 * would have the jury score a product no human approved.
 */
export async function installProducts(
  pg: PGlite,
  categoryId: string,
  population: readonly Product[],
  status: 'placed' | 'pending' | 'held' | 'rejected' = 'placed',
): Promise<void> {
  for (const product of population) {
    await pg.query(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seeded', $8, $9)`,
      [
        categoryId,
        product.id,
        product.name,
        product.url,
        product.normalized_url,
        product.description,
        'a'.repeat(64),
        status,
        status === 'placed' ? new Date().toISOString() : null,
      ],
    );
  }
}
