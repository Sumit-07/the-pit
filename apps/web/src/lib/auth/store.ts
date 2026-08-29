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

import { createDatabase, createPostgresAuthStore, type PostgresAuthStore } from '@the-pit/db';

let store: PostgresAuthStore | null = null;

/** The store, opening the connection on first use. */
export function postgresAuthStore(): PostgresAuthStore {
  store ??= createPostgresAuthStore(createDatabase(undefined, 1).db);
  return store;
}

/** Drop the memoized handle. Tests only; nothing in a request path calls it. */
export function resetPostgresAuthStore(): void {
  store = null;
}
