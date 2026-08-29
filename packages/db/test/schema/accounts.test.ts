/**
 * `accounts` — the identity `brief §2.1` describes and Phase 2 stored as a string.
 *
 * "Dodo collects the email; create the account server-side from the verified
 * email. Attempt balance and history behind the session; verdict URLs public."
 *
 * The tests below are about the two things that makes true which a repeated
 * `account_email` column did not: the address is one row, and a balance belongs
 * to that row rather than to whatever string a writer happened to hold.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { columnsOf, expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { consumeAttempt, grantAttempt, insertAccount, insertCategory, insertJob, insertOrder } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;

describe('the shape of an identity', () => {
  it('has exactly four columns: who they are, two ways to reach them, and since when', async () => {
    // Deliberately no balance column. `brief §2.3`'s balance is a fold over the
    // `attempts` ledger; a cached integer here would be a second answer to the
    // same question, and the one people would UPDATE.
    //
    // `capability_slug` is `0004`'s, appended by ALTER TABLE and therefore last.
    // It is the only column the capability URL needed: rotation must REPLACE a
    // slug, and one column is what makes the old value disappear in the same
    // statement that writes the new one.
    expect(await columnsOf(database.pg, 'accounts')).toEqual(['id', 'email', 'created_at', 'capability_slug']);
  });

  it('refuses something that is not an address', async () => {
    // The realistic failure is not a malformed RFC 5322 mailbox; it is a webhook
    // field moving and this column ending up with a customer id or an empty
    // string. `POST /auth/request` would then mail nothing, forever, silently.
    for (const bad of ['', 'cus_12345', 'nobody@localhost', 'two @spaces.com']) {
      const message = await expectRejection(database.pg, `INSERT INTO accounts (email) VALUES ($1)`, [bad]);
      expect(`${JSON.stringify(bad)}: ${message ?? 'accepted'}`).toMatch(/accounts_email_shape/);
    }
  });
});

describe('a balance belongs to an account, not to a string', () => {
  it('folds the ledger for one account id', async () => {
    // Hand-derived: $15 buys 3 (`brief §2.3`), one delivery spends 1, so 2.
    const account = await insertAccount(database.pg, `balance${(counter += 1)}@example.com`);
    const categoryId = await insertCategory(database.pg, `acct-balance-${counter}`);

    const order = await insertOrder(database.pg, account, { attemptsGranted: 3 });
    await grantAttempt(database.pg, order, account, 3);
    const job = await insertJob(database.pg, categoryId, { delivered: true, account });
    await consumeAttempt(database.pg, job, account);

    const result = await database.pg.query<{ balance: number }>(`SELECT attempt_balance($1) AS balance`, [account.id]);
    expect(Number(result.rows[0]?.balance)).toBe(2);
  });

  it('keeps two accounts apart', async () => {
    // The failure this replaces: `attempts` holding rows for an address that
    // `orders` never saw, because nothing joined the two copies of the string.
    const first = await insertAccount(database.pg, `apart-a${(counter += 1)}@example.com`);
    const second = await insertAccount(database.pg, `apart-b${counter}@example.com`);

    const order = await insertOrder(database.pg, first, { attemptsGranted: 1 });
    await grantAttempt(database.pg, order, first, 1);

    const balances = await database.pg.query<{ a: number; b: number }>(
      `SELECT attempt_balance($1) AS a, attempt_balance($2) AS b`,
      [first.id, second.id],
    );
    expect([Number(balances.rows[0]?.a), Number(balances.rows[0]?.b)]).toEqual([1, 0]);
  });

  it('refuses to delete an account that has spent money', async () => {
    // `ON DELETE restrict`. `brief` Part 7 wants the money-adjacent records to be
    // evidence; a cascading delete would take the receipts with the customer.
    const account = await insertAccount(database.pg, `keepme${(counter += 1)}@example.com`);
    const order = await insertOrder(database.pg, account, { attemptsGranted: 1 });
    await grantAttempt(database.pg, order, account, 1);

    const message = await expectRejection(database.pg, `DELETE FROM accounts WHERE id = $1`, [account.id]);
    expect(message).toMatch(/orders_account_id_accounts_id_fk|attempts_account_id_accounts_id_fk/);
  });
});
