/**
 * The `AuthStore` registration the identity schema owes `@the-pit/auth`.
 *
 * `packages/auth` deliberately knows nothing about Postgres, and
 * `packages/db/src/auth-store.ts` holds the three statements — the SQL is a
 * claim about `tokens` and `accounts`, so it lives next to those tables where
 * the schema tests execute it against a real Postgres. This file is the wire
 * between them, and the whole of it.
 *
 * ## One connection per server instance
 *
 * `authDeps()` runs on every request. `createDatabase()` opens a pool, so
 * calling it per request would open one per request; the handle is memoized at
 * module scope instead. Module scope, not import time — `createDatabase()` reads
 * `DATABASE_URL` and `next build` imports server modules to trace them, so
 * connecting at import would turn a missing variable into a build failure.
 *
 * `max: 1` because `brief` Part 7 puts this on Vercel behind Neon: each lambda
 * is its own process, Neon's pooled endpoint multiplexes, and a large per-lambda
 * pool exhausts it.
 *
 * `registerAuthStore()` is called with this in `config.ts`'s `resolveStore()`.
 * The registration seam is unchanged — an explicit `registerAuthStore(...)` from
 * a test or a startup hook still wins — and this is only what the app falls back
 * to when a `DATABASE_URL` exists and nobody registered anything.
 *
 * ## Nothing here closes the pool
 *
 * A serverless instance is reused across requests and frozen between them;
 * closing after each one would reconnect on every invocation, and there is no
 * shutdown hook to close it in. The pool dies with the instance.
 */

import { mintCapabilitySlug } from '@the-pit/auth';
import {
  createDatabase,
  createPostgresAuthStore,
  createPostgresIdentityStore,
  type Database,
  type PostgresAuthStore,
  type PostgresHandoffStore,
  type PostgresIdentityStore,
} from '@the-pit/db';

let store: PostgresAuthStore | null = null;
let identities: (PostgresIdentityStore & PostgresHandoffStore) | null = null;
let handle: Database | null = null;

/**
 * One pool for every store in this process.
 *
 * The capability and GitHub paths arrived after the magic link and must NOT open
 * a second connection: `max: 1` per lambda is what keeps Neon's pooled endpoint
 * from being exhausted, and two memoized handles would quietly make it two.
 */
function database(): Database {
  handle ??= createDatabase(undefined, 1).db;
  return handle;
}

/** The store, opening the connection on first use. */
export function postgresAuthStore(): PostgresAuthStore {
  store ??= createPostgresAuthStore(database());
  return store;
}

/**
 * The slug and provider-link store, over the same connection.
 *
 * Separate from `postgresAuthStore` because the interfaces are separate: the
 * magic-link path is given an `AuthStore` with three methods and no way to reach
 * a capability slug, which is what keeps `brief §2.1`'s surface exactly as it
 * was while the other two paths get what they need.
 */
export function postgresIdentityStore(): PostgresIdentityStore & PostgresHandoffStore {
  // `mintCapabilitySlug` for the same reason `lib/payments/config.ts` passes it
  // to the webhook store: every slug a customer is handed comes from
  // `CAPABILITY_CSPRNG`, and the column's own DEFAULT is a floor that exists so
  // an account can never be created without one. `createAccountForEmail` — the
  // free-run arm of `DECISIONS.md` S15 — creates accounts through this store, so
  // without this line a free-run account would get the floor rather than the
  // generator every paid one gets.
  identities ??= createPostgresIdentityStore(database(), { mintSlug: mintCapabilitySlug });
  return identities;
}

/** Drop the memoized handles. Tests only; nothing in a request path calls it. */
export function resetPostgresAuthStore(): void {
  store = null;
  identities = null;
  handle = null;
}
