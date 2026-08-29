import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` reads this to turn `src/schema/` into SQL in
 * `migrations/`. It never needs a database: generation diffs the schema against
 * the snapshot in `migrations/meta/`, which is why the whole migration set can
 * be produced and reviewed on a machine with no Postgres on it.
 *
 * `dbCredentials` is deliberately absent. `drizzle-kit push` / `studio` would
 * want it, and neither is used here: `push` skips the migration files, which are
 * the reviewable artifact, and the hand-written guard migration (triggers,
 * partial unique indexes) has no schema-file representation for `push` to diff.
 * Migrations are applied by `src/cli/migrate.ts`, which reads `DATABASE_URL`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
