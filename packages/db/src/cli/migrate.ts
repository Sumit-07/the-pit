/**
 * Apply every pending migration to `DATABASE_URL`.
 *
 * `pnpm --filter @the-pit/db db:migrate`, after a build.
 *
 * Uses Drizzle's own migrator, which tracks what it has applied in
 * `drizzle.__drizzle_migrations` and is therefore safe to run repeatedly and from
 * a deploy hook. There is no `down`: `brief` Part 7 keeps the score log as the
 * integrity record, and an automated rollback that drops a column drops evidence.
 * A mistake is corrected by a new forward migration.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDatabase } from '../client.js';
import { MissingDatabaseUrlError } from '../config.js';
import { MIGRATIONS_DIR } from '../migrations.js';

async function main(): Promise<void> {
  const handle = createDatabase();
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
    process.stdout.write(`Migrations applied from ${MIGRATIONS_DIR}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // The unset-URL case is a configuration mistake, not a crash: print the
  // message `requireDatabaseUrl` wrote and skip the stack, which would bury it.
  if (error instanceof MissingDatabaseUrlError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exitCode = 1;
});
