/**
 * The free door, against a real Postgres.
 *
 * Every rule in `lib/free/policy.ts` is a count over `free_run_requests`, so a
 * mocked store would assert that this file's own fake counts the way this file
 * wrote it to. These run against PGlite — Postgres in-process, with the real DDL,
 * the real shape checks and the real append-only trigger — for the same reason
 * `pg-claims.test.ts` gives about its own store: the race and the constraint are
 * the subject, and neither exists in a mock.
 *
 * What is being prevented, concretely: a stranger taking a second free run. A run
 * is twelve juror calls, a clustering pass and a persona round, which `brief
 * §2.3` prices at $5 for everybody else, and a hole in the free door is a hole
 * that spends money silently.
 */

import { PGlite } from '@electric-sql/pglite';
import { readMigrations } from '@the-pit/db';
import * as schema from '@the-pit/db/schema';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from '@the-pit/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FREE_RUNS_PER_DAY,
  FREE_RUNS_PER_DAY_ENV,
  FREE_RUN_IP_LIMIT,
  foldEmailKey,
  freeRunPolicyFor,
  freeRunsPerDay,
  type FreeRunCheck,
} from '@/lib/free/policy';

/** Long enough for `assertUsableKeyring`; the shape every other suite uses. */
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const KEYRING: readonly [string, ...string[]] = [SECRET];

let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = await PGlite.create();
  const migrations = await readMigrations();
  if (migrations.length === 0) throw new Error('No migrations found.');
  for (const migration of migrations) {
    for (const statement of migration.statements) {
      try {
        await pg.exec(statement);
      } catch (cause) {
        throw new Error(`${migration.tag}: ${statement.slice(0, 120)}`, { cause });
      }
    }
  }
  db = drizzle(pg, { schema });
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  // The trigger refuses a DELETE, so the table is emptied the one way it allows.
  await pg.exec('ALTER TABLE free_run_requests DISABLE TRIGGER free_run_requests_immutable_trg;');
  await pg.exec('TRUNCATE free_run_requests, submissions CASCADE;');
  await pg.exec('ALTER TABLE free_run_requests ENABLE TRIGGER free_run_requests_immutable_trg;');
});

const NOW = new Date('2026-04-01T12:00:00.000Z');

/** A submission row, because `free_run_requests.submission_id` is a foreign key. */
async function insertSubmission(normalizedUrl: string): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO submissions
       (category_slug, name, url, normalized_url, description, description_hash, cycle_id, tier, attempt_number)
     VALUES ('developer-tools', 'A product', $1, $2, 'A description.', $3, 'cycle-1', 'single', 1)
     RETURNING id`,
    [`https://${normalizedUrl}`, normalizedUrl, 'a'.repeat(64)],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('submission was not inserted');
  return id;
}

function request(overrides: Partial<FreeRunCheck> = {}): FreeRunCheck {
  return {
    email: 'founder@example.com',
    ip: '203.0.113.7',
    normalizedUrl: 'example.com',
    now: NOW,
    ...overrides,
  };
}

function policy() {
  return freeRunPolicyFor(db, KEYRING);
}

/** Take a free run: check, then record against a fresh submission. */
async function take(input: FreeRunCheck): Promise<void> {
  const submissionId = await insertSubmission(input.normalizedUrl);
  await policy().record({ ...input, submissionId });
}

describe('each rule, in isolation', () => {
  it('allows a first throw with nothing on the table', async () => {
    await expect(policy().check(request())).resolves.toEqual({ ok: true });
  });

  it('refuses a disposable address', async () => {
    await expect(policy().check(request({ email: 'someone@mailinator.com' }))).resolves.toEqual({
      ok: false,
      reason: 'disposable_email',
    });
  });

  it('refuses a subdomain of a disposable domain, and only on a label boundary', async () => {
    await expect(policy().check(request({ email: 'x@team.mailinator.com' }))).resolves.toEqual({
      ok: false,
      reason: 'disposable_email',
    });
    // Ends with a listed string and is not that domain. (`notmailinator.com`
    // would be the obvious spelling and is itself a real Mailinator alias.)
    await expect(policy().check(request({ email: 'x@ourmailinator.com' }))).resolves.toEqual({ ok: true });
  });

  it('refuses a URL that has already had its free throw, whoever asks', async () => {
    await take(request());

    await expect(
      policy().check(request({ email: 'someone-else@example.org', ip: '198.51.100.4' })),
    ).resolves.toEqual({ ok: false, reason: 'url_used' });
  });

  it('refuses an address that has already had its free throw, whatever it submits', async () => {
    await take(request());

    await expect(
      policy().check(request({ normalizedUrl: 'another.example', ip: '198.51.100.4' })),
    ).resolves.toEqual({ ok: false, reason: 'email_used' });
  });

  it('refuses the sixth request from one address inside the hour', async () => {
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      const input = request({ email: `founder${i}@example.com`, normalizedUrl: `product-${i}.example` });
      await expect(policy().check(input)).resolves.toEqual({ ok: true });
      await take(input);
    }

    await expect(
      policy().check(request({ email: 'sixth@example.com', normalizedUrl: 'product-6.example' })),
    ).resolves.toEqual({ ok: false, reason: 'ip_window' });
  });

  it('refuses once the day is spent', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '2';
    // Two rows from two different addresses, so nothing but the cap can refuse.
    for (let i = 0; i < 2; i += 1) {
      await take(request({ email: `f${i}@example.com`, normalizedUrl: `p-${i}.example`, ip: `198.51.100.${i}` }));
    }

    await expect(
      policy().check(request({ email: 'third@example.com', normalizedUrl: 'p-3.example', ip: '198.51.100.9' })),
    ).resolves.toEqual({ ok: false, reason: 'daily_cap' });
  });
});

describe('the order of the rules', () => {
  it('reports the disposable address rather than the used URL', async () => {
    await take(request());

    // Both rules fire. The one the visitor can act on is the address.
    await expect(policy().check(request({ email: 'x@mailinator.com' }))).resolves.toEqual({
      ok: false,
      reason: 'disposable_email',
    });
  });

  it('reports the used URL rather than the used email', async () => {
    await take(request());

    await expect(policy().check(request())).resolves.toEqual({ ok: false, reason: 'url_used' });
  });

  it('reports the used email rather than the IP window', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '1000';
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      await take(request({ email: `founder${i}@example.com`, normalizedUrl: `product-${i}.example` }));
    }

    // The IP is spent AND this address has run. The address is the closer fact.
    await expect(
      policy().check(request({ email: 'founder0@example.com', normalizedUrl: 'fresh.example' })),
    ).resolves.toEqual({ ok: false, reason: 'email_used' });
  });

  it('reports the IP window rather than the daily cap', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = String(FREE_RUN_IP_LIMIT);
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      await take(request({ email: `founder${i}@example.com`, normalizedUrl: `product-${i}.example` }));
    }

    await expect(
      policy().check(request({ email: 'new@example.com', normalizedUrl: 'fresh.example' })),
    ).resolves.toEqual({ ok: false, reason: 'ip_window' });
  });
});

describe('one inbox is one person', () => {
  it('folds a plus tag onto the base address', async () => {
    await take(request({ email: 'founder@example.com' }));

    await expect(
      policy().check(request({ email: 'founder+pit@example.com', normalizedUrl: 'other.example' })),
    ).resolves.toEqual({ ok: false, reason: 'email_used' });
  });

  it('folds Gmail dots and Googlemail onto the same key', async () => {
    await take(request({ email: 'first.last@gmail.com' }));

    await expect(
      policy().check(request({ email: 'firstlast@gmail.com', normalizedUrl: 'other.example' })),
    ).resolves.toEqual({ ok: false, reason: 'email_used' });
    await expect(
      policy().check(request({ email: 'f.i.r.s.t.last+pit@googlemail.com', normalizedUrl: 'third.example' })),
    ).resolves.toEqual({ ok: false, reason: 'email_used' });
  });

  it('does not fold dots outside Gmail, where they are different mailboxes', async () => {
    await take(request({ email: 'first.last@example.com' }));

    await expect(
      policy().check(request({ email: 'firstlast@example.com', normalizedUrl: 'other.example' })),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a plus-addressed variant only once the base has run', async () => {
    // Nothing on the table: a `+tag` is a legitimate way to use an inbox and is
    // not itself a refusal.
    await expect(policy().check(request({ email: 'founder+pit@example.com' }))).resolves.toEqual({ ok: true });
  });
});

describe('the IP window is a window', () => {
  it('ignores requests that have fallen out of the hour', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '1000';
    const longAgo = new Date(NOW.getTime() - 61 * 60 * 1000);
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      await take(request({ email: `old${i}@example.com`, normalizedUrl: `old-${i}.example`, now: longAgo }));
    }

    await expect(
      policy().check(request({ email: 'new@example.com', normalizedUrl: 'fresh.example' })),
    ).resolves.toEqual({ ok: true });
  });

  it('counts the boundary as inside the window', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '1000';
    // 59 minutes ago: still inside the hour, so five of them still refuse.
    const recent = new Date(NOW.getTime() - 59 * 60 * 1000);
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      await take(request({ email: `r${i}@example.com`, normalizedUrl: `r-${i}.example`, now: recent }));
    }

    await expect(
      policy().check(request({ email: 'new@example.com', normalizedUrl: 'fresh.example' })),
    ).resolves.toEqual({ ok: false, reason: 'ip_window' });
  });

  it('does not count a different address against this one', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '1000';
    for (let i = 0; i < FREE_RUN_IP_LIMIT; i += 1) {
      await take(request({ email: `a${i}@example.com`, normalizedUrl: `a-${i}.example` }));
    }

    await expect(
      policy().check(request({ email: 'new@example.com', normalizedUrl: 'fresh.example', ip: '198.51.100.99' })),
    ).resolves.toEqual({ ok: true });
  });

  it('skips the rule entirely when there is no address to key on', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '1000';
    for (let i = 0; i < FREE_RUN_IP_LIMIT + 3; i += 1) {
      await take(request({ email: `n${i}@example.com`, normalizedUrl: `n-${i}.example`, ip: null }));
    }

    await expect(
      policy().check(request({ email: 'new@example.com', normalizedUrl: 'fresh.example', ip: null })),
    ).resolves.toEqual({ ok: true });
  });
});

describe('the daily cap comes from the environment', () => {
  it('ignores rows older than 24 hours', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '2';
    const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      await take(
        request({ email: `y${i}@example.com`, normalizedUrl: `y-${i}.example`, ip: `198.51.100.${i}`, now: yesterday }),
      );
    }

    await expect(
      policy().check(request({ email: 'today@example.com', normalizedUrl: 'today.example', ip: '198.51.100.77' })),
    ).resolves.toEqual({ ok: true });
  });

  it('falls back to the default when the variable is unset or nonsense', () => {
    expect(freeRunsPerDay({})).toBe(DEFAULT_FREE_RUNS_PER_DAY);
    expect(freeRunsPerDay({ [FREE_RUNS_PER_DAY_ENV]: '' })).toBe(DEFAULT_FREE_RUNS_PER_DAY);
    expect(freeRunsPerDay({ [FREE_RUNS_PER_DAY_ENV]: 'plenty' })).toBe(DEFAULT_FREE_RUNS_PER_DAY);
    expect(freeRunsPerDay({ [FREE_RUNS_PER_DAY_ENV]: '7' })).toBe(7);
    // A closed door is a thing an operator may want to say, and it is not a typo.
    expect(freeRunsPerDay({ [FREE_RUNS_PER_DAY_ENV]: '0' })).toBe(0);
  });

  it('closes the door at zero', async () => {
    process.env[FREE_RUNS_PER_DAY_ENV] = '0';
    await expect(policy().check(request())).resolves.toEqual({ ok: false, reason: 'daily_cap' });
  });
});

describe('what reaches the table', () => {
  it('stores no address, only digests', async () => {
    await take(request({ email: 'founder@example.com', ip: '203.0.113.7' }));

    const rows = await pg.query<{ email_key_hash: string; ip_hash: string | null; normalized_url: string }>(
      'SELECT email_key_hash, ip_hash, normalized_url FROM free_run_requests',
    );
    const row = rows.rows[0];
    expect(row).toBeDefined();

    // The whole row, as text: nothing in it may contain the address or the IP.
    const asText = JSON.stringify(row);
    expect(asText).not.toContain('founder@example.com');
    expect(asText).not.toContain('founder');
    expect(asText).not.toContain('203.0.113.7');

    expect(row?.email_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    // The URL is public and is stored plain: `products.normalized_url` holds it
    // in the clear already, and hashing it would only make the table unreadable.
    expect(row?.normalized_url).toBe('example.com');
  });

  it('refuses a raw address written past the policy', async () => {
    const submissionId = await insertSubmission('direct.example');
    await expect(
      pg.query(
        `INSERT INTO free_run_requests (submission_id, email_key_hash, normalized_url)
         VALUES ($1, 'founder@example.com', 'direct.example')`,
        [submissionId],
      ),
    ).rejects.toThrow(/free_run_requests_email_key_is_hmac_hex/);
  });

  it('writes one row for a request delivered twice', async () => {
    const input = request();
    const submissionId = await insertSubmission(input.normalizedUrl);
    await policy().record({ ...input, submissionId });
    await policy().record({ ...input, submissionId });

    const rows = await pg.query<{ n: string }>('SELECT count(*)::int AS n FROM free_run_requests');
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});

describe('the ledger is append-only', () => {
  it('refuses an UPDATE and a DELETE', async () => {
    await take(request());

    await expect(pg.query("UPDATE free_run_requests SET normalized_url = 'moved.example'")).rejects.toThrow(
      /append-only/,
    );
    await expect(pg.query('DELETE FROM free_run_requests')).rejects.toThrow(/append-only/);
  });
});

describe('foldEmailKey', () => {
  it('folds what it should and leaves alone what it should not', () => {
    expect(foldEmailKey('Founder@Example.COM')).toBe('founder@example.com');
    expect(foldEmailKey('founder+a+b@example.com')).toBe('founder@example.com');
    expect(foldEmailKey('f.o.o@gmail.com')).toBe('foo@gmail.com');
    expect(foldEmailKey('foo@googlemail.com')).toBe('foo@gmail.com');
    expect(foldEmailKey('f.o.o@example.com')).toBe('f.o.o@example.com');
    // Not an address. Folded as far as it can be, never rejected: refusing to
    // fold something odd would hand a free run to whoever typed it.
    expect(foldEmailKey('not-an-address')).toBe('not-an-address');
    // A local part that is nothing but a tag keeps its original, so every such
    // address does not collapse onto one shared key.
    expect(foldEmailKey('+tag@example.com')).toBe('+tag@example.com');
  });
});

afterEach(() => {
  delete process.env[FREE_RUNS_PER_DAY_ENV];
});
