/**
 * Where the migration files live, and how to read them without a database.
 *
 * `drizzle-kit generate` writes `migrations/NNNN_name.sql` plus a journal in
 * `migrations/meta/_journal.json` that fixes their order. Drizzle's own migrator
 * reads both when applying them to Postgres. The schema tests apply the SAME
 * files to an in-process PGlite instance, so this module exists to give both
 * paths one answer to "where are they" and "in what order".
 *
 * `MIGRATIONS_DIR` is resolved from this module's own URL rather than from the
 * working directory: the migrations are shipped in the package (`files` in
 * `package.json`), and the process that runs them is a Vercel function or a
 * one-shot script whose cwd is nobody's business.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `migrations/` directory, absolute.
 *
 * `import.meta.url` points at `dist/migrations.js` after a build and at
 * `src/migrations.ts` under a TS runner, so one `..` lands on the package root
 * in both cases.
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** The subset of drizzle-kit's journal this package reads. */
interface Journal {
  entries: { idx: number; tag: string }[];
}

/** One migration file, split into the statements it should be executed as. */
export interface Migration {
  /** The file's name without `.sql`, e.g. `0000_initial_schema`. */
  tag: string;
  /** Statements in file order, `--> statement-breakpoint` markers removed. */
  statements: string[];
}

/**
 * Drizzle-kit's statement separator. It is a comment rather than a `;` because a
 * `;` also appears inside `$$`-quoted PL/pgSQL function bodies, where splitting
 * on it would cut a trigger function in half.
 */
const BREAKPOINT = '--> statement-breakpoint';

/** Read every migration, in journal order. */
export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const journalText = await readFile(join(dir, 'meta', '_journal.json'), 'utf8');
  const journal = JSON.parse(journalText) as Journal;

  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const migrations: Migration[] = [];

  for (const entry of ordered) {
    const sql = await readFile(join(dir, `${entry.tag}.sql`), 'utf8');
    const statements = sql
      .split(BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    migrations.push({ tag: entry.tag, statements });
  }

  return migrations;
}
