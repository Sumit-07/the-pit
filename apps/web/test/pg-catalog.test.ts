/**
 * The durable `CategorySource`, against a real Postgres.
 *
 * The claim under test is the one the filesystem source cannot make: **a
 * placement is visible to the next run.**
 *
 * `brief §1.2` says appending a product "shifts the population mean and std and
 * therefore moves every existing z-score", so the placement path does two things
 * — it appends a `products` row and it bumps
 * `categories.category_snapshot_version`. `FileCategorySource` reads a committed
 * `products.json` and a jury file, and can see neither. Bound in production it
 * would score the first real paid submission against a population that excluded
 * it, under a version that had already moved, and produce a board that is simply
 * the wrong numbers — no exception, no failed step, nothing to notice.
 *
 * So the discriminating test below appends and bumps, then reads again through
 * the SAME source object, and asserts the count and the version both moved. A
 * source reading a frozen file, or caching its first answer, fails it.
 *
 * PGlite is Postgres itself, in-process: the real DDL, the real check
 * constraints, the real enums. No `DATABASE_URL`, no network.
 */

import { validateJury, type Product } from '@the-pit/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CategoryNotRunnableError } from '@/lib/pipeline/catalog';
import { PgCategorySource } from '@/lib/pipeline/pg-catalog';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  JURORS,
  METRICS,
  PERSONA_VERSION,
  PROMPT_VERSION,
  makeJury,
  makePanel,
  makeProducts,
} from './helpers/panel.js';
import {
  installCategory,
  installPanels,
  installProducts,
  migratedDatabase,
  type TestDatabase,
} from './helpers/pg.js';

let database: TestDatabase;
let categoryId: string;

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec('TRUNCATE categories, jobs, products, snapshots, rankings CASCADE;');
  categoryId = await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
  await installPanels(database.pg, categoryId, { jury: makeJury(), personas: makePanel() });
});

function source(): PgCategorySource {
  return new PgCategorySource(database.db);
}

describe('a placement is visible to the next run', () => {
  it('sees a product appended and a category_snapshot_version bumped after the read', async () => {
    // THE test. `FileCategorySource` bound in production passes nothing here:
    // `cjr/runs/<slug>/products.json` is whatever was committed, and it holds no
    // population version at all.
    await installProducts(database.pg, categoryId, makeProducts(8));
    const catalogue = source();

    const before = await catalogue.load(CATEGORY_SLUG);
    expect(before?.products).toHaveLength(8);
    expect(before?.config.categoryVersion).toBe(CATEGORY_VERSION);

    // A placement, as the placement path performs it: one paid row appended, and
    // the population version moved because every z-score in the category just did.
    await database.pg.query(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, submitted_by_email, placed_at)
       VALUES ($1, 8, 'Runlet', 'https://runlet.dev', 'runlet.dev', 'A paid submission.', $2,
               'paid', 'placed', 'payer@example.com', now())`,
      [categoryId, 'b'.repeat(64)],
    );
    await database.pg.query(`UPDATE categories SET category_snapshot_version = 'cat-v2' WHERE id = $1`, [categoryId]);

    const after = await catalogue.load(CATEGORY_SLUG);
    expect(after?.products).toHaveLength(9);
    expect(after?.products.at(-1)?.name).toBe('Runlet');
    // `brief §1.3` keys the preview cache on this. Reading the OLD value here is
    // the same bug wearing a different hat: the run would be stamped with a
    // version whose board no longer exists.
    expect(after?.config.categoryVersion).toBe('cat-v2');
  });

  it('lets the enqueuer name the version explicitly, and prefers what it named', async () => {
    // A recalibration re-runs a category under a version chosen by the operator,
    // not by whatever the row currently says.
    await installProducts(database.pg, categoryId, makeProducts(2));
    const input = await source().load(CATEGORY_SLUG, { categoryVersion: 'cat-v9' });
    expect(input?.config.categoryVersion).toBe('cat-v9');
  });
});

describe('the population it hands the engine', () => {
  it('is in engine_id order, whatever order the rows come back in', async () => {
    // `Product.id` is how every stored score, cluster and vote attaches to a
    // product. Inserted out of order on purpose: a source that trusted the
    // planner's row order would renumber nothing and still hand the jury a
    // scrambled set, and the chunker's `[id N]` markers would be the only place
    // it showed.
    const scrambled: Product[] = [4, 0, 3, 1, 2].map((id) => makeProducts(5)[id] as Product);
    await installProducts(database.pg, categoryId, scrambled);

    const input = await source().load(CATEGORY_SLUG);
    expect(input?.products.map((product) => product.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('carries the stored url and its normalized form, not a re-derived one', async () => {
    // A NAMED row, because that is what this test is about. A seeded row is
    // anonymous (`products_seeded_is_anonymous`) and reaches the engine with its
    // address blanked, which is the next test.
    await installProducts(database.pg, categoryId, makeProducts(1), 'placed', { anonymous: false });
    const product = (await source().load(CATEGORY_SLUG))?.products[0];
    expect(product).toMatchObject({
      id: 0,
      name: 'Product 0',
      url: 'https://example.com/0',
      normalized_url: 'example.com/0',
    });
  });

  it('hands the panel a designation and no address for an anonymous listing', async () => {
    // The FIRST of the two defences behind an anonymous listing, and the one that
    // matters: three prompts render a product's `name` into their data block, and
    // every one of those passes produces free text that is published in full. A
    // juror shown the real name could write it into a deduction reason and the
    // board would print it. So the panel never sees it.
    //
    // This is why the choice has to be made at SUBMISSION: not because a later
    // choice would be untidy, but because a later choice could not be honoured.
    await installProducts(database.pg, categoryId, makeProducts(2));
    const population = (await source().load(CATEGORY_SLUG))?.products ?? [];

    expect(population).toHaveLength(2);
    for (const product of population) {
      expect(product.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
      expect(product.url).toBe('');
      expect(product.normalized_url).toBe('');
    }
    // Two listings, two designations. A board on which two rows answered to the
    // same name is a board a reader cannot tell apart.
    expect(new Set(population.map((product) => product.name)).size).toBe(2);
    // And the description — the thing actually being judged — is untouched.
    expect(population[0]?.description).toBe(makeProducts(2)[0]?.description);
  });

  it('excludes held and rejected rows, and includes pending ones', async () => {
    // A `held` row is `DECISIONS.md` S9's flag-not-drop: awaiting a human, never
    // scored. Including it would have the jury score a product nobody approved
    // AND move every other product's z-score to do it. A `pending` row is what
    // every row looks like mid-run, so excluding those would empty the category
    // between `writeProducts` and delivery.
    await installProducts(database.pg, categoryId, makeProducts(2), 'placed');
    await installProducts(database.pg, categoryId, [{ ...(makeProducts(3)[2] as Product) }], 'pending');
    await installProducts(database.pg, categoryId, [{ ...(makeProducts(4)[3] as Product), id: 3 }], 'held');
    await installProducts(database.pg, categoryId, [{ ...(makeProducts(5)[4] as Product), id: 4 }], 'rejected');

    const input = await source().load(CATEGORY_SLUG);
    expect(input?.products.map((product) => product.id)).toEqual([0, 1, 2]);
  });
});

describe('the two approval gates are gates here too', () => {
  it('returns undefined for a slug nobody installed — a 404, not a failure', async () => {
    expect(await source().load('never-heard-of-it')).toBeUndefined();
  });

  it('refuses to run a category whose jury version has no row', async () => {
    // `categories.prompt_version` is a pointer, and a pointer can dangle: an
    // admin bumps the column and forgets the INSERT. `01 §4` Step 2 is a human
    // gate, so no retry gets past this and it says which gate.
    await database.pg.query(`UPDATE categories SET prompt_version = 'jury-v2' WHERE id = $1`, [categoryId]);
    await expect(source().load(CATEGORY_SLUG)).rejects.toBeInstanceOf(CategoryNotRunnableError);
    await expect(source().load(CATEGORY_SLUG)).rejects.toThrow(/01 §4 Step 2/);
  });

  it('refuses to run a category whose persona panel has no row', async () => {
    await database.pg.query(`UPDATE categories SET persona_version = 'personas-v2' WHERE id = $1`, [categoryId]);
    await expect(source().load(CATEGORY_SLUG)).rejects.toThrow(/01 §4 Step 3/);
  });

  it('re-validates the stored jury, catching what a check constraint cannot see', async () => {
    // `jury_versions_metrics_count` counts metrics and jurors. It cannot see the
    // rule that actually decides a board: every juror's weight vector is keyed by
    // the RUBRIC's metric names. A hand-written admin INSERT that renames a
    // metric satisfies both check constraints and silently reweights every
    // composite in the category.
    const drifted = JURORS.map((juror) => ({ ...juror, weights: { Kraft: 1, Utility: 2, Clarity: 0.5 } }));
    await database.pg.query(`UPDATE jury_versions SET jurors = $2::jsonb WHERE category_id = $1`, [
      categoryId,
      JSON.stringify(drifted),
    ]);

    // The row is legal to Postgres...
    const rows = await database.pg.query<{ n: number }>(
      `SELECT jsonb_array_length(jurors) AS n FROM jury_versions WHERE category_id = $1`,
      [categoryId],
    );
    expect(rows.rows[0]?.n).toBe(6);
    // ...and rejected by the engine's own gate, which is the one that matters.
    expect(validateJury({ type: 'consumer', prompt_version: PROMPT_VERSION, metrics: METRICS, jurors: drifted }).valid).toBe(
      false,
    );

    await expect(source().load(CATEGORY_SLUG)).rejects.toBeInstanceOf(CategoryNotRunnableError);
  });

  it('hands back the panels the engine validated, not the raw rows', async () => {
    await installProducts(database.pg, categoryId, makeProducts(1));
    const input = await source().load(CATEGORY_SLUG);

    expect(input?.jury.prompt_version).toBe(PROMPT_VERSION);
    expect(input?.jury.type).toBe('consumer');
    expect(input?.jury.jurors).toHaveLength(6);
    expect(input?.jury.metrics.map((metric) => metric.name)).toEqual(METRICS.map((metric) => metric.name));
    expect(input?.personas.persona_version).toBe(PERSONA_VERSION);
    expect(input?.personas.personas).toHaveLength(4);
    expect(input?.category).toBe(CATEGORY);
  });
});
