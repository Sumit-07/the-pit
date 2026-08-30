/**
 * The three reads behind `/account`, run against Postgres.
 *
 * `brief §2.1`: "Attempt balance and history are behind the session." These are
 * the queries that sit behind it, and the properties worth executing rather than
 * asserting in prose:
 *
 * - The balance is a FOLD over `attempts`, so a grant and a consume that happened
 *   in either order reach the same number, and no cached column can disagree with
 *   the rows the customer would be shown in a dispute.
 * - `purchases` shows the rows that GRANTED. A refund event on the same payment is
 *   recorded and is not a purchase.
 * - `listings` resolves the account id to the payer's address inside the
 *   statement, so it cannot be handed a mismatched pair — and it returns the
 *   LATEST verdict per product, because `brief §2.4` makes a new attempt replace
 *   the listing while the older verdict URLs keep resolving.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/client.js';
import type { PostgresAccountStore } from '../src/account-store.js';
import { createPostgresAccountStore } from '../src/account-store.js';
import { readMigrations } from '../src/migrations.js';
import * as schema from '../src/schema/index.js';

let pg: PGlite;
let db: Database;
let store: PostgresAccountStore;

const PAYER = 'payer@example.com';
const STRANGER = 'someone-else@example.com';
const HASH = 'b'.repeat(64);

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
  store = createPostgresAccountStore(db);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // TRUNCATE: `attempts_immutable` and `verdicts_immutable` refuse DELETE, which
  // is the guarantee those tables exist to make. See `payments-store.test.ts`.
  await pg.exec(
    'truncate attempts, orders, verdicts, jobs, products, categories, accounts restart identity cascade;',
  );
});

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query<T>(sql, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no row from ${sql.slice(0, 60)}`);
  return row;
}

async function seedAccount(email: string): Promise<string> {
  const row = await one<{ id: string }>('insert into accounts (email) values ($1) returning id', [email]);
  return row.id;
}

async function seedCategory(slug: string): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
     values ($1, $2, 'b2b', 'p1', 'q1', 'c1') returning id`,
    [slug, slug],
  );
  return row.id;
}

async function seedProduct(input: {
  categoryId: string;
  engineId: number;
  name: string;
  email: string | null;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into products
       (category_id, engine_id, name, url, normalized_url, description, description_hash,
        source, status, anonymous, submitted_by_email, placed_at)
     values ($1, $2, $3, $4, $5, 'Does a thing.', $6, $7::product_source, 'placed', $7::product_source = 'seeded', $8, now())
     returning id`,
    [
      input.categoryId,
      input.engineId,
      input.name,
      `https://${input.name.toLowerCase()}.dev/`,
      `${input.name.toLowerCase()}.dev`,
      HASH,
      input.email === null ? 'seeded' : 'paid',
      input.email,
    ],
  );
  return row.id;
}

async function seedDeliveredVerdict(input: {
  categoryId: string;
  productId: string;
  accountId: string;
  email: string;
  attemptNumber: number;
  slug: string;
  deliveredAt: string;
}): Promise<void> {
  const job = await one<{ id: string }>(
    `insert into jobs
       (kind, status, category_id, product_id, account_email,
        prompt_version, persona_version, category_snapshot_version, engine_version, delivered_at)
     values ('placement', 'succeeded', $1, $2, $3, 'p1', 'q1', 'c1', 'e1', $4) returning id`,
    [input.categoryId, input.productId, input.email, input.deliveredAt],
  );
  await pg.query(
    `insert into verdicts
       (public_slug, product_id, job_id, account_id, attempt_number, payload, product_count, delivered_at)
     values ($1, $2, $3, $4, $5, '{"kind":"verdict"}'::jsonb, 48, $6)`,
    [input.slug, input.productId, job.id, input.accountId, input.attemptNumber, input.deliveredAt],
  );
}

async function seedOrder(input: {
  accountId: string;
  eventId: string;
  paymentId: string;
  amountCents: number;
  attemptsGranted: number;
  fitReport?: boolean;
  createdAt: string;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into orders
       (provider, provider_event_id, provider_payment_id, account_id, amount_cents, currency,
        attempts_granted, includes_fit_report, status, raw_event, created_at)
     values ('dodo', $1, $2, $3, $4, 'USD', $5, $6, $7, '{}'::jsonb, $8) returning id`,
    [
      input.eventId,
      input.paymentId,
      input.accountId,
      input.amountCents,
      input.attemptsGranted,
      input.fitReport ?? false,
      input.attemptsGranted > 0 ? 'paid' : 'refunded',
      input.createdAt,
    ],
  );
  return row.id;
}

describe('balance', () => {
  it('is zero for an account that has never bought anything', async () => {
    const accountId = await seedAccount(PAYER);
    expect(await store.balance(accountId)).toBe(0);
  });

  it('folds the ledger rather than reading a column', async () => {
    const accountId = await seedAccount(PAYER);
    const categoryId = await seedCategory('developer-tools');
    const productId = await seedProduct({ categoryId, engineId: 0, name: 'Runlet', email: PAYER });

    const orderId = await seedOrder({
      accountId,
      eventId: 'evt_1',
      paymentId: 'pay_1',
      amountCents: 1500,
      attemptsGranted: 3,
      fitReport: true,
      createdAt: '2026-06-01T00:00:00Z',
    });
    await pg.query(
      `insert into attempts (account_id, kind, delta, idempotency_key, order_id)
       values ($1, 'grant', 3, 'dodo:event:evt_1', $2)`,
      [accountId, orderId],
    );

    const job = await one<{ id: string }>(
      `insert into jobs
         (kind, status, category_id, product_id, account_email,
          prompt_version, persona_version, category_snapshot_version, engine_version, delivered_at)
       values ('placement', 'succeeded', $1, $2, $3, 'p1', 'q1', 'c1', 'e1', now()) returning id`,
      [categoryId, productId, PAYER],
    );
    await pg.query(
      `insert into attempts (account_id, kind, delta, idempotency_key, job_id, product_id)
       values ($1, 'consume', -1, 'delivery:run:r1', $2, $3)`,
      [accountId, job.id, productId],
    );

    // 3 bought, 1 delivered. The number the page shows is the sum, and the two
    // rows behind it are what answers "I paid for three and got one".
    expect(await store.balance(accountId)).toBe(2);
  });
});

describe('purchases', () => {
  it('lists the orders that granted, newest first', async () => {
    const accountId = await seedAccount(PAYER);
    await seedOrder({
      accountId,
      eventId: 'evt_1',
      paymentId: 'pay_1',
      amountCents: 500,
      attemptsGranted: 1,
      createdAt: '2026-05-01T00:00:00Z',
    });
    await seedOrder({
      accountId,
      eventId: 'evt_2',
      paymentId: 'pay_2',
      amountCents: 1500,
      attemptsGranted: 3,
      fitReport: true,
      createdAt: '2026-06-01T00:00:00Z',
    });

    const rows = await store.purchases(accountId);
    expect(rows.map((row) => [row.amountCents, row.attemptsGranted, row.includesFitReport])).toEqual([
      [1500, 3, true],
      [500, 1, false],
    ]);
  });

  it('leaves out an event that granted nothing', async () => {
    // A refund on the same payment is recorded, prices at $1 (`brief §2.2`), and
    // is not something the customer bought.
    const accountId = await seedAccount(PAYER);
    await seedOrder({
      accountId,
      eventId: 'evt_1',
      paymentId: 'pay_1',
      amountCents: 500,
      attemptsGranted: 1,
      createdAt: '2026-05-01T00:00:00Z',
    });
    await seedOrder({
      accountId,
      eventId: 'evt_refund',
      paymentId: 'pay_1',
      amountCents: 500,
      attemptsGranted: 0,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const rows = await store.purchases(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptsGranted).toBe(1);
  });

  it('shows one account nothing of another account’s', async () => {
    const mine = await seedAccount(PAYER);
    const theirs = await seedAccount(STRANGER);
    await seedOrder({
      accountId: theirs,
      eventId: 'evt_x',
      paymentId: 'pay_x',
      amountCents: 500,
      attemptsGranted: 1,
      createdAt: '2026-05-01T00:00:00Z',
    });

    expect(await store.purchases(mine)).toEqual([]);
  });
});

describe('listings', () => {
  it('returns the account’s products with the verdict slug to link to', async () => {
    const accountId = await seedAccount(PAYER);
    const categoryId = await seedCategory('developer-tools');
    const productId = await seedProduct({ categoryId, engineId: 0, name: 'Runlet', email: PAYER });
    await seedDeliveredVerdict({
      categoryId,
      productId,
      accountId,
      email: PAYER,
      attemptNumber: 1,
      slug: 'runlet-first-pitch',
      deliveredAt: '2026-06-01T00:00:00Z',
    });

    const rows = await store.listings(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Runlet');
    expect(rows[0]?.categorySlug).toBe('developer-tools');
    expect(rows[0]?.verdictSlug).toBe('runlet-first-pitch');
    expect(rows[0]?.attemptNumber).toBe(1);
  });

  it('links the LATEST verdict when a product has been re-pitched', async () => {
    const accountId = await seedAccount(PAYER);
    const categoryId = await seedCategory('developer-tools');
    const productId = await seedProduct({ categoryId, engineId: 0, name: 'Runlet', email: PAYER });
    await seedDeliveredVerdict({
      categoryId,
      productId,
      accountId,
      email: PAYER,
      attemptNumber: 1,
      slug: 'runlet-first-pitch',
      deliveredAt: '2026-06-01T00:00:00Z',
    });
    await seedDeliveredVerdict({
      categoryId,
      productId,
      accountId,
      email: PAYER,
      attemptNumber: 2,
      slug: 'runlet-second-pitch',
      deliveredAt: '2026-06-08T00:00:00Z',
    });

    const rows = await store.listings(accountId);
    // One listing, its current verdict. `brief §2.4`: the new attempt REPLACES
    // the listing. The first verdict's URL still resolves — it is just not what
    // the account page points at.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdictSlug).toBe('runlet-second-pitch');
    expect(rows[0]?.attemptNumber).toBe(2);
  });

  it('returns a listing whose run has not delivered, with no verdict link', async () => {
    const accountId = await seedAccount(PAYER);
    const categoryId = await seedCategory('developer-tools');
    await seedProduct({ categoryId, engineId: 0, name: 'Runlet', email: PAYER });

    const rows = await store.listings(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdictSlug).toBeNull();
    expect(rows[0]?.attemptNumber).toBeNull();
  });

  it('never returns a seeded listing nobody paid for, or another account’s', async () => {
    const accountId = await seedAccount(PAYER);
    await seedAccount(STRANGER);
    const categoryId = await seedCategory('developer-tools');
    await seedProduct({ categoryId, engineId: 0, name: 'Unclaimed', email: null });
    await seedProduct({ categoryId, engineId: 1, name: 'Theirs', email: STRANGER });

    expect(await store.listings(accountId)).toEqual([]);
  });
});
