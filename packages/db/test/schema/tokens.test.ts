/**
 * `tokens` — magic links, `the-pit-build-brief.md` §2.1.
 *
 * "Store **SHA-256 of the token**, never the raw value. 15-minute expiry, single
 * use."
 *
 * Single use is a property of the redeeming statement, so it is tested as one:
 * the same UPDATE is run twice and the second must affect zero rows. Asserting
 * only that a `used_at` column exists would pass against a verifier that never
 * checks it.
 */

import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

/** What the auth route would do: mint a raw token, store only its digest. */
function mint(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

/** `§2.1`: 15-minute expiry. */
const FIFTEEN_MINUTES = "now() + interval '15 minutes'";

const ISSUE = `INSERT INTO tokens (token_hash, email, expires_at) VALUES ($1, $2, ${FIFTEEN_MINUTES})`;

/**
 * The redeeming statement. Every condition is in the WHERE clause on purpose: one
 * atomic UPDATE decides validity and spends the token together, so two concurrent
 * redemptions of the same link cannot both succeed.
 */
const REDEEM = `UPDATE tokens SET used_at = now()
                 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`;

describe('the raw token never reaches the table', () => {
  it('refuses a value that is not a SHA-256 hex digest', async () => {
    const { raw } = mint();
    const message = await expectRejection(database.pg, ISSUE, [raw, 'a@example.com']);
    expect(message).toMatch(/tokens_hash_is_sha256_hex/);
  });

  it('refuses an upper-case digest, so one token cannot be stored twice', async () => {
    const { hash } = mint();
    const message = await expectRejection(database.pg, ISSUE, [hash.toUpperCase(), 'a@example.com']);
    expect(message).toMatch(/tokens_hash_is_sha256_hex/);
  });

  it('accepts the digest of a token', async () => {
    const { hash } = mint();
    await database.pg.query(ISSUE, [hash, 'a@example.com']);
    const stored = await database.pg.query<{ token_hash: string }>(
      `SELECT token_hash FROM tokens WHERE token_hash = $1`,
      [hash],
    );
    expect(stored.rows).toHaveLength(1);
  });
});

describe('single use', () => {
  it('redeems once and refuses the second attempt', async () => {
    const { hash } = mint();
    await database.pg.query(ISSUE, [hash, 'b@example.com']);

    const first = await database.pg.query(REDEEM, [hash]);
    expect(first.affectedRows).toBe(1);

    const second = await database.pg.query(REDEEM, [hash]);
    expect(second.affectedRows).toBe(0);
  });

  it('refuses an expired token', async () => {
    const { hash } = mint();
    await database.pg.query(
      `INSERT INTO tokens (token_hash, email, expires_at, created_at)
       VALUES ($1, $2, now() - interval '1 minute', now() - interval '16 minutes')`,
      [hash, 'c@example.com'],
    );

    const result = await database.pg.query(REDEEM, [hash]);
    expect(result.affectedRows).toBe(0);
  });

  it('reports the same nothing for an unknown token as for a spent one', async () => {
    // `§2.1` requires no account enumeration on `POST /auth/request`; the
    // verifier has the same obligation. Both cases must be one indistinguishable
    // "zero rows" rather than two distinguishable outcomes.
    const { hash: unknown } = mint();
    const { hash: spent } = mint();
    await database.pg.query(ISSUE, [spent, 'd@example.com']);
    await database.pg.query(REDEEM, [spent]);

    const a = await database.pg.query(REDEEM, [unknown]);
    const b = await database.pg.query(REDEEM, [spent]);
    expect(a.affectedRows).toBe(b.affectedRows);
    expect(a.affectedRows).toBe(0);
  });
});

describe('field-level rules', () => {
  it('refuses a mixed-case email', async () => {
    const { hash } = mint();
    const message = await expectRejection(database.pg, ISSUE, [hash, 'Mixed@Example.com']);
    expect(message).toMatch(/tokens_email_lowercase/);
  });

  it('refuses a token that expires before it is issued', async () => {
    const { hash } = mint();
    const message = await expectRejection(
      database.pg,
      `INSERT INTO tokens (token_hash, email, expires_at) VALUES ($1, $2, now() - interval '1 second')`,
      [hash, 'e@example.com'],
    );
    expect(message).toMatch(/tokens_expiry_after_creation/);
  });
});
