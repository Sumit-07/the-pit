/**
 * Verdicts are append-only.
 *
 * `brief` Part 6 makes the verdict URL public and permanent; Part 7 makes the
 * score log the integrity record. `§2.4` has a re-pitch replace the previous
 * listing, and `DECISIONS.md` S8 has not yet decided what a shared verdict URL
 * shows afterwards.
 *
 * All four readings of S8 need the same storage guarantee, so it is enforced here
 * rather than assumed: a re-pitch writes new rows, and the old ones stay exactly
 * as they were issued. Each test performs the destructive UPDATE that the open
 * decision must not be allowed to require.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { insertCategory, insertJob, insertProduct } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const freshSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

describe('a delivered job is frozen', () => {
  it('refuses to rewrite the verdict payload', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('verdict'));
    const job = await insertJob(database.pg, categoryId, { delivered: true });

    const message = await expectRejection(
      database.pg,
      `UPDATE jobs SET result = '{"rank": 1}'::jsonb WHERE id = $1`,
      [job],
    );
    expect(message).toMatch(/is frozen/);
  });

  it('refuses to re-deliver it under a new timestamp', async () => {
    // Re-delivery is how one job would come to carry two verdicts, and the
    // attempt ledger would have no way to charge for the second.
    const categoryId = await insertCategory(database.pg, freshSlug('redeliver'));
    const job = await insertJob(database.pg, categoryId, { delivered: true });

    const message = await expectRejection(database.pg, `UPDATE jobs SET delivered_at = now() WHERE id = $1`, [job]);
    expect(message).toMatch(/is frozen/);
  });

  it('refuses to delete it', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('deletejob'));
    const job = await insertJob(database.pg, categoryId, { delivered: true });

    const message = await expectRejection(database.pg, `DELETE FROM jobs WHERE id = $1`, [job]);
    expect(message).toMatch(/is frozen/);
  });

  it('still allows an undelivered job to progress and be delivered', async () => {
    // The freeze starts at delivery, not at insert. A running job has to be able
    // to reach `succeeded`.
    const categoryId = await insertCategory(database.pg, freshSlug('progress'));
    const job = await insertJob(database.pg, categoryId, { delivered: false });

    await database.pg.query(`UPDATE jobs SET status = 'succeeded', delivered_at = now() WHERE id = $1`, [job]);
    const result = await database.pg.query<{ delivered_at: string | null }>(
      `SELECT delivered_at FROM jobs WHERE id = $1`,
      [job],
    );
    expect(result.rows[0]?.delivered_at).not.toBeNull();
  });

  it('lets a re-pitch write a second job while the first stays addressable', async () => {
    // This is the property every reading of S8 depends on.
    const categoryId = await insertCategory(database.pg, freshSlug('repitch'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    const first = await insertJob(database.pg, categoryId, { delivered: true, productId });
    const second = await insertJob(database.pg, categoryId, { delivered: true, productId });

    expect(first).not.toBe(second);
    const rows = await database.pg.query<{ id: string }>(
      `SELECT id FROM jobs WHERE product_id = $1 AND delivered_at IS NOT NULL`,
      [productId],
    );
    expect(rows.rows).toHaveLength(2);
  });
});

describe('a published board stays as it was issued', () => {
  async function insertSnapshot(categoryId: string): Promise<string> {
    const result = await database.pg.query<{ id: string }>(
      `INSERT INTO snapshots (category_id, category_snapshot_version, prompt_version, persona_version,
                              uniqueness_version, product_count, document, health)
       VALUES ($1, 'snap-1', 'v2', 'v1', 'u2', 2, '{"a":1}'::jsonb, '{}'::jsonb) RETURNING id`,
      [categoryId],
    );
    return result.rows[0]?.id ?? '';
  }

  it('refuses an edit to the ranking document', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('snapdoc'));
    const snapshotId = await insertSnapshot(categoryId);

    const message = await expectRejection(
      database.pg,
      `UPDATE snapshots SET document = '{"a":2}'::jsonb WHERE id = $1`,
      [snapshotId],
    );
    expect(message).toMatch(/is immutable/);
  });

  it('refuses an edit to the product count a verdict card is stamped with', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('snapcount'));
    const snapshotId = await insertSnapshot(categoryId);

    const message = await expectRejection(database.pg, `UPDATE snapshots SET product_count = 3 WHERE id = $1`, [
      snapshotId,
    ]);
    expect(message).toMatch(/is immutable/);
  });

  it('allows publication exactly once, and refuses to move the URL afterwards', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('snappublish'));
    const snapshotId = await insertSnapshot(categoryId);

    await database.pg.query(`UPDATE snapshots SET url = '/b/snap-1.json', published_at = now() WHERE id = $1`, [
      snapshotId,
    ]);

    const message = await expectRejection(database.pg, `UPDATE snapshots SET url = '/b/other.json' WHERE id = $1`, [
      snapshotId,
    ]);
    expect(message).toMatch(/cannot move/);
  });

  it('refuses to move a rank on an existing board', async () => {
    // `brief §1.2`: appending a product shifts the population and moves every
    // z-score. That is a new board, not an edit to this one.
    const categoryId = await insertCategory(database.pg, freshSlug('rankedit'));
    const snapshotId = await insertSnapshot(categoryId);
    const productId = await insertProduct(database.pg, categoryId, 0);

    await database.pg.query(
      `INSERT INTO rankings (snapshot_id, category_id, product_id, rank, composite, demand, demand_status, core, tiebroken)
       VALUES ($1, $2, $3, 1, 1.5, 0.7, 'scored', 1.7, false)`,
      [snapshotId, categoryId, productId],
    );

    const message = await expectRejection(database.pg, `UPDATE rankings SET rank = 2 WHERE snapshot_id = $1`, [
      snapshotId,
    ]);
    expect(message).toMatch(/rebuilt as a new snapshot/);
  });
});

describe('the pitch that was scored is frozen', () => {
  it('refuses to overwrite the description in place', async () => {
    // Every stored deduction names this product. Replacing the sentence a juror
    // deducted from leaves the score log describing text that no longer exists.
    const categoryId = await insertCategory(database.pg, freshSlug('descr'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET description = 'A different pitch entirely.' WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/is frozen/);
  });

  it('refuses to move the product to another engine id or category', async () => {
    // `engine_id` is what every raw row joins on. Moving it re-attributes every
    // stored score, cluster assignment and vote at once.
    const categoryId = await insertCategory(database.pg, freshSlug('engineid'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    expect(await expectRejection(database.pg, `UPDATE products SET engine_id = 7 WHERE id = $1`, [productId])).toMatch(
      /is frozen/,
    );
  });

  it('still allows the lifecycle to move', async () => {
    // Status, placement and the seeded-listing opt-out (`brief` Part 7) describe
    // what happened to the listing, not what was judged.
    const categoryId = await insertCategory(database.pg, freshSlug('lifecycle'));
    const productId = await insertProduct(database.pg, categoryId, 0);

    await database.pg.query(
      `UPDATE products SET status = 'rejected', placed_at = NULL, opted_out_at = now() WHERE id = $1`,
      [productId],
    );

    const result = await database.pg.query<{ status: string }>(`SELECT status FROM products WHERE id = $1`, [
      productId,
    ]);
    expect(result.rows[0]?.status).toBe('rejected');
  });
});

describe('one payment grants attempts once', () => {
  const INSERT = `INSERT INTO orders
      (provider, provider_event_id, provider_payment_id, account_email, amount_cents, currency,
       attempts_granted, status, raw_event)
    VALUES ('dodo', $1, $2, 'p@example.com', 500, 'USD', $3, $4, '{}'::jsonb)`;

  it('refuses a second granting event for one payment, even under a fresh event id', async () => {
    // The gap the event-id key alone leaves: a retry re-enveloped with a new id,
    // or an authorize/settle pair that both report the charge.
    await database.pg.query(INSERT, ['evt_a1', 'pay_A', 1, 'paid']);

    const message = await expectRejection(database.pg, INSERT, ['evt_a2', 'pay_A', 1, 'paid']);
    expect(message).toMatch(/orders_payment_grant_uk/);
  });

  it('still records a non-granting event on the same payment', async () => {
    // A refund grants nothing, falls outside the partial index, and must still be
    // recordable: `brief §2.2` prices refunds and disputes.
    await database.pg.query(INSERT, ['evt_b1', 'pay_B', 1, 'paid']);
    await database.pg.query(INSERT, ['evt_b2', 'pay_B', 0, 'refunded']);

    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM orders WHERE provider_payment_id = 'pay_B'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(2);
  });

  it('refuses a granting order that names no payment', async () => {
    // NULLs are all distinct to a unique index, so a grant with no payment id
    // would be exempt from the rule above.
    const message = await expectRejection(database.pg, INSERT, ['evt_c1', null, 1, 'paid']);
    expect(message).toMatch(/orders_grant_names_payment/);
  });
});
