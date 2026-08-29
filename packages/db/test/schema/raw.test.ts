/**
 * The raw source-of-truth tables, and the rules that keep them recomputable.
 *
 * `02 §7`: Postgres stores the raw score log, cluster assignments and demand
 * votes "rather than only the reduced ranking" because "incremental placement and
 * exact recomputation both require the raw inputs". `brief` Part 7 calls the
 * score log the integrity record if a ranking is disputed.
 *
 * A record only counts as one if it cannot quietly hold a second vote from the
 * same juror, a product in two clusters, or a row whose `category_id` disagrees
 * with its product's — each of which changes a published number with nothing to
 * show for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, indexesOf, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { insertCategory, insertCluster, insertProduct } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const freshSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

describe('score_rows', () => {
  const INSERT = `INSERT INTO score_rows (product_id, category_id, juror_role, metric, score, deductions, prompt_version)
                  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`;

  it('refuses a second score from the same juror on the same metric', async () => {
    // `01 §6.1` z-normalizes per juror per metric across products. A duplicate
    // row silently doubles that juror's weight in the normalization.
    const categoryId = await insertCategory(database.pg, freshSlug('score'));
    const productId = await insertProduct(database.pg, categoryId);

    await database.pg.query(INSERT, [productId, categoryId, 'The Docs Writer', 'Workflow Fit', 80, '[]', 'v2']);
    const message = await expectRejection(database.pg, INSERT, [
      productId,
      categoryId,
      'The Docs Writer',
      'Workflow Fit',
      70,
      '[]',
      'v2',
    ]);
    expect(message).toMatch(/score_rows_cell_uk/);
  });

  it('lets the same cell coexist under a different prompt_version', async () => {
    // `brief` Part 3 pre-announces a panel change and keeps old boards
    // addressable. A re-score under a new jury must sit beside the old one
    // rather than overwrite the evidence for a board already published.
    const categoryId = await insertCategory(database.pg, freshSlug('rescore'));
    const productId = await insertProduct(database.pg, categoryId);

    await database.pg.query(INSERT, [productId, categoryId, 'The Docs Writer', 'Workflow Fit', 80, '[]', 'v2']);
    await database.pg.query(INSERT, [productId, categoryId, 'The Docs Writer', 'Workflow Fit', 70, '[]', 'v3']);

    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM score_rows WHERE product_id = $1`,
      [productId],
    );
    expect(Number(result.rows[0]?.count)).toBe(2);
  });

  it('refuses a score outside 0-100', async () => {
    // `01 §5.1`: every metric starts at 100 and points come off. `01 §6`'s clamp
    // guards the arithmetic against a malformed response; it is not a licence to
    // store one.
    const categoryId = await insertCategory(database.pg, freshSlug('range'));
    const productId = await insertProduct(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [
      productId,
      categoryId,
      'The Docs Writer',
      'Workflow Fit',
      101,
      '[]',
      'v2',
    ]);
    expect(message).toMatch(/score_rows_score_range/);
  });

  it('refuses a category_id that disagrees with the product it names', async () => {
    // The denormalized `category_id` exists so a whole category's raw log is one
    // indexed read. The composite foreign key is what stops the copy from ever
    // drifting from the original.
    const categoryA = await insertCategory(database.pg, freshSlug('cat-a'));
    const categoryB = await insertCategory(database.pg, freshSlug('cat-b'));
    const productInA = await insertProduct(database.pg, categoryA);

    const message = await expectRejection(database.pg, INSERT, [
      productInA,
      categoryB,
      'The Docs Writer',
      'Workflow Fit',
      80,
      '[]',
      'v2',
    ]);
    expect(message).toMatch(/score_rows_product_fk/);
  });

  it('refuses deductions that are not a JSON array', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('deduct'));
    const productId = await insertProduct(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [
      productId,
      categoryId,
      'The Docs Writer',
      'Workflow Fit',
      80,
      '{"points": 20}',
      'v2',
    ]);
    expect(message).toMatch(/score_rows_deductions_is_array/);
  });
});

describe('cluster_members', () => {
  const INSERT = `INSERT INTO cluster_members (cluster_id, product_id, category_id, uniqueness_score, reason, uniqueness_version)
                  VALUES ($1, $2, $3, $4, 'because', 'u1')`;

  it('refuses a product in two clusters of the same pass', async () => {
    // `01 §5.2` partitions the category. A product in two clusters is put to two
    // forced choices and counted twice in `breadth`, which is 40% of demand.
    const categoryId = await insertCategory(database.pg, freshSlug('two-clusters'));
    const productId = await insertProduct(database.pg, categoryId);
    const clusterA = await insertCluster(database.pg, categoryId, 'c1-a');
    const clusterB = await insertCluster(database.pg, categoryId, 'c2-b');

    await database.pg.query(INSERT, [clusterA, productId, categoryId, 50]);
    const message = await expectRejection(database.pg, INSERT, [clusterB, productId, categoryId, 50]);
    expect(message).toMatch(/cluster_members_one_cluster_per_pass_uk/);
  });

  it('refuses a scarcity score outside 0-100', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('scarcity'));
    const productId = await insertProduct(database.pg, categoryId);
    const clusterId = await insertCluster(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [clusterId, productId, categoryId, 101]);
    expect(message).toMatch(/cluster_members_uniqueness_range/);
  });

  it('refuses a product joining a cluster in another category', async () => {
    const categoryA = await insertCategory(database.pg, freshSlug('member-a'));
    const categoryB = await insertCategory(database.pg, freshSlug('member-b'));
    const productInA = await insertProduct(database.pg, categoryA);
    const clusterInB = await insertCluster(database.pg, categoryB);

    // `01 §9` rule 2: one category at a time, never a cross-category anything.
    const message = await expectRejection(database.pg, INSERT, [clusterInB, productInA, categoryA, 50]);
    expect(message).toMatch(/cluster_members_cluster_fk/);
  });
});

describe('demand_votes', () => {
  const INSERT = `INSERT INTO demand_votes
      (category_id, cluster_id, product_id, persona_name, pick, strength, reason, persona_version, uniqueness_version)
    VALUES ($1, $2, $3, $4, $5, $6, 'because', 'v1', 'u1')`;

  it('records a refusal with no product', async () => {
    // `01 §5.3`'s `none: true`. `reduceDemand` counts it: a cluster every persona
    // declined reduces to a real demand of 0, which is a different fact from a
    // cluster nobody was asked about.
    const categoryId = await insertCategory(database.pg, freshSlug('none'));
    const clusterId = await insertCluster(database.pg, categoryId);

    await database.pg.query(INSERT, [categoryId, clusterId, null, 'Priya', 'none', null]);
    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM demand_votes WHERE pick = 'none'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it('refuses a refusal that names a product', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('none-product'));
    const clusterId = await insertCluster(database.pg, categoryId);
    const productId = await insertProduct(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [
      categoryId,
      clusterId,
      productId,
      'Priya',
      'none',
      null,
    ]);
    expect(message).toMatch(/demand_votes_none_has_no_product/);
  });

  it('refuses a pick that names no product', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('pick-null'));
    const clusterId = await insertCluster(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [categoryId, clusterId, null, 'Priya', 'first', 60]);
    expect(message).toMatch(/demand_votes_none_has_no_product/);
  });

  it('refuses a strength on a runner-up', async () => {
    // `01 §6.2` appends conviction only to a persona's FIRST pick, so intensity
    // stays a measure of what a buyer actually chose. A strength on a runner-up
    // would be averaged into `intensity` as if it had been chosen outright.
    const categoryId = await insertCategory(database.pg, freshSlug('second-strength'));
    const clusterId = await insertCluster(database.pg, categoryId);
    const productId = await insertProduct(database.pg, categoryId);

    const message = await expectRejection(database.pg, INSERT, [
      categoryId,
      clusterId,
      productId,
      'Priya',
      'second',
      60,
    ]);
    expect(message).toMatch(/demand_votes_strength_only_on_first/);
  });

  it('refuses a second first-pick from the same persona in one cluster', async () => {
    // `01 §5.3` gives each persona ONE forced choice per cluster. A duplicate
    // inflates that product's in-cluster vote share.
    const categoryId = await insertCategory(database.pg, freshSlug('double-vote'));
    const clusterId = await insertCluster(database.pg, categoryId);
    const productA = await insertProduct(database.pg, categoryId, 0, 'a.example.com');
    const productB = await insertProduct(database.pg, categoryId, 1, 'b.example.com');

    await database.pg.query(INSERT, [categoryId, clusterId, productA, 'Priya', 'first', 60]);
    const message = await expectRejection(database.pg, INSERT, [
      categoryId,
      clusterId,
      productB,
      'Priya',
      'first',
      90,
    ]);
    expect(message).toMatch(/demand_votes_one_per_slot_uk/);
  });

  it('allows the same persona a first pick and a runner-up in one cluster', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('first-second'));
    const clusterId = await insertCluster(database.pg, categoryId);
    const productA = await insertProduct(database.pg, categoryId, 0, 'a.example.com');
    const productB = await insertProduct(database.pg, categoryId, 1, 'b.example.com');

    await database.pg.query(INSERT, [categoryId, clusterId, productA, 'Priya', 'first', 60]);
    await database.pg.query(INSERT, [categoryId, clusterId, productB, 'Priya', 'second', null]);

    const result = await database.pg.query<{ count: string }>(
      `SELECT count(*) AS count FROM demand_votes WHERE cluster_id = $1 AND persona_name = 'Priya'`,
      [clusterId],
    );
    expect(Number(result.rows[0]?.count)).toBe(2);
  });
});

describe('mob_votes (brief Part 4)', () => {
  it('refuses a second vote from one visitor in one cluster', async () => {
    // The Mob's value is that it is a real human dataset. One voter with a
    // refresh key manufacturing a Mob/Floor divergence destroys exactly that.
    const categoryId = await insertCategory(database.pg, freshSlug('mob'));
    const clusterId = await insertCluster(database.pg, categoryId);
    const productA = await insertProduct(database.pg, categoryId, 0, 'a.example.com');
    const productB = await insertProduct(database.pg, categoryId, 1, 'b.example.com');

    const INSERT = `INSERT INTO mob_votes (category_id, cluster_id, product_id, pick, voter_id, uniqueness_version)
                    VALUES ($1, $2, $3, 'first', 'voter-1', 'u1')`;

    await database.pg.query(INSERT, [categoryId, clusterId, productA]);
    const message = await expectRejection(database.pg, INSERT, [categoryId, clusterId, productB]);
    expect(message).toMatch(/mob_votes_one_per_slot_uk/);
  });
});

describe('products', () => {
  it('indexes normalized_url — the key the per-product cap hangs off (brief §2.5)', async () => {
    const indexes = await indexesOf(database.pg, 'products');
    const definition = indexes.get('products_normalized_url_idx');
    expect(definition).toBeDefined();
    expect(definition).toMatch(/\(normalized_url\)/);
  });

  it('does not make normalized_url unique — evasion is flagged, not blocked (brief §2.5)', async () => {
    // "Evasion via a genuinely different URL: flag for review, do not hard-block.
    // A false rejection on a paying customer is worse than an extra run." A
    // unique index would also break `§2.4`'s re-pitch, where a replacement
    // listing legitimately shares a URL with the one it supersedes.
    const indexes = await indexesOf(database.pg, 'products');
    expect(indexes.get('products_normalized_url_idx')).not.toMatch(/UNIQUE/i);
  });

  it('refuses a normalized_url that still carries its scheme', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('scheme'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description, description_hash,
                             source, status)
       VALUES ($1, 0, 'n', 'https://x.com', 'https://x.com', 'd', $2, 'seeded', 'pending')`,
      [categoryId, '0'.repeat(64)],
    );
    expect(message).toMatch(/products_normalized_url_shape/);
  });

  it('refuses a description over the 300-character limit (DECISIONS.md S5)', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('longdesc'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description, description_hash,
                             source, status)
       VALUES ($1, 0, 'n', 'https://x.com', 'x.com', repeat('a', 301), $2, 'seeded', 'pending')`,
      [categoryId, '0'.repeat(64)],
    );
    expect(message).toMatch(/products_description_limit/);
  });

  it('refuses a seeded product with a submitter, and a paid one without', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('source'));
    const base = `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description,
                                        description_hash, source, status, submitted_by_email)
                  VALUES ($1, $2, 'n', 'https://x.com', 'x.com', 'd', $3, $4, 'pending', $5)`;

    expect(
      await expectRejection(database.pg, base, [categoryId, 0, '0'.repeat(64), 'seeded', 'a@example.com']),
    ).toMatch(/products_source_submitter/);
    expect(await expectRejection(database.pg, base, [categoryId, 1, '0'.repeat(64), 'paid', null])).toMatch(
      /products_source_submitter/,
    );
  });

  it('refuses a placed product with no placement time', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('placed'));
    const message = await expectRejection(
      database.pg,
      `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description, description_hash,
                             source, status)
       VALUES ($1, 0, 'n', 'https://x.com', 'x.com', 'd', $2, 'seeded', 'placed')`,
      [categoryId, '0'.repeat(64)],
    );
    expect(message).toMatch(/products_placed_at_matches_status/);
  });
});
