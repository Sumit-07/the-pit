/**
 * `snapshots` and `rankings` — the derived artifacts.
 *
 * These are caches of an arithmetic over the raw tables, so what has to be
 * enforced is that a cache cannot be *incoherent*: a board with two products at
 * rank 3, a solo-cluster row carrying a demand number, or two boards claiming the
 * same population version.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { insertCategory, insertProduct } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const freshSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

async function insertSnapshot(categoryId: string, version = 'snap-1'): Promise<string> {
  const result = await database.pg.query<{ id: string }>(
    `INSERT INTO snapshots (category_id, category_snapshot_version, prompt_version, persona_version,
                            uniqueness_version, product_count, document, health)
     VALUES ($1, $2, 'v2', 'v1', 'u2', 2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
    [categoryId, version],
  );
  return result.rows[0]?.id ?? '';
}

const INSERT_RANKING = `INSERT INTO rankings
    (snapshot_id, category_id, product_id, rank, composite, demand, demand_status, core, tiebroken)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`;

describe('rankings', () => {
  it('refuses two products at the same rank', async () => {
    // `rank_final` emits a dense 1..n permutation. A duplicate rank means the
    // write was partial or was computed against a different population — either
    // way the board is not the one the raw rows describe.
    const categoryId = await insertCategory(database.pg, freshSlug('rank-dup'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');
    const b = await insertProduct(database.pg, categoryId, 1, 'b.example.com');

    await database.pg.query(INSERT_RANKING, [snapshotId, categoryId, a, 1, 1.5, 0.7, 'scored', 1.7]);
    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryId,
      b,
      1,
      1.2,
      0.6,
      'scored',
      1.4,
    ]);
    expect(message).toMatch(/rankings_snapshot_rank_uk/);
  });

  it('refuses one product appearing twice on a board', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('rank-twice'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');

    await database.pg.query(INSERT_RANKING, [snapshotId, categoryId, a, 1, 1.5, 0.7, 'scored', 1.7]);
    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryId,
      a,
      2,
      1.5,
      0.7,
      'scored',
      1.7,
    ]);
    expect(message).toMatch(/rankings_snapshot_product_uk/);
  });

  it('refuses a solo_cluster row that carries a demand number', async () => {
    // `DECISIONS.md` S3: a solo-cluster product has NO demand entry and ranks on
    // merit renormalized to weight 1.0. It is not a product with `z_demand = 0`,
    // and the verdict page has to be able to say which it is.
    const categoryId = await insertCategory(database.pg, freshSlug('solo'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');

    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryId,
      a,
      1,
      1.5,
      0.0,
      'solo_cluster',
      1.5,
    ]);
    expect(message).toMatch(/rankings_demand_matches_status/);
  });

  it('refuses a scored row with no demand number', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('scored-null'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');

    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryId,
      a,
      1,
      1.5,
      null,
      'scored',
      1.5,
    ]);
    expect(message).toMatch(/rankings_demand_matches_status/);
  });

  it('accepts a solo_cluster row with no demand', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('solo-ok'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');

    await database.pg.query(INSERT_RANKING, [snapshotId, categoryId, a, 1, 1.5, null, 'solo_cluster', 1.5]);
    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM rankings WHERE snapshot_id = $1`,
      [snapshotId],
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it('refuses a rank of zero', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('rank-zero'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');

    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryId,
      a,
      0,
      1.5,
      0.7,
      'scored',
      1.7,
    ]);
    expect(message).toMatch(/rankings_rank_positive/);
  });

  it('refuses a product from another category on this board', async () => {
    const categoryA = await insertCategory(database.pg, freshSlug('board-a'));
    const categoryB = await insertCategory(database.pg, freshSlug('board-b'));
    const snapshotId = await insertSnapshot(categoryA);
    const productInB = await insertProduct(database.pg, categoryB, 0, 'b.example.com');

    const message = await expectRejection(database.pg, INSERT_RANKING, [
      snapshotId,
      categoryA,
      productInB,
      1,
      1.5,
      0.7,
      'scored',
      1.7,
    ]);
    expect(message).toMatch(/rankings_product_fk/);
  });
});

describe('snapshots', () => {
  it('refuses two boards for one population version', async () => {
    // `brief §1.3` makes `category_snapshot_version` part of the preview cache
    // key. Two snapshots under one version make that key name a board and get
    // two different answers.
    const categoryId = await insertCategory(database.pg, freshSlug('snap-dup'));
    await insertSnapshot(categoryId, 'snap-7');
    const message = await expectRejection(
      database.pg,
      `INSERT INTO snapshots (category_id, category_snapshot_version, prompt_version, persona_version,
                              uniqueness_version, product_count, document, health)
       VALUES ($1, 'snap-7', 'v2', 'v1', 'u2', 2, '{}'::jsonb, '{}'::jsonb)`,
      [categoryId],
    );
    expect(message).toMatch(/snapshots_category_version_uk/);
  });

  it('keeps older versions addressable alongside the newest (brief Part 3)', async () => {
    // "Keep old snapshots permanently addressable at dated URLs so issued verdict
    // cards still resolve."
    const categoryId = await insertCategory(database.pg, freshSlug('snap-history'));
    await insertSnapshot(categoryId, 'snap-1');
    await insertSnapshot(categoryId, 'snap-2');

    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM snapshots WHERE category_id = $1`,
      [categoryId],
    );
    expect(Number(result.rows[0]?.count)).toBe(2);
  });

  it('refuses a published snapshot with no URL', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('snap-url'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO snapshots (category_id, category_snapshot_version, prompt_version, persona_version,
                              uniqueness_version, product_count, document, health, published_at)
       VALUES ($1, 'snap-9', 'v2', 'v1', 'u2', 2, '{}'::jsonb, '{}'::jsonb, now())`,
      [categoryId],
    );
    expect(message).toMatch(/snapshots_url_only_when_published/);
  });

  it('cascades its rankings away when the derived board is rebuilt', async () => {
    // `rankings` is the snapshot's body and is rebuildable from the raw tables.
    // Everything upstream of it uses RESTRICT instead, so no delete can take the
    // integrity record with it.
    const categoryId = await insertCategory(database.pg, freshSlug('cascade'));
    const snapshotId = await insertSnapshot(categoryId);
    const a = await insertProduct(database.pg, categoryId, 0, 'a.example.com');
    await database.pg.query(INSERT_RANKING, [snapshotId, categoryId, a, 1, 1.5, 0.7, 'scored', 1.7]);

    await database.pg.query(`DELETE FROM snapshots WHERE id = $1`, [snapshotId]);
    const rows = await database.pg.query(`SELECT 1 FROM rankings WHERE snapshot_id = $1`, [snapshotId]);
    expect(rows.rows).toHaveLength(0);

    // And the product it referenced is untouched.
    const product = await database.pg.query(`SELECT 1 FROM products WHERE id = $1`, [a]);
    expect(product.rows).toHaveLength(1);
  });
});

describe('the raw tables refuse to be deleted out from under a board', () => {
  it('refuses to delete a product that has score rows', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('restrict'));
    const productId = await insertProduct(database.pg, categoryId);
    await database.pg.query(
      `INSERT INTO score_rows (product_id, category_id, juror_role, metric, score, prompt_version)
       VALUES ($1, $2, 'The Docs Writer', 'Workflow Fit', 80, 'v2')`,
      [productId, categoryId],
    );

    const message = await expectRejection(database.pg, `DELETE FROM products WHERE id = $1`, [productId]);
    expect(message).toMatch(/score_rows_product_fk|violates foreign key/);
  });
});

describe('jobs', () => {
  it('refuses a delivery time on a job that has not succeeded', async () => {
    // `delivered_at` is what unlocks the attempt decrement (`brief §2.3`).
    // Nothing but a succeeded job may carry one.
    const categoryId = await insertCategory(database.pg, freshSlug('job-delivered'));
    const productId = await insertProduct(database.pg, categoryId);
    const message = await expectRejection(
      database.pg,
      `INSERT INTO jobs (kind, status, category_id, product_id, account_email,
                         prompt_version, persona_version, category_snapshot_version, engine_version, delivered_at)
       VALUES ('placement', 'running', $1, $2, 'a@example.com', 'v1', 'v1', 'snap-1', '0.1.0', now())`,
      [categoryId, productId],
    );
    expect(message).toMatch(/jobs_delivered_only_when_succeeded/);
  });

  it('caps free retries at three (brief §2.3)', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('job-retry'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO jobs (kind, status, category_id, prompt_version, persona_version,
                         category_snapshot_version, engine_version, retry_count)
       VALUES ('preview', 'failed', $1, 'v1', 'v1', 'snap-1', '0.1.0', 4)`,
      [categoryId],
    );
    expect(message).toMatch(/jobs_retry_count_cap/);
  });

  it('refuses a preview job that persists a product (DECISIONS.md S13)', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('job-preview'));
    const productId = await insertProduct(database.pg, categoryId);
    const message = await expectRejection(
      database.pg,
      `INSERT INTO jobs (kind, status, category_id, product_id, prompt_version, persona_version,
                         category_snapshot_version, engine_version)
       VALUES ('preview', 'queued', $1, $2, 'v1', 'v1', 'snap-1', '0.1.0')`,
      [categoryId, productId],
    );
    expect(message).toMatch(/jobs_preview_has_no_product/);
  });

  it('refuses a placement with no payer', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('job-placement'));
    const productId = await insertProduct(database.pg, categoryId);
    const message = await expectRejection(
      database.pg,
      `INSERT INTO jobs (kind, status, category_id, product_id, prompt_version, persona_version,
                         category_snapshot_version, engine_version)
       VALUES ('placement', 'queued', $1, $2, 'v1', 'v1', 'snap-1', '0.1.0')`,
      [categoryId, productId],
    );
    expect(message).toMatch(/jobs_placement_has_product_and_account/);
  });
});
