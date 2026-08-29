/**
 * The `AuthStore` registration — the wire between `@the-pit/auth` and the tables.
 *
 * `@the-pit/auth` publishes an interface and refuses to know about Postgres;
 * `@the-pit/db` publishes the three statements and refuses to know about the
 * environment. Neither of them can be wrong about the thing this file checks,
 * which is that something is actually plugged in when a deployment has a
 * database, and that nothing is silently plugged in when it does not.
 *
 * `AuthNotWiredError` was the whole point of the seam: a deployment that reaches
 * production with no store must fail loudly on the first sign-in rather than
 * pretending. So the two cases that matter are "there is a database, and the
 * store resolves" and "there is not, and it still throws".
 *
 * No connection is opened. `postgres()` is lazy — it connects on the first
 * query — so a syntactically valid URL pointing nowhere is enough to prove the
 * wiring resolves, and no test here issues a query.
 */

import { MemoryAuthStore } from '@the-pit/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthNotWiredError, authDeps, registerAuthStore, resetAuthWiring } from '@/lib/auth/config';
import { postgresAuthStore, resetPostgresAuthStore } from '@/lib/auth/store';

/** Valid enough for `requireDatabaseUrl`; nothing listens on it and nothing tries. */
const NOWHERE = 'postgresql://user:pw@127.0.0.1:1/thepit';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';

let savedDatabaseUrl: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  savedDatabaseUrl = process.env['DATABASE_URL'];
  savedSecret = process.env['SESSION_SECRET'];
  delete process.env['DATABASE_URL'];
  process.env['SESSION_SECRET'] = SECRET;
  resetAuthWiring();
  resetPostgresAuthStore();
});

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = savedDatabaseUrl;
  if (savedSecret === undefined) delete process.env['SESSION_SECRET'];
  else process.env['SESSION_SECRET'] = savedSecret;
  resetAuthWiring();
  resetPostgresAuthStore();
});

describe('the Postgres store', () => {
  it('implements the three methods @the-pit/auth asks for, and no fourth', () => {
    // Especially no `createAccount`. `brief §2.1` creates accounts in exactly one
    // place — the signed Dodo webhook — and an auth path that could create one
    // would turn the magic link into self-serve signup.
    process.env['DATABASE_URL'] = NOWHERE;
    const store = postgresAuthStore();

    expect(Object.keys(store).sort()).toEqual(['consumeToken', 'createToken', 'findAccountByEmail']);
  });

  it('opens one connection and reuses it across calls', () => {
    // `authDeps()` runs per request. A handle built per call would open a pool
    // per request, which on Neon's pooled endpoint is how a lambda exhausts it.
    process.env['DATABASE_URL'] = NOWHERE;

    expect(postgresAuthStore()).toBe(postgresAuthStore());
  });
});

describe('what authDeps resolves', () => {
  it('throws AuthNotWiredError with no database and no registration', () => {
    // The loud failure. A fallback here is how a broken deployment looks healthy
    // until someone tries to sign in.
    expect(() => authDeps()).toThrow(AuthNotWiredError);
  });

  it('names the three methods in the failure, so the fix is in the message', () => {
    expect(() => authDeps()).toThrow(/findAccountByEmail \/ createToken \/ consumeToken/);
  });

  it('resolves the Postgres store when DATABASE_URL is configured', () => {
    process.env['DATABASE_URL'] = NOWHERE;

    expect(authDeps().request.store).toBe(postgresAuthStore());
    // The same instance reaches both halves of the flow: requesting a link and
    // verifying one must read and write the same `tokens` rows.
    expect(authDeps().verify.store).toBe(authDeps().request.store);
  });

  it('lets an explicit registration win over the database default', () => {
    // The seam has to stay usable, or the route tests cannot install a
    // `MemoryAuthStore` without also unsetting an environment variable.
    process.env['DATABASE_URL'] = NOWHERE;
    const memory = new MemoryAuthStore();
    registerAuthStore(memory);

    expect(authDeps().request.store).toBe(memory);
  });

  it('prefers the dev memory store to the database outside production', () => {
    // `AUTH_DEV_MEMORY_STORE=1` exists so the flow is clickable with no database.
    // If a stale `DATABASE_URL` outranked it, that would stop being true on
    // exactly the machines that have one.
    process.env['DATABASE_URL'] = NOWHERE;
    process.env['AUTH_DEV_MEMORY_STORE'] = '1';
    try {
      expect(authDeps().request.store).toBeInstanceOf(MemoryAuthStore);
    } finally {
      delete process.env['AUTH_DEV_MEMORY_STORE'];
    }
  });
});
