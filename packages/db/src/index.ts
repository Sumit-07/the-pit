/**
 * `@the-pit/db` — the Postgres schema, the migrations, and the seed.
 *
 * Importing this module has no side effects and reads no environment: the schema
 * and the seed builder are useful with no database in existence, which is the
 * state this repository is in (`brief` Part 7 budgets Neon; nothing is
 * provisioned). `createDatabase()` is the only thing that touches
 * `DATABASE_URL`, and it does so when it is called.
 */

export * from './schema/index.js';

export type { Database, DatabaseHandle, PostgresJsHandle } from './client.js';
export { createDatabase } from './client.js';

export { DATABASE_URL_ENV, hasDatabaseUrl, MissingDatabaseUrlError, requireDatabaseUrl } from './config.js';

export type {
  AuthAccountRow,
  ConsumeTokenOutcome,
  NewMagicTokenRow,
  PostgresAuthStore,
} from './auth-store.js';
export {
  createPostgresAuthStore,
  sweepExpiredTokens,
  TOKEN_RETENTION_MS,
  tokenRequestsInWindow,
} from './auth-store.js';

export type {
  AttemptRowContext,
  DeliveredVerdict,
  LedgerEntry,
  LedgerEntryReason,
  VerdictRowContext,
} from './identity.js';
export { attemptRow, PAYMENTS_IDENTITY_MAPPING, verdictRow, verdictSlug } from './identity.js';

export type { Migration } from './migrations.js';
export { MIGRATIONS_DIR, readMigrations } from './migrations.js';

export { normalizeUrl } from './normalized-url.js';

export type { SeedInput, SeedRows, SeedSource } from './seed/build.js';
export { buildSeedRows, SEED_APPROVER } from './seed/build.js';
export { deterministicUuid } from './seed/ids.js';
export type { SeedCounts } from './seed/insert.js';
export { insertSeedRows } from './seed/insert.js';
export { DEFAULT_WORKDIR, loadSeedInput, SEEDED_SLUGS } from './seed/load.js';
export type { RehydratedInputs, RehydrateOrder, StoredRows } from './seed/rehydrate.js';
export { rehydrate } from './seed/rehydrate.js';
