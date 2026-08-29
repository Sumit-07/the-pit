/**
 * The database connection, created on demand and never at import time.
 *
 * Importing `@the-pit/db` must stay free of side effects: the schema, the seed
 * builder and the types are all useful with no database in existence, and
 * `next build` imports server modules to trace them. A connection opened at
 * module scope would turn a missing `DATABASE_URL` into a build failure and a
 * present one into an idle connection per Vercel lambda cold start.
 */

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { requireDatabaseUrl } from './config.js';
import * as schema from './schema/index.js';

/**
 * The Drizzle handle the app queries through, stated at the driver-independent
 * `PgDatabase` level rather than as `PostgresJsDatabase`.
 *
 * Both are the same API; naming the general one is what lets the schema tests
 * run the real insert path — `insertSeedRows` and everything else that takes a
 * `Database` — against the in-process Postgres in `test/support/pg.ts`, with no
 * server and no `DATABASE_URL`. A handle typed to one driver would have forced
 * either a cast in the tests or a second copy of the insert path, and a second
 * copy is not the one that ships.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A connection and the handle over it. Close the connection when you are done with it. */
export interface DatabaseHandle {
  db: Database;
  /** The underlying pool. `close()` it in scripts; leave it open in a server. */
  close: () => Promise<void>;
}

/**
 * The same connection, typed to the driver.
 *
 * Only the migrator needs this: `drizzle-orm/postgres-js/migrator` is written
 * against `PostgresJsDatabase` specifically, since applying a migration is a
 * driver-level operation rather than a query.
 */
export interface PostgresJsHandle extends DatabaseHandle {
  db: PostgresJsDatabase<typeof schema>;
}

/**
 * Open a connection.
 *
 * Throws `MissingDatabaseUrlError` when `DATABASE_URL` is unset — deliberately at
 * the call, so the message names the caller rather than surfacing as a module
 * that failed to load.
 *
 * @param url Override the connection string; defaults to `DATABASE_URL`.
 * @param max Pool size. One for a script, small for a serverless function: Neon's
 *   pooled endpoint multiplexes, and a large per-lambda pool exhausts it.
 */
export function createDatabase(url?: string, max = 1): PostgresJsHandle {
  const connectionString = url ?? requireDatabaseUrl();
  const sql = postgres(connectionString, { max, onnotice: () => {} });
  return {
    db: drizzle(sql, { schema }),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
