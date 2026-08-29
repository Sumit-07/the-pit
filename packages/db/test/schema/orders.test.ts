/**
 * `orders` and the idempotent webhook.
 *
 * `the-pit-build-brief.md` §2.2: "Grant attempts on the **signed webhook**, never
 * on the success redirect. Webhook handler must be **idempotent** — Dodo
 * retries."
 *
 * The mechanism is a unique constraint on the provider's event id, and the test
 * that matters is the one that replays a retry inside a transaction and shows the
 * grants roll back with it. A `SELECT ... IF NOT EXISTS ... INSERT` in the
 * handler would pass a naive test and still double-grant under two concurrent
 * retries; the constraint cannot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

const INSERT_ORDER = `INSERT INTO orders
   (provider, provider_event_id, provider_payment_id, account_email, amount_cents, currency,
    attempts_granted, includes_fit_report, status, raw_event)
 VALUES ('dodo', $1, $2, $3, $4, 'USD', $5, $6, $7, '{}'::jsonb)
 RETURNING id`;

describe('idempotency', () => {
  it('refuses a second order for the same provider event id', async () => {
    await database.pg.query(INSERT_ORDER, ['evt_1', 'pay_1', 'a@example.com', 500, 1, false, 'paid']);

    const message = await expectRejection(database.pg, INSERT_ORDER, [
      'evt_1',
      'pay_1',
      'a@example.com',
      500,
      1,
      false,
      'paid',
    ]);
    expect(message).toMatch(/orders_provider_event_uk/);
  });

  it('a retried webhook grants nothing extra, because the whole transaction fails', async () => {
    // This is the shape the real handler must have: insert the order and its
    // grants in one transaction. The retry loses on the unique constraint, and
    // the grants it was about to write go with it.
    const email = 'retry@example.com';
    const grantThreeInOneTransaction = async (eventId: string): Promise<string | null> => {
      await database.pg.exec('BEGIN');
      try {
        const order = await database.pg.query<{ id: string }>(INSERT_ORDER, [
          eventId,
          'pay_2',
          email,
          1500,
          3,
          true,
          'paid',
        ]);
        await database.pg.query(
          `INSERT INTO attempts (account_email, kind, delta, idempotency_key, order_id)
           VALUES ($1, 'grant', 3, $2, $3)`,
          [email, `dodo:event:${eventId}`, order.rows[0]?.id ?? ''],
        );
        await database.pg.exec('COMMIT');
        return null;
      } catch (error) {
        await expectRejection(database.pg, 'ROLLBACK');
        return error instanceof Error ? error.message : String(error);
      }
    };

    expect(await grantThreeInOneTransaction('evt_retry')).toBeNull();
    // $15 = 3 attempts (brief §2.3).
    const first = await database.pg.query<{ balance: number }>(`SELECT attempt_balance($1) AS balance`, [email]);
    expect(Number(first.rows[0]?.balance)).toBe(3);

    expect(await grantThreeInOneTransaction('evt_retry')).toMatch(/orders_provider_event_uk/);
    const second = await database.pg.query<{ balance: number }>(`SELECT attempt_balance($1) AS balance`, [email]);
    expect(Number(second.rows[0]?.balance)).toBe(3);
  });

  it('lets a refund of the same payment through, because it is a different event', async () => {
    // The unique is on the EVENT, not the payment. A refund or a dispute shares
    // `provider_payment_id` with the charge and must not be mistaken for a
    // duplicate of it — `brief §2.2` prices both, so both have to be recordable.
    await database.pg.query(INSERT_ORDER, ['evt_charge', 'pay_3', 'b@example.com', 500, 1, false, 'paid']);
    await database.pg.query(INSERT_ORDER, ['evt_refund', 'pay_3', 'b@example.com', 500, 0, false, 'refunded']);

    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM orders WHERE provider_payment_id = 'pay_3'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(2);
  });
});

describe('only a paid order grants attempts', () => {
  it('refuses a refunded event that grants attempts', async () => {
    const message = await expectRejection(database.pg, INSERT_ORDER, [
      'evt_bad_refund',
      'pay_4',
      'c@example.com',
      500,
      1,
      false,
      'refunded',
    ]);
    expect(message).toMatch(/orders_grants_only_when_paid/);
  });

  it('refuses a disputed event that grants attempts', async () => {
    const message = await expectRejection(database.pg, INSERT_ORDER, [
      'evt_bad_dispute',
      'pay_5',
      'c@example.com',
      500,
      1,
      false,
      'disputed',
    ]);
    expect(message).toMatch(/orders_grants_only_when_paid/);
  });
});

describe('the account key is one identity', () => {
  it('refuses a mixed-case email, so one payer cannot become two balances', async () => {
    const message = await expectRejection(database.pg, INSERT_ORDER, [
      'evt_case',
      'pay_6',
      'Mixed@Example.com',
      500,
      1,
      false,
      'paid',
    ]);
    expect(message).toMatch(/orders_email_lowercase/);
  });
});

describe('a double-clicked submit cannot buy twice (brief §2.2)', () => {
  it('refuses a second job with the same idempotency key', async () => {
    const category = await database.pg.query<{ id: string }>(
      `INSERT INTO categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
       VALUES ('idem', 'Idem', 'b2b', 'v1', 'v1', 'snap-1') RETURNING id`,
    );
    const categoryId = category.rows[0]?.id ?? '';

    const insertJob = `INSERT INTO jobs (kind, status, category_id, account_email, idempotency_key,
                                         prompt_version, persona_version, category_snapshot_version, engine_version)
                       VALUES ('preview', 'queued', $1, 'd@example.com', 'submit-abc', 'v1', 'v1', 'snap-1', '0.1.0')`;

    await database.pg.query(insertJob, [categoryId]);
    const message = await expectRejection(database.pg, insertJob, [categoryId]);
    expect(message).toMatch(/jobs_idempotency_key_uk/);
  });
});
