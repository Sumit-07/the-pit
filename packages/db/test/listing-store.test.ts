/**
 * The lookup the submission cap hangs off, run against Postgres.
 *
 * `brief §2.4` caps pitches at one per product per recalibration cycle and
 * `§2.5` keys that on the normalized URL. Everything the cap decides is decided
 * from this one row, so the properties worth executing rather than asserting in
 * prose are the ones that would silently unlock the cap or falsely fire it:
 *
 * - A SEEDED listing reports `lastPitchedAt: null` and `attemptNumber: 0`. Both
 *   the cycle lock and the materially-changed-text rule are rules about
 *   RE-pitching, so a founder claiming their own unclaimed row must be treated as
 *   making a first pitch. If this returned the seed date, an unclaimed product
 *   would be cycle-locked by a board nobody paid for.
 * - A PAID listing with no delivered verdict yet still reports a pitch. It has
 *   been paid for; the verdict has not landed. Reporting `0` here would let the
 *   same product be pitched twice in one cycle for as long as the first run took.
 * - The account id is resolved from the payer's address INSIDE the statement, so
 *   the ownership check has something to compare against.
 * - The description comes back in FULL. `materialChange` compares tokens; a store
 *   that returned only the hash could answer "identical" and never "materially
 *   changed", and a one-word edit would walk through.
 *
 * PGlite is Postgres in-process, so `products_normalized_url_idx` and the
 * `products_source_submitter` check are the ones Neon will enforce.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/client.js';
import type { PostgresListingStore } from '../src/listing-store.js';
import { createPostgresListingStore } from '../src/listing-store.js';
import { readMigrations } from '../src/migrations.js';
import * as schema from '../src/schema/index.js';

let pg: PGlite;
let db: Database;
let store: PostgresListingStore;

const PAYER = 'payer@example.com';
const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
  store = createPostgresListingStore(db);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // TRUNCATE and not DELETE: `verdicts_immutable` refuses a DELETE outright, and
  // that guard is one of the things this schema exists to make. See
  // `payments-store.test.ts`.
  await pg.exec(
    'truncate cluster_members, clusters, verdicts, jobs, products, categories, accounts, submissions restart identity cascade;',
  );
});

async function one<T>(text: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query<T>(text, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no row from ${text.slice(0, 60)}`);
  return row;
}

async function seedAccount(email: string): Promise<string> {
  const row = await one<{ id: string }>('insert into accounts (email) values ($1) returning id', [email]);
  return row.id;
}

async function seedCategory(slug = 'note-apps'): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
     values ($1, $1, 'b2b', 'p1', 'q1', 'c1') returning id`,
    [slug],
  );
  return row.id;
}

interface SeedProduct {
  readonly categoryId: string;
  readonly engineId?: number;
  readonly normalizedUrl?: string;
  readonly description?: string;
  readonly descriptionHash?: string;
  readonly email?: string | null;
  readonly createdAt?: string;
}

async function seedProduct(input: SeedProduct): Promise<string> {
  const email = input.email === undefined ? PAYER : input.email;
  const row = await one<{ id: string }>(
    `insert into products
       (category_id, engine_id, name, url, normalized_url, description, description_hash,
        source, status, anonymous, submitted_by_email, placed_at, created_at)
     values ($1, $2, 'Margin', $3, $4, $5, $6, $7::product_source, 'placed', $7::product_source = 'seeded', $8, now(), $9)
     returning id`,
    [
      input.categoryId,
      input.engineId ?? 0,
      `https://${input.normalizedUrl ?? 'example.com/margin'}`,
      input.normalizedUrl ?? 'example.com/margin',
      input.description ?? 'Turns meeting notes into a shared action list without anyone typing one.',
      input.descriptionHash ?? HASH,
      email === null ? 'seeded' : 'paid',
      email,
      input.createdAt ?? '2026-06-01T12:00:00.000Z',
    ],
  );
  return row.id;
}

async function seedVerdict(input: {
  categoryId: string;
  productId: string;
  accountId: string | null;
  attemptNumber: number | null;
  slug: string;
  deliveredAt: string;
}): Promise<string> {
  // A SEEDED verdict has no job and no account: `brief` Part 7's cold-start
  // boards were produced before any job row existed, and
  // `verdicts_paid_verdict_is_a_pitch` requires a paid one to have both.
  const jobId =
    input.accountId === null
      ? null
      : (
          await one<{ id: string }>(
            `insert into jobs
               (kind, status, category_id, product_id, account_email,
                prompt_version, persona_version, category_snapshot_version, engine_version, delivered_at)
             values ('placement', 'succeeded', $1, $2, $3, 'p1', 'q1', 'c1', 'e1', $4) returning id`,
            [input.categoryId, input.productId, PAYER, input.deliveredAt],
          )
        ).id;

  const row = await one<{ id: string }>(
    `insert into verdicts
       (public_slug, product_id, job_id, account_id, attempt_number, payload, product_count, delivered_at)
     values ($1, $2, $3, $4, $5, '{"kind":"verdict"}'::jsonb, 48, $6) returning id`,
    [input.slug, input.productId, jobId, input.accountId, input.attemptNumber, input.deliveredAt],
  );
  return row.id;
}

// ---------------------------------------------------------------------------

describe('a URL nothing has ever been submitted for', () => {
  it('has no listing, which is what makes a first pitch a first pitch', async () => {
    await seedCategory();
    expect(await store.findByNormalizedUrl('example.com/nothing-here')).toBeNull();
  });

  it('answers null for an empty string without asking the database', async () => {
    // `normalizeUrl` never returns an empty string, so this can only arrive from
    // a caller that skipped it. Answering `null` beats scanning the index for a
    // value no row can hold.
    expect(await store.findByNormalizedUrl('')).toBeNull();
  });
});

describe('a seeded listing — unclaimed, never pitched by anybody', () => {
  it('reports no last pitch and a zero attempt count', async () => {
    const categoryId = await seedCategory();
    const productId = await seedProduct({ categoryId, email: null });

    const listing = await store.findByNormalizedUrl('example.com/margin');

    // Both nulls are the point. `checkSubmissionLocal` skips the cycle lock AND
    // the material-change rule when `lastPitchedAt` is null, so a founder
    // claiming their own unclaimed row makes a first pitch — rather than being
    // cycle-locked by a board they never paid for, or rejected for writing
    // something too close to the description outbid wrote about them.
    expect(listing).toMatchObject({
      listingId: productId,
      accountId: null,
      attemptNumber: 0,
      lastPitchedAt: null,
    });
  });

  it('still reports zero pitches when a cold-start verdict exists for it', async () => {
    // `brief` Part 7's seeded boards have public verdict pages. Those verdicts
    // carry a NULL ordinal precisely so they do not occupy the ordinal a
    // founder's real first pitch is entitled to (`schema/verdicts.ts`).
    const categoryId = await seedCategory();
    const productId = await seedProduct({ categoryId, email: null });
    const verdictId = await seedVerdict({
      categoryId,
      productId,
      accountId: null,
      attemptNumber: null,
      slug: 'seeded-margin-verdict',
      deliveredAt: '2026-06-02T12:00:00.000Z',
    });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.attemptNumber).toBe(0);
    expect(listing?.lastPitchedAt).toBeNull();
    // The verdict is still reachable — a re-pitch has to know what it supersedes.
    expect(listing?.currentVerdictId).toBe(verdictId);
  });
});

describe('a paid listing', () => {
  it('reports one pitch before any verdict has been delivered', async () => {
    // The window between settlement and delivery. Reporting 0 here would let the
    // same product be pitched a second time in the same cycle for as long as the
    // first run takes to finish.
    const categoryId = await seedCategory();
    await seedAccount(PAYER);
    await seedProduct({ categoryId, createdAt: '2026-06-01T12:00:00.000Z' });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.attemptNumber).toBe(1);
    expect(listing?.lastPitchedAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(listing?.currentVerdictId).toBeNull();
  });

  it('takes the attempt count from the latest delivered verdict', async () => {
    const categoryId = await seedCategory();
    const accountId = await seedAccount(PAYER);
    const productId = await seedProduct({ categoryId, createdAt: '2026-06-01T12:00:00.000Z' });
    await seedVerdict({
      categoryId,
      productId,
      accountId,
      attemptNumber: 1,
      slug: 'margin-pitch-one',
      deliveredAt: '2026-06-01T13:00:00.000Z',
    });
    const second = await seedVerdict({
      categoryId,
      productId,
      accountId,
      attemptNumber: 2,
      slug: 'margin-pitch-two',
      deliveredAt: '2026-06-05T13:00:00.000Z',
    });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    // Two pitches so far, so the next one is the 3rd — `brief §2.4`'s public label.
    expect(listing?.attemptNumber).toBe(2);
    expect(listing?.currentVerdictId).toBe(second);
    // And the clock the cycle lock reads moved with the re-pitch, not with the
    // product row's creation date.
    expect(listing?.lastPitchedAt?.toISOString()).toBe('2026-06-05T13:00:00.000Z');
  });

  it('resolves the payer address to an account id, which is what ownership compares', async () => {
    const categoryId = await seedCategory();
    const accountId = await seedAccount(PAYER);
    await seedProduct({ categoryId });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.accountId).toBe(accountId);
  });

  it('reports a null account for a payer who has no accounts row yet', async () => {
    // Possible in support scenarios and after a manual import. Null means "we
    // cannot say who owns this", and `checkSubmissionLocal` does not raise an
    // ownership conflict against an unknown owner.
    const categoryId = await seedCategory();
    await seedProduct({ categoryId });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.accountId).toBeNull();
  });

  it('returns the description in full, not only its hash', async () => {
    // `materialChange` compares TOKENS. A store that returned only the hash could
    // answer "identical" and never "materially changed", and a one-word edit
    // would walk straight through `brief §2.4`.
    const categoryId = await seedCategory();
    const description = 'Turns meeting notes into a shared action list without anyone typing one.';
    await seedProduct({ categoryId, description, descriptionHash: OTHER_HASH });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.description).toBe(description);
    expect(listing?.descriptionHash).toBe(OTHER_HASH);
  });

  it('reports the cluster the listing joined', async () => {
    const categoryId = await seedCategory();
    const productId = await seedProduct({ categoryId });
    const cluster = await one<{ id: string }>(
      `insert into clusters (category_id, cluster_key, label, uniqueness_version)
       values ($1, 'c1-notes', 'notes', 'u1') returning id`,
      [categoryId],
    );
    await pg.query(
      `insert into cluster_members (cluster_id, product_id, category_id, uniqueness_score, reason, uniqueness_version)
       values ($1, $2, $3, 40, 'crowded', 'u1')`,
      [cluster.id, productId, categoryId],
    );

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.clusterId).toBe(cluster.id);
  });
});

describe('which row wins when a URL has more than one', () => {
  it('takes the most recently created listing', async () => {
    // `products_normalized_url_idx` is deliberately not unique: a re-pitch can
    // leave two rows sharing a URL while one is superseded (`schema/products.ts`).
    // The live listing is the newest, under every reading of `DECISIONS.md` S8.
    const categoryId = await seedCategory();
    await seedProduct({ categoryId, engineId: 0, createdAt: '2026-05-01T12:00:00.000Z' });
    const newer = await seedProduct({ categoryId, engineId: 1, createdAt: '2026-06-01T12:00:00.000Z' });

    const listing = await store.findByNormalizedUrl('example.com/margin');
    expect(listing?.listingId).toBe(newer);
  });

  it('does not confuse two different products under one category', async () => {
    const categoryId = await seedCategory();
    await seedProduct({ categoryId, engineId: 0, normalizedUrl: 'example.com/margin' });
    const other = await seedProduct({ categoryId, engineId: 1, normalizedUrl: 'example.com/ledger' });

    expect((await store.findByNormalizedUrl('example.com/ledger'))?.listingId).toBe(other);
  });

  it('carries the category slug the listing is ranked inside', async () => {
    // The category is what `DECISIONS.md` S12 polices, and rank is computed
    // inside it — so a re-pitch has to be able to see where the product already
    // sits.
    const categoryId = await seedCategory('note-apps');
    await seedProduct({ categoryId });

    expect((await store.findByNormalizedUrl('example.com/margin'))?.categorySlug).toBe('note-apps');
  });
});
