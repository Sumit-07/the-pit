/**
 * `free_run_requests` — `0012_free_run_requests.sql`.
 *
 * The free first throw is only survivable because a person gets exactly one, and
 * every rule that enforces that is a count over this table. So what is asserted
 * here is not that the table exists but that it cannot be turned into a table
 * that lies: no address can be stored in it, and no row can be edited or removed
 * once written.
 *
 * The append-only guard is the load-bearing one. Without it the table is a
 * mutable counter with extra steps — one UPDATE to a `created_at` slides the
 * hourly window for free, one DELETE and a URL is available again — and neither
 * leaves anything behind. `0001_ledger_guards.sql` makes the same argument about
 * `attempts` in the same words.
 */

import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { columnsOf, constraintsOf, expectRejection, indexesOf, migratedDatabase, type TestDatabase } from '../support/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

/** What `lib/free/policy.ts` writes: an HMAC digest, lowercase hex. */
function hmac(value: string): string {
  return createHmac('sha256', 'a-test-session-secret').update(value, 'utf8').digest('hex');
}

const INSERT = `INSERT INTO free_run_requests (submission_id, email_key_hash, ip_hash, normalized_url)
                VALUES ($1, $2, $3, $4) RETURNING id`;

/** A draft to hang the free run on: `submission_id` is a foreign key. */
async function insertSubmission(normalizedUrl = 'example.com'): Promise<string> {
  const result = await database.pg.query<{ id: string }>(
    `INSERT INTO submissions
       (category_slug, name, url, normalized_url, description, description_hash, cycle_id, tier, attempt_number)
     VALUES ('developer-tools', 'A product', $1, $2, 'A description.', $3, 'cycle-1', 'single', 1)
     RETURNING id`,
    [`https://${normalizedUrl}`, normalizedUrl, 'a'.repeat(64)],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('submissions.id was not returned');
  return id;
}

describe('the columns are the five the rules read, and nothing else', () => {
  it('has exactly id, submission_id, email_key_hash, ip_hash, normalized_url, created_at', async () => {
    // Asserted as a list, for the reason `tokens` asserts its own: a sixth column
    // is where a raw address would eventually be put "just for support".
    expect(await columnsOf(database.pg, 'free_run_requests')).toEqual([
      'id',
      'submission_id',
      'email_key_hash',
      'ip_hash',
      'normalized_url',
      'created_at',
    ]);
  });
});

describe('no address reaches the table', () => {
  it('refuses an email in the email column', async () => {
    const submissionId = await insertSubmission('a.example');
    const message = await expectRejection(database.pg, INSERT, [
      submissionId,
      'founder@example.com',
      null,
      'a.example',
    ]);
    expect(message).toMatch(/free_run_requests_email_key_is_hmac_hex/);
  });

  it('refuses an IP in the IP column', async () => {
    const submissionId = await insertSubmission('b.example');
    const message = await expectRejection(database.pg, INSERT, [
      submissionId,
      hmac('founder@example.com'),
      '203.0.113.7',
      'b.example',
    ]);
    expect(message).toMatch(/free_run_requests_ip_is_hmac_hex/);
  });

  it('refuses an upper-case digest, so one address cannot be stored twice', async () => {
    const submissionId = await insertSubmission('c.example');
    const message = await expectRejection(database.pg, INSERT, [
      submissionId,
      hmac('founder@example.com').toUpperCase(),
      null,
      'c.example',
    ]);
    expect(message).toMatch(/free_run_requests_email_key_is_hmac_hex/);
  });

  it('accepts a digest, and a null IP for a request that had no address', async () => {
    const submissionId = await insertSubmission('d.example');
    const inserted = await database.pg.query(INSERT, [
      submissionId,
      hmac('founder@example.com'),
      null,
      'd.example',
    ]);
    expect(inserted.rows).toHaveLength(1);
  });
});

describe('the URL is stored the way every other table stores it', () => {
  it('refuses a scheme or an upper-case key', async () => {
    const withScheme = await insertSubmission('e.example');
    expect(
      await expectRejection(database.pg, INSERT, [withScheme, hmac('a@b.com'), null, 'https://e.example']),
    ).toMatch(/free_run_requests_normalized_url_shape/);

    const upper = await insertSubmission('f.example');
    expect(await expectRejection(database.pg, INSERT, [upper, hmac('a@b.com'), null, 'F.EXAMPLE'])).toMatch(
      /free_run_requests_normalized_url_shape/,
    );
  });
});

describe('one submission is one throw', () => {
  it('refuses a second row for the same submission', async () => {
    const submissionId = await insertSubmission('g.example');
    await database.pg.query(INSERT, [submissionId, hmac('one@example.com'), null, 'g.example']);

    const message = await expectRejection(database.pg, INSERT, [
      submissionId,
      hmac('two@example.com'),
      null,
      'g.example',
    ]);
    expect(message).toMatch(/free_run_requests_submission_uk/);
  });
});

describe('the ledger is append-only', () => {
  it('refuses an UPDATE and a DELETE, naming what the edit would have bought', async () => {
    const submissionId = await insertSubmission('h.example');
    await database.pg.query(INSERT, [submissionId, hmac('h@example.com'), null, 'h.example']);

    const updated = await expectRejection(
      database.pg,
      `UPDATE free_run_requests SET created_at = now() - interval '2 hours'`,
    );
    expect(updated).toMatch(/append-only/);

    const deleted = await expectRejection(database.pg, 'DELETE FROM free_run_requests');
    expect(deleted).toMatch(/append-only/);
  });
});

describe('one index per rule', () => {
  it('indexes every key the five queries look up', async () => {
    const indexes = await indexesOf(database.pg, 'free_run_requests');
    // Each rule is a lookup on its own key. Without these the daily cap alone
    // would make every check read the whole table.
    expect([...indexes.keys()].sort()).toEqual([
      'free_run_requests_created_at_idx',
      'free_run_requests_email_key_idx',
      'free_run_requests_ip_idx',
      'free_run_requests_normalized_url_idx',
      'free_run_requests_pkey',
      'free_run_requests_submission_uk',
    ]);
  });

  it('holds the submission with restrict, because this row is evidence', async () => {
    const constraints = await constraintsOf(database.pg, 'free_run_requests');
    const fk = constraints.get('free_run_requests_submission_id_submissions_id_fk');
    expect(fk).toMatch(/ON DELETE RESTRICT/i);
  });
});
