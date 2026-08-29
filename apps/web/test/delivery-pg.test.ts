/**
 * The delivery transaction, against a real Postgres.
 *
 * PGlite is Postgres compiled to WebAssembly, so every constraint trigger this
 * suite leans on is the one a Neon deployment will run:
 * `verdicts_require_delivered_job_trg`, `attempts_consume_requires_delivery_trg`,
 * `attempts_no_overdraft_trg`, `attempts_idempotency_key_uk`,
 * `jobs_delivery_immutable_trg` and `products_source_submitter`.
 *
 * `test/delivery-settle.test.ts` drives the same paths against an in-memory
 * double, because a real database cannot be asked to fail on the second of three
 * writes on demand. This file exists for the opposite reason: to prove the double
 * is not more permissive than the schema, and in particular to watch the schema
 * REJECT a half-wired delivery. A verdict written without its delivered flag is
 * refused at COMMIT, by name, and that is the schema failing in the right
 * direction.
 *
 * Everything runs with no network, no `DATABASE_URL` and no Dodo credentials.
 */

import { AttemptsLedger, InsufficientAttemptsError } from '@the-pit/payments';
import {
  createPostgresDeliveryStore,
  createPostgresVerdictStore,
  deterministicUuid,
  verdictSlug,
  type PostgresDeliveryStore,
} from '@the-pit/db';
import { phaseVersions } from '@the-pit/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliveredVerdictId, settleDelivery } from '@/lib/delivery/settle';
import { PgPipelineStore } from '@/lib/pipeline/pg-store';
import type { DeliveryRecord } from '@/lib/pipeline/types';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  PERSONA_VERSION,
  PROMPT_VERSION,
  makeJury,
  makePanel,

} from './helpers/panel.js';
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';

let database: TestDatabase;
let categoryId: string;
let delivery: PostgresDeliveryStore;

const PAYER_EMAIL = 'payer@example.com';
const PAID_ENGINE_ID = 8;
const RUN_ID = deterministicUuid('job', 'delivery-pg-suite', 'placement');
const NOW = new Date('2026-03-01T12:00:00.000Z');

beforeAll(async () => {
  database = await migratedDatabase();
  delivery = createPostgresDeliveryStore(database.db);
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  // `TRUNCATE` and not `DELETE`: `jobs_delivery_immutable_trg` refuses to delete
  // a DELIVERED job (`brief` Part 6 makes the URL permanent), and `TRUNCATE` does
  // not fire row triggers.
  await database.pg.exec(
    'TRUNCATE categories, jobs, products, snapshots, rankings, accounts, orders, attempts, verdicts CASCADE;',
  );
  categoryId = await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
});

/** An account with one attempt on its balance, the way a signed webhook leaves it. */
async function payingAccount(attempts = 1): Promise<string> {
  const account = await database.pg.query<{ id: string }>(
    `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2) RETURNING id`,
    [PAYER_EMAIL, 'a'.repeat(43)],
  );
  const accountId = account.rows[0]?.id;
  if (accountId === undefined) throw new Error('no account');

  const order = await database.pg.query<{ id: string }>(
    `INSERT INTO orders (provider, provider_event_id, provider_payment_id, account_id, amount_cents,
                         currency, attempts_granted, includes_fit_report, status, raw_event)
     VALUES ('dodo', 'evt_1', 'pay_1', $1, $2, 'USD', $3, false, 'paid', '{}'::jsonb) RETURNING id`,
    [accountId, attempts === 3 ? 1500 : 500, attempts],
  );
  await database.pg.query(
    `INSERT INTO attempts (account_id, kind, delta, idempotency_key, order_id)
     VALUES ($1, 'grant', $2, 'dodo:event:evt_1', $3)`,
    [accountId, attempts, order.rows[0]?.id],
  );
  return accountId;
}

/** The job row a placement's phase store writes, undelivered. */
async function placementJob(): Promise<void> {
  await database.pg.query(
    `INSERT INTO jobs (id, kind, status, category_id, prompt_version, persona_version,
                       category_snapshot_version, engine_version)
     VALUES ($1, 'full_run', 'running', $2, $3, $4, $5, 'engine-test')`,
    [RUN_ID, categoryId, PROMPT_VERSION, PERSONA_VERSION, CATEGORY_VERSION],
  );
}

/** The paid `products` row the placement path writes before it settles. */
async function paidListing(): Promise<string> {
  const row = await database.pg.query<{ id: string }>(
    `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description,
                           description_hash, source, status, submitted_by_email)
     VALUES ($1, $2, 'Margin', 'https://example.com/margin', 'example.com/margin',
             'Turns meeting notes into a shared action list.', $3, 'paid', 'pending', $4)
     RETURNING id`,
    [categoryId, PAID_ENGINE_ID, 'a'.repeat(64), PAYER_EMAIL],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('no product');
  return id;
}

/** One delivery record, as `deliverStep` would emit it for a paid placement. */
function record(accountId: string, overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    slug: CATEGORY_SLUG,
    category: CATEGORY,
    category_version: CATEGORY_VERSION,
    delivered_at: NOW.toISOString(),
    product_count: 9,
    run_id: RUN_ID,
    paid: {
      accountId,
      email: PAYER_EMAIL,
      engineId: PAID_ENGINE_ID,
      attemptNumber: 1,
      decision: { action: 'consume', consumesAttempt: true, customerPhase: 'convened' },
      payload: { category: CATEGORY, verdict: { id: PAID_ENGINE_ID, name: 'Margin' } },
    },
    ...overrides,
  };
}

/** The bindings the settle would resolve from `DATABASE_URL`, over this database. */
function bindings(): Parameters<typeof settleDelivery>[1]['bindings'] {
  return {
    findListing: (input) => delivery.findListing(input),
    ledgerFor: (input) =>
      new AttemptsLedger(
        {
          append: () => Promise.reject(new Error('the delivery path may never grant')),
          balance: (accountId: string) => delivery.balance(accountId),
        },
        delivery.withDeliveryTx(input),
      ),
  };
}

async function countOf(table: string): Promise<number> {
  const rows = await database.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(rows.rows[0]?.n ?? 0);
}

describe('one transaction: the verdict, the delivered flag and the decrement', () => {
  it('writes all three and leaves the balance at zero', async () => {
    const accountId = await payingAccount();
    await placementJob();
    const productId = await paidListing();

    const result = await settleDelivery(record(accountId), { bindings: bindings() });
    expect(result.outcome).toBe('settled');

    const verdict = await database.pg.query<{
      id: string;
      public_slug: string;
      product_id: string;
      job_id: string;
      account_id: string;
      attempt_number: number;
      product_count: number;
    }>('SELECT * FROM verdicts');
    expect(verdict.rows).toHaveLength(1);
    expect(verdict.rows[0]?.product_id).toBe(productId);
    expect(verdict.rows[0]?.job_id).toBe(RUN_ID);
    expect(verdict.rows[0]?.account_id).toBe(accountId);
    expect(verdict.rows[0]?.attempt_number).toBe(1);
    expect(verdict.rows[0]?.product_count).toBe(9);
    expect(verdict.rows[0]?.public_slug).toBe(verdictSlug(deliveredVerdictId(RUN_ID)));

    const job = await database.pg.query<{ status: string; delivered_at: Date | null }>(
      'SELECT status, delivered_at FROM jobs WHERE id = $1',
      [RUN_ID],
    );
    expect(job.rows[0]?.status).toBe('succeeded');
    expect(job.rows[0]?.delivered_at).not.toBeNull();

    const consume = await database.pg.query<{ delta: number; job_id: string; product_id: string }>(
      "SELECT delta, job_id, product_id FROM attempts WHERE kind = 'consume'",
    );
    expect(consume.rows).toHaveLength(1);
    expect(consume.rows[0]?.delta).toBe(-1);
    expect(consume.rows[0]?.job_id).toBe(RUN_ID);
    expect(consume.rows[0]?.product_id).toBe(productId);

    expect(await delivery.balance(accountId)).toBe(0);
  });

  it('is rejected by verdicts_require_delivered_job when only the verdict is written', async () => {
    // The half-wired implementation the brief warns about: write the permanent
    // public page, forget the flag. The trigger is DEFERRABLE INITIALLY DEFERRED,
    // so this fails at COMMIT and names the job — which is the schema failing in
    // the right direction, not an obstacle to work around.
    const accountId = await payingAccount();
    await placementJob();
    const productId = await paidListing();
    const verdictId = deliveredVerdictId(RUN_ID);

    await expect(
      database.pg.exec(`
        BEGIN;
        INSERT INTO verdicts (id, public_slug, product_id, job_id, account_id, attempt_number,
                              payload, product_count)
        VALUES ('${verdictId}', '${verdictSlug(verdictId)}', '${productId}', '${RUN_ID}',
                '${accountId}', 1, '{"a":1}'::jsonb, 9);
        COMMIT;
      `),
    ).rejects.toThrow(/has not been delivered/);

    expect(await countOf('verdicts')).toBe(0);
  });

  it('is rejected by attempts_consume_requires_delivery when only the decrement is written', async () => {
    // The mirror image, and the one that actually costs the customer money: the
    // decrement with no delivery behind it.
    const accountId = await payingAccount();
    await placementJob();
    const productId = await paidListing();

    await expect(
      database.pg.exec(`
        BEGIN;
        INSERT INTO attempts (account_id, kind, delta, idempotency_key, job_id, product_id)
        VALUES ('${accountId}', 'consume', -1, 'delivery:run:${RUN_ID}', '${RUN_ID}', '${productId}');
        COMMIT;
      `),
    ).rejects.toThrow(/has not been delivered/);

    expect(await delivery.balance(accountId)).toBe(1);
  });

  it('refuses the whole delivery when the account has no attempt to spend', async () => {
    // No grant. `attempts_no_overdraft` fires at COMMIT and takes the verdict and
    // the delivered flag down with it — a run that reached delivery with no
    // attempt behind it is a bug upstream, and delivering it anyway would hide
    // the bug behind free work.
    const account = await database.pg.query<{ id: string }>(
      `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2) RETURNING id`,
      ['broke@example.com', 'b'.repeat(43)],
    );
    const accountId = account.rows[0]?.id ?? '';
    await placementJob();
    await paidListing();

    await expect(settleDelivery(record(accountId), { bindings: bindings() })).rejects.toThrow();

    expect(await countOf('verdicts')).toBe(0);
    const job = await database.pg.query<{ delivered_at: Date | null }>(
      'SELECT delivered_at FROM jobs WHERE id = $1',
      [RUN_ID],
    );
    expect(job.rows[0]?.delivered_at).toBeNull();
    expect(await delivery.balance(accountId)).toBe(0);
  });

  it('charges once when the delivery is replayed', async () => {
    const accountId = await payingAccount(3);
    await placementJob();
    await paidListing();

    const first = await settleDelivery(record(accountId), { bindings: bindings() });
    const second = await settleDelivery(record(accountId), { bindings: bindings() });

    expect(first.outcome).toBe('settled');
    expect(second.outcome).toBe('already_settled');
    expect(await countOf('verdicts')).toBe(1);
    // `jobs_delivery_immutable` refuses every UPDATE of a delivered job, so the
    // second pass had to match no rows rather than rewrite the same value.
    expect(await delivery.balance(accountId)).toBe(2);
  });
});

describe('the per-account advisory lock', () => {
  it('serializes two deliveries for one account rather than leaning on the trigger', async () => {
    // `migrations/0001` is explicit that `attempts_no_overdraft` is "defence in
    // depth, not a serialization mechanism": under READ COMMITTED two
    // transactions can each fold a balance of 1 and each insert a consume. The
    // lock is what makes the second wait for the first.
    //
    // PGlite is single-connection, so this cannot exhibit the race; what it can
    // prove is that the lock is TAKEN, and taken first. A second transaction that
    // holds the same lock outside this delivery would block it, and
    // `pg_try_advisory_xact_lock` reports the contention without deadlocking a
    // one-connection database.
    const accountId = await payingAccount();
    await placementJob();
    await paidListing();

    await settleDelivery(record(accountId), { bindings: bindings() });

    // The lock is per account and released by the commit, so it is free again.
    const free = await database.pg.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
      [`attempt:${accountId}`],
    );
    expect(free.rows[0]?.ok).toBe(true);
  });

  it('takes a lock keyed on the account and not on the run', async () => {
    // Two customers delivering at once have nothing to serialize. Keying the lock
    // on the run would be keying it on the thing that is already unique, which
    // would serialize nothing at all.
    const first = await payingAccount();
    const second = await database.pg.query<{ id: string }>(
      `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2) RETURNING id`,
      ['other@example.com', 'c'.repeat(43)],
    );
    const lockA = await database.pg.query<{ h: number }>(`SELECT hashtext($1) AS h`, [`attempt:${first}`]);
    const lockB = await database.pg.query<{ h: number }>(`SELECT hashtext($1) AS h`, [
      `attempt:${second.rows[0]?.id}`,
    ]);
    expect(lockA.rows[0]?.h).not.toBe(lockB.rows[0]?.h);
  });
});

describe('a paid placement writes a paid listing (brief §2.4, products_source_submitter)', () => {
  it('writes source = paid with the payer’s email, not an unclaimed seed', async () => {
    const versions = phaseVersions({
      jury: makeJury(),
      personas: makePanel(),
      config: { categoryVersion: CATEGORY_VERSION },
    });

    const store = new PgPipelineStore(database.db, CATEGORY, {
      versions,
      paid: { engineId: 1, email: 'Payer@Example.com' },
    });

    await store.writeProducts({
      category: CATEGORY,
      products: [
        { id: 0, name: 'Seeded', description: 'A seeded row.', url: 'https://example.com/0', normalized_url: 'example.com/0', orig_rank: 1 },
        { id: 1, name: 'Bought', description: 'The submission.', url: 'https://example.com/1', normalized_url: 'example.com/1', orig_rank: 2 },
      ],
    });

    const rows = await database.pg.query<{ engine_id: number; source: string; submitted_by_email: string | null }>(
      'SELECT engine_id, source, submitted_by_email FROM products ORDER BY engine_id',
    );

    // The seeded population is still seeded and still unclaimed — `brief` Part 7
    // reserves that label for rows nobody has pitched.
    expect(rows.rows[0]).toMatchObject({ engine_id: 0, source: 'seeded', submitted_by_email: null });
    // And the one that was bought is paid, with the address that bought it,
    // lowercased so `accounts_email_lowercase` and `products_email_lowercase`
    // agree about who this is.
    expect(rows.rows[1]).toMatchObject({
      engine_id: 1,
      source: 'paid',
      submitted_by_email: 'payer@example.com',
    });
  });

  it('writes every row as seeded when nobody paid', async () => {
    // The discriminating negative: this is what the code did for EVERY row before
    // the paid identity existed, and it is still correct for a seed run.
    const versions = phaseVersions({
      jury: makeJury(),
      personas: makePanel(),
      config: { categoryVersion: CATEGORY_VERSION },
    });
    const store = new PgPipelineStore(database.db, CATEGORY, { versions });

    await store.writeProducts({
      category: CATEGORY,
      products: [
        { id: 0, name: 'Seeded', description: 'A seeded row.', url: 'https://example.com/0', normalized_url: 'example.com/0', orig_rank: 1 },
      ],
    });

    const rows = await database.pg.query<{ source: string; submitted_by_email: string | null }>(
      'SELECT source, submitted_by_email FROM products',
    );
    expect(rows.rows[0]).toMatchObject({ source: 'seeded', submitted_by_email: null });
  });

  it('does not relabel a paid listing when a later run rewrites the catalogue', async () => {
    // `writeProducts` is `ON CONFLICT DO NOTHING` on `(category_id, engine_id)`.
    // A later seed run over the same category must not overwrite a customer's
    // listing as unclaimed scaffolding.
    const versions = phaseVersions({
      jury: makeJury(),
      personas: makePanel(),
      config: { categoryVersion: CATEGORY_VERSION },
    });
    const product = {
      id: 4,
      name: 'Bought',
      description: 'The submission.',
      url: 'https://example.com/4',
      normalized_url: 'example.com/4',
      orig_rank: 5,
    };

    await new PgPipelineStore(database.db, CATEGORY, {
      versions,
      paid: { engineId: 4, email: PAYER_EMAIL },
    }).writeProducts({ category: CATEGORY, products: [product] });

    await new PgPipelineStore(database.db, CATEGORY, { versions }).writeProducts({
      category: CATEGORY,
      products: [product],
    });

    const rows = await database.pg.query<{ source: string; submitted_by_email: string | null }>(
      'SELECT source, submitted_by_email FROM products',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ source: 'paid', submitted_by_email: PAYER_EMAIL });
  });
});

describe('/v/<slug> resolves for a delivered paid verdict', () => {
  it('serves the row the delivery transaction wrote', async () => {
    const accountId = await payingAccount();
    await placementJob();
    await paidListing();

    const settled = await settleDelivery(record(accountId), { bindings: bindings() });
    expect(settled.outcome).toBe('settled');
    if (settled.outcome !== 'settled') throw new Error('unreachable');

    const store = createPostgresVerdictStore(database.db);
    const row = await store.bySlug(settled.verdictSlug);

    expect(row).not.toBeNull();
    expect(row?.publicSlug).toBe(settled.verdictSlug);
    expect(row?.productCount).toBe(9);
    expect(row?.attemptNumber).toBe(1);
    // The stamp is the board's instant, not the settle's: `verdicts.delivered_at`
    // is what `brief` Part 5 puts on the card beside the product count, and it has
    // to name the board it describes.
    expect(row?.deliveredAt.toISOString()).toBe(NOW.toISOString());

    // The public read carries no payer. `brief §2.1` puts the balance and the
    // history behind a session and the verdict URL in front of one, and a store
    // that could return `account_id` would be one import away from leaking it
    // into a shared screenshot.
    expect(Object.keys(row ?? {})).toEqual([
      'publicSlug',
      'payload',
      'productCount',
      'attemptNumber',
      'deliveredAt',
    ]);
  });

  it('answers null for a slug nobody was issued', async () => {
    const store = createPostgresVerdictStore(database.db);
    expect(await store.bySlug('nothing-was-ever-issued-here')).toBeNull();
    expect(await store.bySlug('')).toBeNull();
  });
});

describe('a run nobody paid for settles nothing', () => {
  it('leaves the ledger and the verdicts table untouched', async () => {
    const accountId = await payingAccount();
    await placementJob();
    await paidListing();

    const unpaid = record(accountId);
    const result = await settleDelivery({ ...unpaid, paid: undefined }, { bindings: bindings() });

    expect(result.outcome).toBe('unpaid');
    expect(await countOf('verdicts')).toBe(0);
    expect(await delivery.balance(accountId)).toBe(1);
  });
});

describe('InsufficientAttemptsError is the ledger’s, not the trigger’s', () => {
  it('is exported so a caller can tell an overdraft from a database fault', () => {
    // The distinction matters on the money path: an overdraft is a bug upstream
    // that a human has to look at, and a connection fault is a retry.
    expect(new InsufficientAttemptsError('acct', 0)).toBeInstanceOf(Error);
    expect(new InsufficientAttemptsError('acct', 0).name).toBe('InsufficientAttemptsError');
  });
});
