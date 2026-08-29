/**
 * `verdicts` — the frozen, permanently addressable thing a customer paid for.
 *
 * `the-pit-build-brief.md` Part 6: the verdict page is "a public permanent URL,
 * shareable, works logged out". `DECISIONS.md` §1.2: every placement shifts every
 * z-score. Those two sentences together are the whole table — a page that is
 * permanent and shareable cannot be re-rendered from a board that moves — so
 * every test below tries to break the freeze and asserts the database refuses.
 *
 * The suite also pins what `DECISIONS.md` S8 has NOT decided. S8 is open on
 * whether a shared URL shows the new verdict, freezes at v1, redirects, or 404s,
 * and `packages/payments/src/listing/repitch.ts` implements all four behind a
 * policy with no default. The schema's job is to keep all four possible, which
 * means one thing and only one thing: a re-pitch inserts, the old row survives,
 * and its slug still resolves. That is asserted directly, rather than left to be
 * inferred from the absence of an UPDATE statement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import {
  insertAccount,
  insertCategory,
  insertJob,
  insertProduct,
  insertVerdict,
  type TestAccount,
} from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const freshSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

const INSERT = `INSERT INTO verdicts
    (public_slug, product_id, job_id, account_id, attempt_number, payload, product_count)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`;

describe('a delivered verdict is frozen (brief Part 6)', () => {
  it('refuses an UPDATE, so a shared link cannot start showing something else', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('frozen'));
    const productId = await insertProduct(database.pg, categoryId, 0);
    const verdictId = await insertVerdict(database.pg, productId);

    const message = await expectRejection(
      database.pg,
      `UPDATE verdicts SET payload = '{"verdict":{"rank":1}}'::jsonb WHERE id = $1`,
      [verdictId],
    );
    expect(message).toMatch(/append-only/);
  });

  it('refuses a DELETE, so the superseded verdict cannot be swept', async () => {
    // Three of S8's four readings need the old row: `archive` serves it,
    // `redirect` derives its target from it, and `404` still needs it as the
    // dispute record (`brief` Part 7). `planRepitch` says both of its arms retain
    // the row; this is what makes that a guarantee rather than an intention.
    const categoryId = await insertCategory(database.pg, freshSlug('undeletable'));
    const productId = await insertProduct(database.pg, categoryId, 0);
    const verdictId = await insertVerdict(database.pg, productId);

    const message = await expectRejection(database.pg, `DELETE FROM verdicts WHERE id = $1`, [verdictId]);
    expect(message).toMatch(/append-only/);
  });

  it('refuses to move a slug, even to another row of the same product', async () => {
    // The slug is the address in someone's tweet. Repointing it is the same
    // failure as editing the payload, reached from the routing side.
    const categoryId = await insertCategory(database.pg, freshSlug('slug-move'));
    const productId = await insertProduct(database.pg, categoryId, 0);
    const verdictId = await insertVerdict(database.pg, productId, { slug: 'stableslugone' });

    const message = await expectRejection(database.pg, `UPDATE verdicts SET public_slug = $2 WHERE id = $1`, [
      verdictId,
      'someotherslug',
    ]);
    expect(message).toMatch(/append-only/);
  });

  it('keeps the old row resolvable after a re-pitch writes a new one', async () => {
    // The one behaviour every reading of S8 depends on. Two verdicts for one
    // listing, both addressable, neither having disturbed the other.
    const categoryId = await insertCategory(database.pg, freshSlug('repitch'));
    const account = await insertAccount(database.pg, `repitch${counter}@example.com`);
    const productId = await insertProduct(database.pg, categoryId, 0);

    const firstJob = await insertJob(database.pg, categoryId, { delivered: true, productId, account });
    await insertVerdict(database.pg, productId, {
      slug: 'firstpitchslug',
      jobId: firstJob,
      account,
      attemptNumber: 1,
      productCount: 12,
    });

    const secondJob = await insertJob(database.pg, categoryId, { delivered: true, productId, account });
    await insertVerdict(database.pg, productId, {
      slug: 'secondpitchslug',
      jobId: secondJob,
      account,
      attemptNumber: 2,
      productCount: 13,
    });

    const rows = await database.pg.query<{ public_slug: string; attempt_number: number; product_count: number }>(
      `SELECT public_slug, attempt_number, product_count FROM verdicts
        WHERE product_id = $1 ORDER BY attempt_number`,
      [productId],
    );

    // Hand-derived: the 1st pitch was issued against a 12-product board and the
    // 2nd against a 13-product one, and BOTH stamps survive. A live-rendered page
    // would show 13 on both, which is exactly the lie `brief` Part 5's product
    // count exists to prevent.
    expect(rows.rows).toEqual([
      { public_slug: 'firstpitchslug', attempt_number: 1, product_count: 12 },
      { public_slug: 'secondpitchslug', attempt_number: 2, product_count: 13 },
    ]);
  });
});

describe('the public URL', () => {
  it('refuses a second verdict at the same slug', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('slug-uk'));
    const first = await insertProduct(database.pg, categoryId, 0);
    const second = await insertProduct(database.pg, categoryId, 1, 'other.example');
    await insertVerdict(database.pg, first, { slug: 'oneurlonlyplease' });

    const message = await expectRejection(database.pg, INSERT, [
      'oneurlonlyplease',
      second,
      null,
      null,
      null,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/verdicts_public_slug_uk/);
  });

  it('refuses a slug that would not survive a URL', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('slug-shape'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    for (const bad of ['Has Spaces And Caps', 'trailing-hyphen-', 'under_scored_slug', 'short']) {
      const message = await expectRejection(database.pg, INSERT, [
        bad,
        productId,
        null,
        null,
        null,
        '{"verdict":{}}',
        1,
      ]);
      expect(`${bad}: ${message ?? 'accepted'}`).toMatch(/verdicts_public_slug_shape/);
    }
  });
});

describe('what a verdict has to name', () => {
  it('refuses a payload that is not a document', async () => {
    // The one column a dispute will be argued from. A scalar or an array here
    // means something serialized the wrong value into it.
    const categoryId = await insertCategory(database.pg, freshSlug('payload'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    for (const bad of ['[]', '"a string"', '42', 'null']) {
      const message = await expectRejection(database.pg, INSERT, [
        `payloadcheck${(counter += 1)}`,
        productId,
        null,
        null,
        null,
        bad,
        1,
      ]);
      expect(`${bad}: ${message ?? 'accepted'}`).toMatch(/verdicts_payload_is_document/);
    }
  });

  it('refuses a board with nothing on it', async () => {
    // A board a verdict was issued against holds at least the product the verdict
    // is about, so `rank 1 of 0` is not a state that can be stored.
    const categoryId = await insertCategory(database.pg, freshSlug('count'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    const message = await expectRejection(database.pg, INSERT, [
      'emptyboardslug',
      productId,
      null,
      null,
      null,
      '{"verdict":{}}',
      0,
    ]);
    expect(message).toMatch(/verdicts_product_count_positive/);
  });

  it('refuses a zeroth pitch', async () => {
    // `ordinalPitch` in `@the-pit/payments` would render it "0th pitch".
    const categoryId = await insertCategory(database.pg, freshSlug('zeroth'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    const message = await expectRejection(database.pg, INSERT, [
      'zerothpitchslug',
      productId,
      null,
      null,
      0,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/verdicts_attempt_number_positive/);
  });

  it('refuses a paid verdict with no run and no pitch number behind it', async () => {
    // `brief §2.4` shows the attempt count publicly on a pitched listing, and
    // `brief §2.3` makes delivery the money event. A row naming a payer but no
    // delivered run is a page somebody was charged for that nothing produced.
    const categoryId = await insertCategory(database.pg, freshSlug('paid-shape'));
    const productId = await insertProduct(database.pg, categoryId, 0);
    const account: TestAccount = await insertAccount(database.pg, `paidshape${counter}@example.com`);

    const message = await expectRejection(database.pg, INSERT, [
      'paidnorunslug',
      productId,
      null,
      account.id,
      1,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/verdicts_paid_verdict_is_a_pitch/);
  });

  it('accepts a seeded verdict with no run, no payer and no pitch number', async () => {
    // `brief` Part 7's cold start: the two Phase 1 boards were produced by the
    // engine's CLI, their listings are unclaimed, and every one of them still has
    // a public verdict page. If this were rejected the seed could not run.
    const categoryId = await insertCategory(database.pg, freshSlug('seeded'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    await database.pg.query(INSERT, ['unclaimedboardslug', productId, null, null, null, '{"verdict":{}}', 48]);

    const row = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM verdicts WHERE public_slug = 'unclaimedboardslug'`,
    );
    expect(Number(row.rows[0]?.count)).toBe(1);
  });
});

describe('a verdict is tied to a delivered run (brief §2.3)', () => {
  it('refuses a verdict for a job that has not been delivered', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('undelivered'));
    const account = await insertAccount(database.pg, `undelivered${counter}@example.com`);
    const productId = await insertProduct(database.pg, categoryId, 0);
    const job = await insertJob(database.pg, categoryId, { delivered: false, productId, account });

    const message = await expectRejection(database.pg, INSERT, [
      'undeliveredslug',
      productId,
      job,
      account.id,
      1,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/has not been delivered/);
  });

  it('accepts the verdict written before the delivery flag, inside one transaction', async () => {
    // `AttemptsLedger.deliver` in `@the-pit/payments` writes the verdict FIRST and
    // marks the job delivered second, on purpose: an implementation that loses its
    // transaction should fail toward "delivered but not charged". The guard is a
    // DEFERRED constraint trigger so that ordering stays legal.
    const categoryId = await insertCategory(database.pg, freshSlug('deferred'));
    const account = await insertAccount(database.pg, `deferred${counter}@example.com`);
    const productId = await insertProduct(database.pg, categoryId, 0);
    const job = await insertJob(database.pg, categoryId, { delivered: false, productId, account });

    await database.pg.exec('BEGIN');
    await database.pg.query(INSERT, ['deferredorderslug', productId, job, account.id, 1, '{"verdict":{}}', 3]);
    await database.pg.query(`UPDATE jobs SET status = 'succeeded', delivered_at = now() WHERE id = $1`, [job]);
    await database.pg.exec('COMMIT');

    const row = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM verdicts WHERE public_slug = 'deferredorderslug'`,
    );
    expect(Number(row.rows[0]?.count)).toBe(1);
  });

  it('refuses a second verdict for one delivered run', async () => {
    // A job is charged for once (`attempts_one_consume_per_job_uk`), so a job that
    // produced two verdicts would have delivered one of them for free.
    const categoryId = await insertCategory(database.pg, freshSlug('one-per-job'));
    const account = await insertAccount(database.pg, `oneperjob${counter}@example.com`);
    const productId = await insertProduct(database.pg, categoryId, 0);
    const job = await insertJob(database.pg, categoryId, { delivered: true, productId, account });

    await database.pg.query(INSERT, ['firstforthisrun', productId, job, account.id, 1, '{"verdict":{}}', 1]);
    const message = await expectRejection(database.pg, INSERT, [
      'secondforthisrun',
      productId,
      job,
      account.id,
      2,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/verdicts_one_per_job_uk/);
  });

  it('refuses two verdicts claiming the same pitch ordinal for one listing', async () => {
    // "3rd pitch" is shown publicly (`brief §2.4`). Two rows both claiming it is a
    // contradiction the card would print.
    const categoryId = await insertCategory(database.pg, freshSlug('ordinal'));
    const account = await insertAccount(database.pg, `ordinal${counter}@example.com`);
    const productId = await insertProduct(database.pg, categoryId, 0);
    const first = await insertJob(database.pg, categoryId, { delivered: true, productId, account });
    const second = await insertJob(database.pg, categoryId, { delivered: true, productId, account });

    await database.pg.query(INSERT, ['ordinalfirstslug', productId, first, account.id, 3, '{"verdict":{}}', 1]);
    const message = await expectRejection(database.pg, INSERT, [
      'ordinalsecondslug',
      productId,
      second,
      account.id,
      3,
      '{"verdict":{}}',
      1,
    ]);
    expect(message).toMatch(/verdicts_product_attempt_uk/);
  });

  it('lets many unclaimed listings share a null ordinal', async () => {
    // The seeded boards are 92 rows with no pitch number. NULLs are distinct to a
    // unique constraint, which is what keeps `verdicts_product_attempt_uk` from
    // limiting a cold-start board to one product.
    const categoryId = await insertCategory(database.pg, freshSlug('null-ordinal'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    await database.pg.query(INSERT, [`nullordinala${counter}`, productId, null, null, null, '{"verdict":{}}', 2]);
    await database.pg.query(INSERT, [`nullordinalb${counter}`, productId, null, null, null, '{"verdict":{}}', 2]);

    const row = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM verdicts WHERE product_id = $1`,
      [productId],
    );
    expect(Number(row.rows[0]?.count)).toBe(2);
  });
});
