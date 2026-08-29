/**
 * `accounts.capability_slug` and `account_identities`, against a real Postgres.
 *
 * These run the same DDL Neon will, in an in-process PGlite, and every assertion
 * reads `pg_catalog` or executes a statement — never a regex over the `.sql`
 * file, which would pass on DDL Postgres rejects.
 *
 * What is worth testing at this layer, as opposed to in `@the-pit/auth`:
 *
 * - the column's DEFAULT actually produces a slug of the right shape, from a
 *   strong source, with no contrib extension installed;
 * - the CHECK refuses a short or mis-encoded slug, so a bug in a writer cannot
 *   leave an account addressable at `/a/1`;
 * - the UNIQUE refuses two accounts one URL;
 * - `(provider, provider_user_id)` is unique, which is the control that stops a
 *   link being transferred to a customer's account;
 * - and the whole thing is ADDITIVE — every constraint `0000`-`0003` created is
 *   still there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { columnsOf, constraintsOf, expectRejection, indexesOf, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { insertAccount } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const nextEmail = (prefix: string): string => `${prefix}${(counter += 1)}@example.com`;

/** 43 base64url characters, built so each one is distinct and legal. */
function slugFor(seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const digits = seed.toString(64 > 36 ? 36 : 36).padStart(6, '0');
  return (digits + alphabet.slice(0, 43 - digits.length)).slice(0, 43);
}

describe('the capability slug column', () => {
  it('fills itself with 43 base64url characters when nobody supplies one', async () => {
    // The floor described in `0004`: an account can never exist without a URL,
    // because an account with no URL is a customer who cannot reach what they
    // paid for.
    const result = await database.pg.query<{ capability_slug: string }>(
      `INSERT INTO accounts (email) VALUES ($1) RETURNING capability_slug`,
      [nextEmail('default')],
    );
    const slug = result.rows[0]?.capability_slug ?? '';
    expect(slug).toHaveLength(43);
    expect(slug).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never emits the standard-base64 characters that would break a URL path', async () => {
    // `translate(..., '+/=', '-_')` maps `+` and `/` and DELETES `=`. If that
    // were wrong, some fraction of accounts would get a slug carrying `/` and
    // their URL would route to a different path entirely — an intermittent bug
    // that only appears for some customers.
    const result = await database.pg.query<{ slug: string }>(
      `INSERT INTO accounts (email)
       SELECT 'bulk' || g || '-${(counter += 1)}@example.com' FROM generate_series(1, 300) g
       RETURNING capability_slug AS slug`,
    );
    expect(result.rows).toHaveLength(300);
    for (const row of result.rows) {
      expect(row.slug).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    // And they are all different — a default that repeated would collide on the
    // unique index and take out account creation.
    expect(new Set(result.rows.map((row) => row.slug)).size).toBe(300);
  });

  it('needs no contrib extension — the migrations installed none', async () => {
    // `gen_random_bytes()` would have been the obvious source and lives in
    // pgcrypto. An extension that silently is not installed on Neon or in PGlite
    // breaks migration time, not query time, which is the worst moment to find
    // out. `gen_random_uuid()` is core since Postgres 13.
    const extensions = await database.pg.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')`,
    );
    expect(extensions.rows.map((row) => row.extname)).toEqual([]);
  });

  it('refuses a slug that is too short to be a secret', async () => {
    // The failure this catches: a writer passing an id, a counter, or a
    // truncated value. `/a/1` is addressable by anyone who can count.
    for (const bad of ['', '1', 'short', 'a'.repeat(42), 'a'.repeat(44)]) {
      const message = await expectRejection(
        database.pg,
        `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2)`,
        [nextEmail('shape'), bad],
      );
      expect(`${JSON.stringify(bad)}: ${message ?? 'accepted'}`).toMatch(/accounts_capability_slug_shape/);
    }
  });

  it('refuses a slug carrying characters that mean something in a URL', async () => {
    for (const bad of [`${'a'.repeat(42)}/`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)}=`, `${'a'.repeat(42)}.`]) {
      const message = await expectRejection(
        database.pg,
        `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2)`,
        [nextEmail('alphabet'), bad],
      );
      expect(`${JSON.stringify(bad)}: ${message ?? 'accepted'}`).toMatch(/accounts_capability_slug_shape/);
    }
  });

  it('refuses to give two accounts the same URL', async () => {
    const slug = slugFor(counter += 1);
    await database.pg.query(`INSERT INTO accounts (email, capability_slug) VALUES ($1, $2)`, [
      nextEmail('uk-first'),
      slug,
    ]);
    const message = await expectRejection(
      database.pg,
      `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2)`,
      [nextEmail('uk-second'), slug],
    );
    expect(message).toMatch(/accounts_capability_slug_uk/);
  });

  it('rotates by replacing, so the old slug stops resolving in the same statement', async () => {
    // The whole revocation story. One column means there is no window in which
    // both slugs work, and no way for a bug to leave two live.
    const account = await insertAccount(database.pg, nextEmail('rotate'));
    const before = await database.pg.query<{ slug: string }>(
      `SELECT capability_slug AS slug FROM accounts WHERE id = $1`,
      [account.id],
    );
    const old = before.rows[0]?.slug ?? '';

    const fresh = slugFor((counter += 1) + 900);
    await database.pg.query(`UPDATE accounts SET capability_slug = $2 WHERE id = $1`, [account.id, fresh]);

    const byOld = await database.pg.query(`SELECT id FROM accounts WHERE capability_slug = $1`, [old]);
    const byNew = await database.pg.query<{ id: string }>(`SELECT id FROM accounts WHERE capability_slug = $1`, [
      fresh,
    ]);
    expect(byOld.rows).toEqual([]);
    expect(byNew.rows[0]?.id).toBe(account.id);
  });

  it('is answered from the unique index rather than a sequential scan', async () => {
    // A capability lookup happens on every visit to a bookmarked URL. It has to
    // be an index hit, and the unique constraint is what provides the index.
    const indexes = await indexesOf(database.pg, 'accounts');
    expect([...indexes.keys()]).toContain('accounts_capability_slug_uk');
    expect(indexes.get('accounts_capability_slug_uk')).toMatch(/UNIQUE INDEX .* \(capability_slug\)/);
  });
});

describe('account_identities', () => {
  it('carries exactly what a link needs and nothing else', async () => {
    expect(await columnsOf(database.pg, 'account_identities')).toEqual([
      'id',
      'account_id',
      'provider',
      'provider_user_id',
      'linked_email',
      'created_at',
      'updated_at',
    ]);
  });

  it('links a provider identity to an account that already exists', async () => {
    const account = await insertAccount(database.pg, nextEmail('link'));
    await database.pg.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', '4242', $2)`,
      [account.id, account.email],
    );
    const rows = await database.pg.query<{ account_id: string }>(
      `SELECT account_id FROM account_identities WHERE provider = 'github' AND provider_user_id = '4242'`,
    );
    expect(rows.rows[0]?.account_id).toBe(account.id);
  });

  it('refuses a link to an account that does not exist', async () => {
    // The row is an attachment, never a creation. There is no path that inserts
    // here and into `accounts` together.
    const message = await expectRejection(
      database.pg,
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ('00000000-0000-0000-0000-000000000000', 'github', 'ghost', 'ghost@example.com')`,
    );
    expect(message).toMatch(/account_identities_account_id_accounts_id_fk/);
  });

  it('refuses a second link for the same provider user — the takeover control', async () => {
    // The attack: sign in once with your own account, then add and verify a
    // customer's address on GitHub hoping the link gets re-pointed. The UNIQUE
    // is what turns that into a no-op.
    const mine = await insertAccount(database.pg, nextEmail('takeover-mine'));
    const theirs = await insertAccount(database.pg, nextEmail('takeover-theirs'));

    await database.pg.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'attacker-id', $2)`,
      [mine.id, mine.email],
    );
    const message = await expectRejection(
      database.pg,
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'attacker-id', $2)`,
      [theirs.id, theirs.email],
    );
    expect(message).toMatch(/account_identities_provider_user_uk/);
  });

  it('lets an ON CONFLICT refresh the address without moving the account', async () => {
    // What `linkIdentity` actually runs. The address moves; the account does not.
    const account = await insertAccount(database.pg, nextEmail('refresh'));
    await database.pg.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'refresh-id', 'old@example.com')`,
      [account.id],
    );
    await database.pg.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'refresh-id', 'new@example.com')
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET linked_email = excluded.linked_email`,
      [account.id],
    );

    const rows = await database.pg.query<{ account_id: string; linked_email: string }>(
      `SELECT account_id, linked_email FROM account_identities WHERE provider_user_id = 'refresh-id'`,
    );
    expect(rows.rows).toEqual([{ account_id: account.id, linked_email: 'new@example.com' }]);
  });

  it('allows one account to hold several links', async () => {
    // A person with two GitHub accounts, or a second provider later. Only
    // `(provider, provider_user_id)` is unique — `account_id` deliberately is not.
    const account = await insertAccount(database.pg, nextEmail('multi'));
    for (const id of ['multi-a', 'multi-b']) {
      await database.pg.query(
        `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
         VALUES ($1, 'github', $2, $3)`,
        [account.id, id, account.email],
      );
    }
    const rows = await database.pg.query(`SELECT id FROM account_identities WHERE account_id = $1`, [account.id]);
    expect(rows.rows).toHaveLength(2);
  });

  it('refuses a provider name that is not a lowercase identifier', async () => {
    // A display name or a mixed-case spelling opens a parallel keyspace where
    // the UNIQUE above protects nothing.
    const account = await insertAccount(database.pg, nextEmail('provider-shape'));
    for (const bad of ['', 'GitHub', 'git hub', '1github', 'a'.repeat(33)]) {
      const message = await expectRejection(
        database.pg,
        `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
         VALUES ($1, $2, 'x', $3)`,
        [account.id, bad, account.email],
      );
      expect(`${JSON.stringify(bad)}: ${message ?? 'accepted'}`).toMatch(/account_identities_provider_shape/);
    }
  });

  it('accepts a provider that is not github, so a second one is not a migration', async () => {
    // Ownership will need a proof that is not GitHub — a DNS TXT record or a
    // /.well-known file — because 26 of the 44 seeded Health & Fitness listings
    // have no repository at all. Nothing here should have to change for that.
    const account = await insertAccount(database.pg, nextEmail('other-provider'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'gitlab', 'gl-1', $2)`,
      [account.id, account.email],
    );
    expect(message).toBeNull();
  });

  it('refuses an empty provider user id', async () => {
    const account = await insertAccount(database.pg, nextEmail('empty-id'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', '', $2)`,
      [account.id, account.email],
    );
    expect(message).toMatch(/account_identities_provider_user_id_present/);
  });

  it('refuses a mixed-case linked address, so it compares directly with accounts.email', async () => {
    const account = await insertAccount(database.pg, nextEmail('case'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'case-1', 'Mixed@Example.com')`,
      [account.id],
    );
    expect(message).toMatch(/account_identities_email_lowercase/);
  });

  it('refuses to delete an account that has a link', async () => {
    // `ON DELETE restrict`, like every money-adjacent key here.
    const account = await insertAccount(database.pg, nextEmail('restrict'));
    await database.pg.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, linked_email)
       VALUES ($1, 'github', 'restrict-1', $2)`,
      [account.id, account.email],
    );
    const message = await expectRejection(database.pg, `DELETE FROM accounts WHERE id = $1`, [account.id]);
    expect(message).toMatch(/account_identities_account_id_accounts_id_fk/);
  });
});

describe('0004 is additive', () => {
  it('leaves every constraint 0003 put on accounts in place', async () => {
    const constraints = await constraintsOf(database.pg, 'accounts');
    for (const name of ['accounts_email_uk', 'accounts_email_lowercase', 'accounts_email_shape']) {
      expect(`${name}: ${constraints.has(name)}`).toBe(`${name}: true`);
    }
  });

  it('leaves the tokens table exactly as brief §2.1 specified it', async () => {
    // The magic link is not weakened by having siblings. Five columns, and the
    // same four checks.
    expect(await columnsOf(database.pg, 'tokens')).toEqual([
      'token_hash',
      'email',
      'expires_at',
      'used_at',
      'created_at',
    ]);
    const constraints = await constraintsOf(database.pg, 'tokens');
    for (const name of [
      'tokens_hash_is_sha256_hex',
      'tokens_email_lowercase',
      'tokens_expiry_after_creation',
      'tokens_used_after_creation',
    ]) {
      expect(`${name}: ${constraints.has(name)}`).toBe(`${name}: true`);
    }
  });

  it('leaves the verdicts guards alone — a verdict is still append-only and public', async () => {
    // `brief` Part 6: verdict URLs are public and permanent. None of the three
    // sign-in paths may gate one, and none of them touched this table.
    const constraints = await constraintsOf(database.pg, 'verdicts');
    expect(constraints.has('verdicts_public_slug_uk')).toBe(true);
    const message = await expectRejection(database.pg, `DELETE FROM verdicts WHERE public_slug = 'nothing-here'`);
    expect(message).toBeNull();
  });
});
