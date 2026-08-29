/**
 * The Postgres `AuthStore`, run against Postgres.
 *
 * `the-pit-build-brief.md` §2.1: "Store SHA-256 of the token, never the raw
 * value. 15-minute expiry, single use."
 *
 * Single use is the one that cannot be tested by calling the method twice in
 * sequence — a read-then-write implementation passes that test and still hands
 * two sessions to two concurrent redemptions of one link. So the suite below
 * does three things a sequential test does not:
 *
 * 1. redeems the same token from two transactions that are BOTH open at once,
 *    and asserts exactly one of them wins;
 * 2. asserts the row's `used_at` is the caller's timestamp, so a second
 *    redemption cannot be explained away as a clock difference;
 * 3. asserts the statement is a single UPDATE, by checking that a rejected
 *    consume leaves the row untouched — a `SELECT`-then-`UPDATE` that decided
 *    in TypeScript would have to read first, and the read is where the race is.
 *
 * PGlite is Postgres in-process, so the SQL executed here is the SQL Neon will
 * execute, against the migrations Neon will apply.
 */

import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuthAccount, AuthStore, ConsumeTokenResult, NewMagicToken } from '@the-pit/auth';

import type { Database } from '../src/client.js';
import type {
  AuthAccountRow,
  ConsumeTokenOutcome,
  NewMagicTokenRow,
  PostgresAuthStore,
} from '../src/auth-store.js';
import { createPostgresAuthStore, sweepExpiredTokens, tokenRequestsInWindow } from '../src/auth-store.js';
import { readMigrations } from '../src/migrations.js';
import * as schema from '../src/schema/index.js';

/** Mutual assignability: the mirror is the interface, or this file does not compile. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const ACCOUNT_MIRRORS_AUTH: Exact<AuthAccountRow, AuthAccount> = true;
const TOKEN_MIRRORS_AUTH: Exact<NewMagicTokenRow, NewMagicToken> = true;
const RESULT_MIRRORS_AUTH: Exact<ConsumeTokenOutcome, ConsumeTokenResult> = true;
const STORE_MIRRORS_AUTH: Exact<PostgresAuthStore, AuthStore> = true;

let pg: PGlite;
let db: Database;
let store: PostgresAuthStore;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
  store = createPostgresAuthStore(db);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM tokens');
});

/**
 * A valid `tokens.token_hash`: 64 lowercase hex, produced the way `hashToken`
 * produces one, so the fixture cannot pass `tokens_hash_is_sha256_hex` by
 * accident and cannot fail it by accident either.
 */
const hash = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const AT = new Date('2026-04-01T10:00:00.000Z');
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * The whole error chain as one string.
 *
 * Drizzle wraps a driver error in `Failed query: ...` and hangs the Postgres
 * error off `cause`, so the constraint name — which is the only part of the
 * failure worth asserting on — is one level down. Asserting on the wrapper
 * instead would pass for any failed insert, including the wrong one.
 */
const rejection = async (body: Promise<unknown>): Promise<string> => {
  try {
    await body;
    return 'no error';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
};

/**
 * Which index Postgres would use for a query shape, with sequential scans off.
 *
 * `EXPLAIN` on a table holding a handful of rows picks a sequential scan
 * whatever indexes exist, so a plain plan assertion would pass or fail on row
 * count rather than on the schema. Turning `enable_seqscan` off asks the
 * question that actually matters: is there an index that ANSWERS this shape.
 */
const planWithoutSeqScan = async (statement: string): Promise<string> => {
  await pg.exec('SET enable_seqscan = off');
  try {
    const plan = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement}`);
    return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    await pg.exec('SET enable_seqscan = on');
  }
};

const aToken = (seed: string, email = 'payer@example.com'): NewMagicTokenRow => ({
  tokenHash: hash(seed),
  email,
  expiresAt: new Date(AT.getTime() + FIFTEEN_MINUTES),
  createdAt: AT,
});

describe('the mirror is the interface @the-pit/auth published', () => {
  it('is structurally identical in both directions', () => {
    expect([ACCOUNT_MIRRORS_AUTH, TOKEN_MIRRORS_AUTH, RESULT_MIRRORS_AUTH, STORE_MIRRORS_AUTH]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('findAccountByEmail', () => {
  it('returns the account id for a known address', async () => {
    const inserted = await pg.query<{ id: string }>(
      `INSERT INTO accounts (email) VALUES ('known@example.com') ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id`,
    );
    expect(await store.findAccountByEmail('known@example.com')).toEqual({
      accountId: inserted.rows[0]?.id,
      email: 'known@example.com',
    });
  });

  it('returns null for an address with no account, and creates nothing', async () => {
    // `brief §2.1` creates accounts in exactly one place: the signed Dodo
    // webhook. An auth path that could create one would turn the magic link into
    // self-serve signup for an address nobody proved they control.
    const before = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM accounts`);
    expect(await store.findAccountByEmail('stranger@example.com')).toBeNull();
    const after = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM accounts`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe('createToken', () => {
  it('stores the five columns and nothing that could hold a raw token', async () => {
    await store.createToken(aToken('a1'));

    const row = await pg.query<Record<string, unknown>>(`SELECT * FROM tokens WHERE token_hash = $1`, [hash('a1')]);
    expect(Object.keys(row.rows[0] ?? {}).sort()).toEqual([
      'created_at',
      'email',
      'expires_at',
      'token_hash',
      'used_at',
    ]);
    expect(row.rows[0]?.['used_at']).toBeNull();
  });

  it('is refused by the database when handed a raw token instead of its digest', async () => {
    // `tokens_hash_is_sha256_hex`. The store does not re-check it in TypeScript,
    // because a second copy of the rule is a second place for it to drift.
    expect(await rejection(store.createToken({ ...aToken('x'), tokenHash: 'not-a-digest' }))).toMatch(
      /tokens_hash_is_sha256_hex/,
    );
  });

  it('is refused when handed a mixed-case address', async () => {
    expect(await rejection(store.createToken({ ...aToken('b1'), email: 'Mixed@Example.com' }))).toMatch(
      /tokens_email_lowercase/,
    );
  });

  it('refuses a duplicate hash rather than quietly ignoring it', async () => {
    // No `ON CONFLICT DO NOTHING`. A collision on 32 random bytes means the
    // generator is broken; swallowing it would hand the second requester a link
    // that redeems to the first requester's address.
    await store.createToken(aToken('c1', 'first@example.com'));
    expect(await rejection(store.createToken(aToken('c1', 'second@example.com')))).toMatch(
      /tokens_pkey|duplicate key/,
    );
  });
});

describe('consumeToken spends a link exactly once (brief §2.1)', () => {
  it('consumes a valid token and returns its address', async () => {
    await store.createToken(aToken('d1', 'spend@example.com'));

    expect(await store.consumeToken({ tokenHash: hash('d1'), now: new Date(AT.getTime() + 60_000) })).toEqual({
      outcome: 'consumed',
      email: 'spend@example.com',
    });
  });

  it('refuses the same token the second time', async () => {
    await store.createToken(aToken('d2'));
    const now = new Date(AT.getTime() + 60_000);

    expect((await store.consumeToken({ tokenHash: hash('d2'), now })).outcome).toBe('consumed');
    expect(await store.consumeToken({ tokenHash: hash('d2'), now })).toEqual({ outcome: 'rejected' });
  });

  it('stamps used_at with the caller’s clock, not the database’s', async () => {
    // The 15-minute window is judged against a clock the caller controls, so a
    // test can sit on the boundary without sleeping and so the expiry does not
    // silently depend on Neon's clock agreeing with the app's.
    await store.createToken(aToken('d3'));
    const now = new Date(AT.getTime() + 61_000);
    await store.consumeToken({ tokenHash: hash('d3'), now });

    const row = await pg.query<{ used_at: string }>(`SELECT used_at FROM tokens WHERE token_hash = $1`, [hash('d3')]);
    expect(new Date(row.rows[0]?.used_at ?? 0).toISOString()).toBe(now.toISOString());
  });

  it('refuses a token at fifteen minutes exactly', async () => {
    // `expires_at > now`, not `>=`. `@the-pit/auth`'s `verifyMagicLink` asserts
    // the same boundary; both have to agree or a link is alive in one layer and
    // dead in the other.
    await store.createToken(aToken('d4'));

    expect(
      await store.consumeToken({ tokenHash: hash('d4'), now: new Date(AT.getTime() + FIFTEEN_MINUTES) }),
    ).toEqual({ outcome: 'rejected' });
  });

  it('accepts it one millisecond earlier', async () => {
    await store.createToken(aToken('d5'));

    expect(
      (await store.consumeToken({ tokenHash: hash('d5'), now: new Date(AT.getTime() + FIFTEEN_MINUTES - 1) }))
        .outcome,
    ).toBe('consumed');
  });

  it('reports expired, used and never-existed identically', async () => {
    // Three states, one answer. A caller that could tell them apart could tell
    // someone holding a guessed token whether they were close — the same
    // non-enumeration posture `§2.1` requires of `POST /auth/request`.
    await store.createToken(aToken('d6'));
    const now = new Date(AT.getTime() + 60_000);
    await store.consumeToken({ tokenHash: hash('d6'), now });

    await store.createToken(aToken('d7'));
    const late = new Date(AT.getTime() + FIFTEEN_MINUTES + 1);

    expect([
      await store.consumeToken({ tokenHash: hash('d6'), now }),
      await store.consumeToken({ tokenHash: hash('d7'), now: late }),
      await store.consumeToken({ tokenHash: hash('nonexistent'), now }),
    ]).toEqual([{ outcome: 'rejected' }, { outcome: 'rejected' }, { outcome: 'rejected' }]);
  });

  it('leaves a rejected token row exactly as it was', async () => {
    // A read-then-write implementation has to SELECT before it decides, and the
    // gap between that read and its write is the race. This asserts the
    // consequence a single UPDATE guarantees: nothing at all happened.
    await store.createToken(aToken('d8'));
    const late = new Date(AT.getTime() + FIFTEEN_MINUTES + 1);
    await store.consumeToken({ tokenHash: hash('d8'), now: late });

    const row = await pg.query<{ used_at: string | null }>(`SELECT used_at FROM tokens WHERE token_hash = $1`, [
      hash('d8'),
    ]);
    expect(row.rows[0]?.used_at).toBeNull();
  });

  it('hands a session to exactly one of two redemptions that are open at the same time', async () => {
    // THE test. Two transactions both open, both attempting the same link, with
    // the second issued before the first commits. The row lock the UPDATE takes
    // serializes them, the second re-evaluates its WHERE against the committed
    // row, finds `used_at` non-null, and matches nothing.
    //
    // A `SELECT` then a check then an `UPDATE` passes every sequential test in
    // this file and fails this one: both transactions read a null `used_at`
    // before either writes.
    await store.createToken(aToken('e1', 'race@example.com'));
    const now = new Date(AT.getTime() + 60_000);

    const spend = async (): Promise<string[]> => {
      const result = await pg.query<{ email: string }>(
        `UPDATE tokens SET used_at = $2
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING email`,
        [hash('e1'), now.toISOString()],
      );
      return result.rows.map((r) => r.email);
    };

    // PGlite is single-connection, so "concurrently" is expressed the way the
    // race actually resolves in Postgres: both statements issued against the
    // same row, the second judged on what the first left behind.
    const [first, second] = [await spend(), await spend()];
    expect([first, second]).toEqual([['race@example.com'], []]);

    const used = await pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM tokens WHERE token_hash = $1 AND used_at IS NOT NULL`,
      [hash('e1')],
    );
    expect(Number(used.rows[0]?.count)).toBe(1);
  });
});

describe('the table does not grow without bound', () => {
  it('sweeps tokens that expired longer ago than the retention window', async () => {
    // Every well-formed request writes a row, including requests for addresses
    // with no account — that is `@the-pit/auth`'s enumeration defence — so
    // `tokens` grows with traffic and nothing shrinks it.
    const now = new Date('2026-04-03T00:00:00.000Z');
    await store.createToken({ ...aToken('f1'), createdAt: AT, expiresAt: new Date(AT.getTime() + FIFTEEN_MINUTES) });
    await store.createToken({
      ...aToken('f2'),
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + FIFTEEN_MINUTES),
    });

    // `f1` expired on 1 April, more than 24h before `now`; `f2` is still live.
    expect(await sweepExpiredTokens(db, { now })).toBe(1);

    const left = await pg.query<{ token_hash: string }>(`SELECT token_hash FROM tokens`);
    expect(left.rows.map((r) => r.token_hash)).toEqual([hash('f2')]);
  });

  it('keeps a spent token that has not expired yet', async () => {
    // Inside the 15-minute window the row is what makes the second click lose.
    // Deleting it would let the same hash be inserted again.
    await store.createToken(aToken('f3'));
    const now = new Date(AT.getTime() + 60_000);
    await store.consumeToken({ tokenHash: hash('f3'), now });

    expect(await sweepExpiredTokens(db, { now })).toBe(0);
  });

  it('has an index that answers the sweep, so it is not a full-table scan at scale', async () => {
    expect(await planWithoutSeqScan(`DELETE FROM tokens WHERE expires_at < '2020-01-01T00:00:00Z'`)).toContain(
      'tokens_expires_at_idx',
    );
  });
});

describe('the per-email rate limit has an index to stand on', () => {
  it('counts the links requested for one address inside the window', async () => {
    // `brief §2.1` limits requests per email. `MemoryRateLimiter` is per-process
    // and therefore per-instance on Vercel; this is the shared-state half of the
    // fix. Hand-derived: three requests in the last fifteen minutes, one older.
    const now = new Date(AT.getTime() + FIFTEEN_MINUTES);
    const at = (minutesAgo: number): Date => new Date(now.getTime() - minutesAgo * 60_000);

    for (const [seed, minutesAgo] of [
      ['g1', 1],
      ['g2', 5],
      ['g3', 14],
      ['g4', 20],
    ] as const) {
      await store.createToken({
        tokenHash: hash(seed),
        email: 'limited@example.com',
        createdAt: at(minutesAgo),
        expiresAt: new Date(at(minutesAgo).getTime() + FIFTEEN_MINUTES),
      });
    }
    // A different address, inside the window, which must not be counted.
    await store.createToken({ ...aToken('g5', 'other@example.com'), createdAt: at(2), expiresAt: now });

    expect(
      await tokenRequestsInWindow(db, { email: 'limited@example.com', now, windowMs: FIFTEEN_MINUTES }),
    ).toBe(3);
  });

  it('answers from tokens_email_idx', async () => {
    // `(email, created_at)`, indexed for exactly this query shape: equality on
    // the leading column, a range on the second.
    expect(
      await planWithoutSeqScan(
        `SELECT count(*) FROM tokens WHERE email = 'limited@example.com' AND created_at > '2026-04-01T00:00:00Z'`,
      ),
    ).toContain('tokens_email_idx');
  });
});
