/**
 * `attempts` is a ledger, and these are the ways it refuses to become a counter.
 *
 * `the-pit-build-brief.md` §2.3:
 *
 *   "An attempt is **consumed only on delivery** — decrement in the same
 *    transaction that writes the verdict and marks it delivered. Not on job
 *    start, not on pipeline completion."
 *   "Failures are free retries."
 *
 * This table is also the store `@the-pit/payments` is written against.
 * `AttemptsStore` there names two invariants it explicitly leaves to the
 * database — a UNIQUE `idempotency_key`, and a balance that never goes negative —
 * so both are exercised here, keyed exactly the way that package keys them.
 *
 * Each test tries to do the wrong thing and asserts the database says no. A test
 * that only checked the happy path would pass against a plain integer column,
 * which is the design this table exists to reject.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import {
  consumeAttempt,
  grantAttempt,
  insertAccount,
  insertCategory,
  insertJob,
  insertOrder,
  insertProduct,
  type TestAccount,
} from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

/**
 * A fresh account per test, so one test's balance never leaks into another's.
 *
 * A row, not a string. `accounts.id` is what `orders`, `attempts` and `verdicts`
 * key on; the address is still the identity the payment carried, and `jobs` still
 * holds it, so the fixture carries both rather than making each test re-derive
 * one from the other.
 */
let counter = 0;
const anAccount = async (): Promise<TestAccount> => insertAccount(database.pg, `payer${(counter += 1)}@example.com`);

/** The address on the `jobs` rows below, which are not the subject of any test here. */
const ACCOUNT_EMAIL = 'payer@example.com';

const balanceOf = async (account: TestAccount): Promise<number> => {
  const result = await database.pg.query<{ balance: number }>(`SELECT attempt_balance($1) AS balance`, [account.id]);
  return Number(result.rows[0]?.balance);
};

describe('a balance is derived from immutable rows', () => {
  it('sums grants and consumes into a balance', async () => {
    // A multi-attempt grant: one event, one idempotency key, one row worth
    // three. No tier on sale grants three today, and the schema must still
    // hold one that does — the arithmetic here is the ledger's, not the
    // catalogue's.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `bal-${counter}`);
    const order = await insertOrder(database.pg, account, { attemptsGranted: 3 });
    await grantAttempt(database.pg, order, account, 3);

    const job = await insertJob(database.pg, categoryId, { delivered: true, account });
    await consumeAttempt(database.pg, job, account);

    expect(await balanceOf(account)).toBe(2);
  });

  it('refuses an UPDATE, so a balance cannot be rewritten in place', async () => {
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    const message = await expectRejection(database.pg, `UPDATE attempts SET delta = 5 WHERE account_id = $1`, [
      account.id,
    ]);
    expect(message).toMatch(/append-only/);
  });

  it('refuses a DELETE, so a consume cannot be erased and re-spent', async () => {
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    const message = await expectRejection(database.pg, `DELETE FROM attempts WHERE account_id = $1`, [account.id]);
    expect(message).toMatch(/append-only/);
  });

  it('corrects a mistake with a compensating row rather than an edit', async () => {
    // The `adjustment` arm exists so append-only is a workable policy and not
    // just a prohibition. It has to name a person: free text is acceptable on
    // this arm and on no other.
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    await database.pg.query(
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, note, actor)
       VALUES ($1, 'adjustment', 1, $2, 'support credit after a provider outage', 'ops@thepit.show')`,
      [account.id, `adjust:${account.id}:1`],
    );

    expect(await balanceOf(account)).toBe(2);
  });

  it('refuses an adjustment with nobody behind it', async () => {
    const account = await anAccount();
    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key) VALUES ($1, 'adjustment', 1, $2)`,
      [account.id, `adjust:${account.id}:orphan`],
    );
    expect(message).toMatch(/attempts_adjustment_has_reason/);
  });

  it('refuses a row that moves nothing', async () => {
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
       VALUES ($1, 'grant', 0, $2, $3)`,
      [account.id, `zero:${account.id}`, order],
    );
    expect(message).toMatch(/attempts_delta_non_zero|attempts_kind_matches_delta/);
  });

  it('refuses a kind that disagrees with its delta', async () => {
    // A grant that decrements, and a consume that takes two attempts for one
    // verdict, are both refused.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `disagree-${counter}`);
    const order = await insertOrder(database.pg, account);
    const job = await insertJob(database.pg, categoryId, { delivered: true, account });

    expect(
      await expectRejection(
        database.pg,
        `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
         VALUES ($1, 'grant', -1, $2, $3)`,
        [account.id, `bad-grant:${account.id}`, order],
      ),
    ).toMatch(/attempts_kind_matches_delta/);

    expect(
      await expectRejection(
        database.pg,
        `INSERT INTO attempts (account_id, kind, delta, idempotency_key, job_id)
         VALUES ($1, 'consume', -2, $2, $3)`,
        [account.id, `bad-consume:${account.id}`, job],
      ),
    ).toMatch(/attempts_kind_matches_delta/);
  });
});

describe('one row per money event (the payments AttemptsStore contract)', () => {
  it('refuses a second row under the same idempotency key', async () => {
    // `AttemptsStore` in `@the-pit/payments`: "`idempotency_key` is UNIQUE. Both
    // money paths — granting on a retried webhook and consuming on a retried
    // delivery — are protected by that one index, and by nothing else."
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    const insert = `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
                    VALUES ($1, 'grant', 1, 'dodo:event:evt_shared', $2)`;

    await database.pg.query(insert, [account.id, order]);
    const other = await insertOrder(database.pg, account);
    const message = await expectRejection(database.pg, insert, [account.id, other]);

    expect(message).toMatch(/attempts_idempotency_key_uk/);
    expect(await balanceOf(account)).toBe(1);
  });

  it('keeps grant keys and consume keys in separate namespaces', async () => {
    // The payments package namespaces them `dodo:event:` and `delivery:run:`
    // precisely so a provider id and a run id cannot silently deduplicate
    // against each other. Two money events sharing one key would be a customer
    // charged for a verdict nobody granted.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `ns-${counter}`);
    const order = await insertOrder(database.pg, account);
    const job = await insertJob(database.pg, categoryId, { delivered: true, account });

    await grantAttempt(database.pg, order, account);
    await consumeAttempt(database.pg, job, account);

    const keys = await database.pg.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM attempts WHERE account_id = $1 ORDER BY idempotency_key`,
      [account.id],
    );
    expect(keys.rows.map((row) => row.idempotency_key.split(':')[0])).toEqual(['delivery', 'dodo']);
  });
});

describe('an attempt is consumed only on delivery (brief §2.3)', () => {
  it('refuses a consume against a job that has not been delivered', async () => {
    // The "not on job start, not on pipeline completion" clause. The worker
    // cannot charge until `jobs.delivered_at` is set.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `undelivered-${counter}`);
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    const job = await insertJob(database.pg, categoryId, { delivered: false, account });
    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, job_id)
       VALUES ($1, 'consume', -1, $2, $3)`,
      [account.id, `delivery:run:${job}`, job],
    );
    expect(message).toMatch(/has not been delivered/);
  });

  it('leaves the balance untouched when a job fails — failures are free retries', async () => {
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `freeretry-${counter}`);
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    const product = await insertProduct(database.pg, categoryId, 0);
    await database.pg.query(
      `INSERT INTO jobs (kind, status, category_id, product_id, account_email,
                         prompt_version, persona_version, category_snapshot_version, engine_version,
                         failure_code, retryable, retry_count)
       VALUES ('placement', 'failed', $1, $2, $3, 'v1', 'v1', 'snap-1', '0.1.0', 'model_call', true, 1)`,
      [categoryId, product, ACCOUNT_EMAIL],
    );

    expect(await balanceOf(account)).toBe(1);
  });

  it('charges a delivered job exactly once, however many times delivery fires', async () => {
    // Dodo is not the only thing that retries. A worker restart, a duplicated
    // queue message, or a rerun of the delivery step must not bill twice.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `once-${counter}`);
    const order = await insertOrder(database.pg, account, { attemptsGranted: 2 });
    await grantAttempt(database.pg, order, account, 2);

    const job = await insertJob(database.pg, categoryId, { delivered: true, account });
    await consumeAttempt(database.pg, job, account);

    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, job_id)
       VALUES ($1, 'consume', -1, $2, $3)`,
      // A DIFFERENT idempotency key, so the second guard is the one under test
      // rather than the first.
      [account.id, `delivery:retry:${job}`, job],
    );

    expect(message).toMatch(/attempts_one_consume_per_job_uk/);
    expect(await balanceOf(account)).toBe(1);
  });

  it('refuses a consume that names no job', async () => {
    const account = await anAccount();
    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key) VALUES ($1, 'consume', -1, $2)`,
      [account.id, `orphan-consume:${account.id}`],
    );
    expect(message).toMatch(/attempts_consume_has_job/);
  });
});

describe('a grant is worth exactly what the tier bought', () => {
  it('refuses a grant that names no order', async () => {
    const account = await anAccount();
    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key) VALUES ($1, 'grant', 1, $2)`,
      [account.id, `orphan-grant:${account.id}`],
    );
    expect(message).toMatch(/attempts_grant_has_order/);
  });

  it('refuses more attempts than the order paid for', async () => {
    // The row may never grant more than the order it names paid for. A handler
    // that read the wrong tier is caught here rather than in a support ticket.
    const account = await anAccount();
    const order = await insertOrder(database.pg, account, { attemptsGranted: 1 });

    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
       VALUES ($1, 'grant', 4, $2, $3)`,
      [account.id, `dodo:event:${order}`, order],
    );
    expect(message).toMatch(/paid for/);
  });

  it('refuses fewer, too — the ledger and the receipt agree or neither is evidence', async () => {
    const account = await anAccount();
    const order = await insertOrder(database.pg, account, { attemptsGranted: 3 });

    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
       VALUES ($1, 'grant', 1, $2, $3)`,
      [account.id, `dodo:event:${order}`, order],
    );
    expect(message).toMatch(/paid for/);
  });

  it('refuses a second grant against one order', async () => {
    const account = await anAccount();
    const order = await insertOrder(database.pg, account);
    await grantAttempt(database.pg, order, account);

    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
       VALUES ($1, 'grant', 1, $2, $3)`,
      [account.id, `dodo:event:duplicate:${order}`, order],
    );
    expect(message).toMatch(/attempts_one_grant_per_order_uk/);
  });
});

describe('a balance cannot go negative', () => {
  it('refuses a consume with no attempt to spend', async () => {
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `overdraft-${counter}`);
    const job = await insertJob(database.pg, categoryId, { delivered: true, account });

    const message = await expectRejection(
      database.pg,
      `INSERT INTO attempts (account_id, kind, delta, idempotency_key, job_id)
       VALUES ($1, 'consume', -1, $2, $3)`,
      [account.id, `delivery:run:${job}`, job],
    );
    expect(message).toMatch(/cannot be negative/);
  });

  it('accepts a grant and a consume written in either order inside one transaction', async () => {
    // `brief §2.3` requires the decrement in "the same transaction that writes
    // the verdict", not in a particular statement order within it. Every guard
    // that reads another row is a CONSTRAINT trigger judged at COMMIT for
    // exactly this reason.
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `deferred-${counter}`);
    const order = await insertOrder(database.pg, account);
    const product = await insertProduct(database.pg, categoryId, 0);

    await database.pg.exec('BEGIN');
    const jobResult = await database.pg.query<{ id: string }>(
      `INSERT INTO jobs (kind, status, category_id, product_id, account_email,
                         prompt_version, persona_version, category_snapshot_version, engine_version)
       VALUES ('placement', 'running', $1, $2, $3, 'v1', 'v1', 'snap-1', '0.1.0') RETURNING id`,
      [categoryId, product, ACCOUNT_EMAIL],
    );
    const job = jobResult.rows[0]?.id ?? '';

    // The consume is written BEFORE the job is marked delivered and BEFORE the
    // grant exists. Both are legal because the transaction ends up consistent.
    await consumeAttempt(database.pg, job, account);
    await grantAttempt(database.pg, order, account);
    await database.pg.query(`UPDATE jobs SET status = 'succeeded', delivered_at = now() WHERE id = $1`, [job]);
    await database.pg.exec('COMMIT');

    expect(await balanceOf(account)).toBe(0);
  });

  it('rolls the whole transaction back when the job is never delivered', async () => {
    const account = await anAccount();
    const categoryId = await insertCategory(database.pg, `rollback-${counter}`);
    const order = await insertOrder(database.pg, account);
    const product = await insertProduct(database.pg, categoryId, 0);

    await database.pg.exec('BEGIN');
    const jobResult = await database.pg.query<{ id: string }>(
      `INSERT INTO jobs (kind, status, category_id, product_id, account_email,
                         prompt_version, persona_version, category_snapshot_version, engine_version)
       VALUES ('placement', 'running', $1, $2, $3, 'v1', 'v1', 'snap-1', '0.1.0') RETURNING id`,
      [categoryId, product, ACCOUNT_EMAIL],
    );
    await grantAttempt(database.pg, order, account);
    await consumeAttempt(database.pg, jobResult.rows[0]?.id ?? '', account);

    const message = await expectRejection(database.pg, 'COMMIT');
    expect(message).toMatch(/has not been delivered/);

    await expectRejection(database.pg, 'ROLLBACK');
    expect(await balanceOf(account)).toBe(0);
  });
});
