/**
 * A paid placement publishing its board on Postgres — the path that runs in
 * production, and the one nothing exercised.
 *
 * ## What was broken
 *
 * `PgPipelineStore.writeRanking` addresses a board by
 * `(category_id, category_snapshot_version)` and `snapshots_body_immutable_trg`
 * refuses to rewrite one. A placement reads the board, appends the product,
 * re-ranks — `brief §1.2`: appending a product "shifts the population mean and
 * std and therefore moves every existing z-score" — and republished it under the
 * SAME version, because nothing moved `categories.category_snapshot_version`.
 * The trigger refused the write, and `SnapshotVersionConflictError` came out of
 * the `rank` step: after the Dodo webhook had granted attempts, and after the
 * pipeline had spent twelve juror calls, a clustering pass and a persona round.
 * The customer had paid and the board never changed.
 *
 * It was invisible because every placement test binds `MemoryPipelineStore`,
 * which holds one `ranking.json` and overwrites it. There is no version, no
 * unique and no trigger in that store, so a suite of them agrees with itself
 * about a question only Postgres is asked.
 *
 * ## So this file binds the durable store, and the durable everything else
 *
 * `PgCategorySource`, `PgPipelineStore` and a store factory assembled exactly as
 * `service.ts`'s `postgres` branch assembles it — because the factory is under
 * test too: it is what carries `publishAs` and `paid` into the store, and one
 * that dropped the third argument would make every assertion below about a
 * placement that published nowhere.
 *
 * `PgCategorySource` rather than a `MemoryCategorySource` with a pinned version
 * matters more than it looks. It is what reads `categories.category_snapshot_version`
 * back, so a SECOND placement is enqueued under the version the first one moved
 * to — which is the whole mechanism, observed from the other end.
 *
 * PGlite is Postgres in-process, so `snapshots_category_version_uk`,
 * `snapshots_body_immutable_trg` and `products_source_submitter` are all live
 * here. Only the model and the payment transport are fixtures.
 *
 * ## What is asserted, and what would break each assertion
 *
 * - the placement publishes at all, and the version moves with the board
 *   (this fails against the pre-fix code with `SnapshotVersionConflictError`);
 * - the bump and the publish are ONE transaction — a bump that is refused takes
 *   the snapshot down with it;
 * - a second placement publishes again rather than colliding;
 * - the seed board is still readable, byte for byte, under its own version;
 * - a genuine conflict is still `SnapshotVersionConflictError` and is still
 *   classified terminal, so it does not spend `brief §2.3`'s free retries;
 * - an anonymous listing's real name and URL are nowhere on the enqueued event,
 *   and are on the `products` row, which is where the truth belongs.
 */

import { digest, FixtureClient, phaseVersions, type PhaseVersions, type Ranking } from '@the-pit/engine';
import { createPostgresSubmissionStore } from '@the-pit/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isTerminalFailure } from '@/lib/pipeline/errors';
import { enqueuePlacementForPayment, type PlacementQueue } from '@/lib/payments/enqueue';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { executePlacement, executeRun, type PlacementRequestedData } from '@/lib/pipeline/inngest';
import { RecordingStepRunner } from '@/lib/pipeline/local';
import { PgCategorySource } from '@/lib/pipeline/pg-catalog';
import {
  nextCategorySnapshotVersion,
  PgPipelineStore,
  SnapshotVersionConflictError,
} from '@/lib/pipeline/pg-store';
import type { RunnerBindings, RunScope } from '@/lib/pipeline/service';
import { MemorySnapshotSink, type BoardSnapshot } from '@/lib/pipeline/snapshot';
import type { PipelineStore } from '@/lib/pipeline/store';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  PERSONA_VERSION,
  PROMPT_VERSION,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
} from './helpers/panel.js';
import {
  installCategory,
  installPanels,
  installProducts,
  migratedDatabase,
  type TestDatabase,
} from './helpers/pg.js';

/** The seeded population. The first submission lands at engine id 8, the second at 9. */
const SEED_SIZE = 8;
const FIRST_ID = SEED_SIZE;
const SECOND_ID = SEED_SIZE + 1;

/** Where each placement's board lands. `cat-v1` -> `cat-v1+p8` -> `cat-v1+p9`. */
const FIRST_VERSION = `${CATEGORY_VERSION}+p${FIRST_ID}`;
const SECOND_VERSION = `${CATEGORY_VERSION}+p${SECOND_ID}`;

const NOW = new Date('2026-06-01T20:00:00.000Z');
const ACCOUNT = '99999999-8888-4777-8666-555555555555';
const PAYER = 'founder@example.org';

/**
 * The submission. Its name and host are deliberately unlike anything the
 * fixtures produce, so an absence assertion over a serialized event cannot pass
 * by accident — `makeProducts` names its rows "Product 0".
 */
const NAME = 'Ashgrove Ledger';
const URL_TYPED = 'https://ashgrove.dev/ledger';
const NORMALIZED = 'ashgrove.dev/ledger';
const DESCRIPTION =
  'Reconciles a fitness studio’s class bookings against its payouts every night, without a spreadsheet.';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec(
    'TRUNCATE categories, jobs, products, snapshots, rankings, submissions, accounts CASCADE;',
  );
  const categoryId = await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
  await installPanels(database.pg, categoryId, { jury: makeJury(), personas: makePanel() });
  // Named, so the seeded population reads as itself and the paid row's byline is
  // the only one under test here. `installProducts` produces the claim
  // `products_seeded_is_anonymous` requires for that.
  await installProducts(database.pg, categoryId, makeProducts(SEED_SIZE), 'placed', { anonymous: false });
});

// ---------------------------------------------------------------------------
// Wiring: `service.ts`'s postgres branch, with the model and the payer as fixtures
// ---------------------------------------------------------------------------

/**
 * The bindings a Vercel deployment assembles, minus the connection.
 *
 * Written out rather than reached for through `defaultBindings` because that
 * function reads `DATABASE_URL` and a bucket out of the environment, and this
 * suite has neither. The three lines that matter are copied verbatim from it:
 * `placement`, `paid` and `publishAs` all come off `RunScope`, and a factory
 * that dropped the last of those would publish every board under the version it
 * read.
 */
function pgBindings(): { bindings: RunnerBindings; snapshots: MemorySnapshotSink } {
  const snapshots = new MemorySnapshotSink();
  return {
    snapshots,
    bindings: {
      claims: new MemoryPlacementClaims(),
      categories: new PgCategorySource(database.db),
      store: (category: string, versions: PhaseVersions, scope?: RunScope): PipelineStore =>
        new PgPipelineStore(database.db, category, {
          versions,
          ...(scope?.placement === undefined ? {} : { placement: scope.placement }),
          ...(scope?.paid === undefined ? {} : { paid: scope.paid }),
          ...(scope?.publishAs === undefined ? {} : { publishAs: scope.publishAs }),
        }),
      snapshots,
    },
  };
}

/** The four version stamps a run of this category carries. The engine's own. */
function versionsAt(categoryVersion: string): PhaseVersions {
  return phaseVersions({
    jury: makeJury(),
    personas: makePanel(),
    config: { categoryVersion },
  });
}

class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

/** The category's board has to exist before anything can be placed into it. */
async function seed(bindings: RunnerBindings): Promise<void> {
  await executeRun(
    { slug: CATEGORY_SLUG },
    bindings,
    new RecordingStepRunner(),
    undefined,
    new FixtureClient(makeScript()),
  );
}

/** One pending pitch, written to Postgres the way the checkout route writes it. */
function submit(options: { anonymous?: boolean; name?: string; url?: string; normalizedUrl?: string } = {}): Promise<string> {
  return createPostgresSubmissionStore(database.db).create({
    categorySlug: CATEGORY_SLUG,
    name: options.name ?? NAME,
    url: options.url ?? URL_TYPED,
    normalizedUrl: options.normalizedUrl ?? NORMALIZED,
    description: DESCRIPTION,
    descriptionHash: digest(DESCRIPTION),
    pitch: null,
    anonymous: options.anonymous ?? false,
    cycleId: 'cycle-2026-06',
    tier: 'single',
    attemptNumber: 1,
    repitchOf: null,
    now: NOW,
  });
}

/** Settlement is a separate function on a separate event; this only records it. */
type Delivered = { category_version: string; product_count: number };

/**
 * One paid placement, from the pending pitch to the republished board.
 *
 * The real enqueue and the real `executePlacement`, over the real durable store.
 * `guards` is omitted deliberately: `brief §2.4`'s re-check is another file's
 * subject and a cycle lock firing here would refuse the placement before the
 * board was ever written.
 */
async function place(
  bindings: RunnerBindings,
  snapshots: MemorySnapshotSink,
  options: { anonymous?: boolean; name?: string; url?: string; normalizedUrl?: string } = {},
): Promise<{ submissionId: string; event: PlacementRequestedData; snapshot: BoardSnapshot; delivered: Delivered[] }> {
  const submissionId = await submit(options);
  const queue = new RecordingQueue();

  const enqueued = await enqueuePlacementForPayment(
    { accountId: ACCOUNT, email: PAYER, metadata: { submission_id: submissionId } },
    {
      submissions: { find: (id) => createPostgresSubmissionStore(database.db).find(id) },
      categories: bindings.categories,
      queue,
      now: () => NOW,
    },
  );
  if (!enqueued.enqueued) throw new Error(`the placement was refused: ${enqueued.reason}`);

  const event = queue.sent[0];
  if (event === undefined) throw new Error('no placement event was sent');

  const delivered: Delivered[] = [];
  const outcome = await executePlacement(
    event,
    bindings,
    new RecordingStepRunner(),
    (record) => {
      delivered.push({ category_version: record.category_version, product_count: record.product_count });
      return Promise.resolve();
    },
    new FixtureClient(makeScript()),
  );
  if (outcome.status !== 'placed') throw new Error(`expected a placement, got ${outcome.status}`);

  const snapshot = await snapshots.read(CATEGORY_SLUG);
  if (snapshot === undefined) throw new Error('no board was published');
  return { submissionId, event, snapshot, delivered };
}

// ---------------------------------------------------------------------------
// Reading Postgres back
// ---------------------------------------------------------------------------

/** What `categories.category_snapshot_version` says right now. */
async function categoryVersion(): Promise<string> {
  const rows = await database.pg.query<{ v: string }>(
    'select category_snapshot_version as v from categories where slug = $1',
    [CATEGORY_SLUG],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('the category is not installed');
  return row.v;
}

/** Every board stored for this category, by the version it is addressed under. */
async function storedVersions(): Promise<string[]> {
  const rows = await database.pg.query<{ v: string }>(
    `select category_snapshot_version as v from snapshots
       where category_id = (select id from categories where slug = $1)`,
    [CATEGORY_SLUG],
  );
  return rows.rows.map((row) => row.v).sort();
}

/** One stored board, as the document it was written as. */
async function storedBoard(version: string): Promise<Ranking | undefined> {
  const rows = await database.pg.query<{ document: Ranking }>(
    `select document from snapshots
       where category_snapshot_version = $1
         and category_id = (select id from categories where slug = $2)`,
    [version, CATEGORY_SLUG],
  );
  return rows.rows[0]?.document;
}

/** The paid row, as Postgres holds it. */
async function placedRow(engineId: number): Promise<{
  name: string;
  url: string;
  normalized_url: string;
  anonymous: boolean;
  source: string;
  submitted_by_email: string | null;
}> {
  const rows = await database.pg.query<{
    name: string;
    url: string;
    normalized_url: string;
    anonymous: boolean;
    source: string;
    submitted_by_email: string | null;
  }>(
    `select name, url, normalized_url, anonymous, source, submitted_by_email from products
       where engine_id = $1 and category_id = (select id from categories where slug = $2)`,
    [engineId, CATEGORY_SLUG],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`no product was written at engine id ${engineId}`);
  return row;
}

// ---------------------------------------------------------------------------

describe('a paid placement on the durable store', () => {
  it('publishes its board, and the category snapshot version moves with it', async () => {
    // THE test. Against the pre-fix code this throws
    // `SnapshotVersionConflictError` out of the `rank` step — after the customer
    // has been charged and after twelve juror calls have been spent — because the
    // placement rewrote the seed board under the seed board's own version.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);
    expect(await categoryVersion()).toBe(CATEGORY_VERSION);

    const { snapshot, delivered } = await place(bindings, snapshots);

    // The board changed: nine products where there were eight, and the placed
    // one is on it.
    expect(snapshot.product_count).toBe(SEED_SIZE + 1);
    expect(snapshot.ranking.ranking.map((row) => row.id)).toContain(FIRST_ID);

    // And it is a NEW board rather than an edit of the old one — a second
    // snapshot, under a version the category now names.
    expect(await storedVersions()).toEqual([CATEGORY_VERSION, FIRST_VERSION].sort());
    expect(await categoryVersion()).toBe(FIRST_VERSION);

    // The document, its CDN key and the delivery record are all stamped with the
    // version the row was actually written under. Stamped with the version the
    // run READ, all three would name a board that no longer exists — and
    // `brief §1.3` keys the preview cache on exactly this string.
    expect(snapshot.category_version).toBe(FIRST_VERSION);
    expect(snapshots.published.at(-1)?.dated).toContain(`/${FIRST_VERSION}/`);
    expect(delivered.at(-1)?.category_version).toBe(FIRST_VERSION);
  }, 180_000);

  it('leaves the board it was placed into exactly as it was issued', async () => {
    // The other half of the rule, and the reason the version has to move rather
    // than the trigger having to give way: `brief` Part 3 keeps old snapshots
    // permanently addressable so issued verdict cards still resolve.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);
    const seeded = await storedBoard(CATEGORY_VERSION);
    expect(seeded?.ranking).toHaveLength(SEED_SIZE);

    await place(bindings, snapshots);

    expect(await storedBoard(CATEGORY_VERSION)).toEqual(seeded);
    expect((await storedBoard(FIRST_VERSION))?.ranking).toHaveLength(SEED_SIZE + 1);
  }, 180_000);

  it('places a second submission rather than colliding with the first', async () => {
    // The next pitch is enqueued against `categories.category_snapshot_version`
    // as the first one left it, so it reads the board the first one published and
    // writes a third under a version of its own. This is what proves the bump is
    // a mechanism rather than a one-off: nothing here is told which version to
    // use.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);

    await place(bindings, snapshots);
    const second = await place(bindings, snapshots, {
      name: 'Brightwater Rota',
      url: 'https://brightwater.example/rota',
      normalizedUrl: 'brightwater.example/rota',
    });

    expect(second.event.categoryVersion).toBe(FIRST_VERSION);
    expect(second.event.product.id).toBe(SECOND_ID);
    expect(second.snapshot.product_count).toBe(SEED_SIZE + 2);
    expect(await categoryVersion()).toBe(SECOND_VERSION);
    expect(await storedVersions()).toEqual([CATEGORY_VERSION, FIRST_VERSION, SECOND_VERSION].sort());
  }, 240_000);
});

describe('the bump and the publish are one transaction', () => {
  /**
   * Refuse the bump, and only the bump, from inside the database.
   *
   * The board write is what normally fails, so ordering alone would hide a
   * missing transaction. This makes the OTHER half fail: the snapshot inserts
   * cleanly and the `categories` update is rejected. Two statements outside a
   * transaction would leave the board stored under a version the category never
   * moved to — a board `brief §1.3`'s cache key can never invalidate, which is
   * the failure the placement path had in the opposite direction.
   */
  async function refuseBumpTo(version: string): Promise<void> {
    await database.pg.exec(`
      CREATE FUNCTION test_refuse_bump() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.category_snapshot_version = ${JSON.stringify(version).replace(/"/g, "'")} THEN
          RAISE EXCEPTION 'the bump is refused by this test';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_refuse_bump_trg BEFORE UPDATE ON categories
        FOR EACH ROW EXECUTE FUNCTION test_refuse_bump();
    `);
  }

  async function allowBumps(): Promise<void> {
    await database.pg.exec(`
      DROP TRIGGER IF EXISTS test_refuse_bump_trg ON categories;
      DROP FUNCTION IF EXISTS test_refuse_bump();
    `);
  }

  it('stores no board when the version cannot move', async () => {
    const { bindings } = pgBindings();
    await seed(bindings);
    const seededBoard = await storedBoard(CATEGORY_VERSION);
    if (seededBoard === undefined) throw new Error('the seed run published no board');

    await refuseBumpTo(FIRST_VERSION);
    try {
      const store = new PgPipelineStore(database.db, CATEGORY, {
        versions: versionsAt(CATEGORY_VERSION),
        publishAs: FIRST_VERSION,
      });

      await expect(store.writeRanking(seededBoard)).rejects.toBeInstanceOf(SnapshotVersionConflictError);
    } finally {
      await allowBumps();
    }

    // Neither half landed. A snapshot here with the category still at `cat-v1`
    // is the state a two-statement write produces.
    expect(await storedVersions()).toEqual([CATEGORY_VERSION]);
    expect(await categoryVersion()).toBe(CATEGORY_VERSION);
  }, 180_000);

  it('moves neither when the board is refused', async () => {
    // The direction the trigger already guards, asserted from the version's side:
    // a board that `snapshots_body_immutable_trg` will not accept must not leave
    // `categories` pointing at it, or the next reader gets a 404 on a version
    // nothing published.
    const { bindings } = pgBindings();
    await seed(bindings);
    const seededBoard = await storedBoard(CATEGORY_VERSION);
    if (seededBoard === undefined) throw new Error('the seed run published no board');

    const versions = versionsAt(CATEGORY_VERSION);

    // A different board, aimed at a version a board already occupies.
    const store = new PgPipelineStore(database.db, CATEGORY, { versions, publishAs: CATEGORY_VERSION });
    const tampered = { ...seededBoard, category: 'Something Else' } satisfies Ranking;

    await expect(store.writeRanking(tampered)).rejects.toBeInstanceOf(SnapshotVersionConflictError);
    expect((await storedBoard(CATEGORY_VERSION))?.category).toBe(CATEGORY);
    expect(await categoryVersion()).toBe(CATEGORY_VERSION);
  }, 180_000);

  it('still classifies a genuine conflict as terminal, so it spends no free retries', async () => {
    // `brief §2.3` caps free retries at three. A unique-constraint violation is
    // still there on the third one, so `inngest.ts` demotes it on its error CODE
    // — the classification asserted here against the error Postgres actually
    // produced, rather than against a constructed one.
    const { bindings } = pgBindings();
    await seed(bindings);
    const seededBoard = await storedBoard(CATEGORY_VERSION);
    if (seededBoard === undefined) throw new Error('the seed run published no board');

    const store = new PgPipelineStore(database.db, CATEGORY, {
      versions: versionsAt(CATEGORY_VERSION),
      publishAs: CATEGORY_VERSION,
    });

    const thrown = await store
      .writeRanking({ ...seededBoard, category: 'Something Else' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SnapshotVersionConflictError);
    expect(isTerminalFailure(thrown)).toBe(true);
  }, 180_000);

  it('lets a replayed rank step rewrite the identical board and move nothing twice', async () => {
    // The idempotent arm. An Inngest replay re-executes the function body from
    // the top and recomputes the same version, so the second write has to be a
    // no-op rather than an error — `brief §2.3`'s free retry would otherwise fail
    // on its own last step.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);
    await place(bindings, snapshots);

    const board = await storedBoard(FIRST_VERSION);
    if (board === undefined) throw new Error('the placement published no board');

    const store = new PgPipelineStore(database.db, CATEGORY, {
      versions: versionsAt(CATEGORY_VERSION),
      publishAs: FIRST_VERSION,
    });

    await expect(store.writeRanking(board)).resolves.toBeUndefined();
    expect(await categoryVersion()).toBe(FIRST_VERSION);
    expect(await storedVersions()).toEqual([CATEGORY_VERSION, FIRST_VERSION].sort());
  }, 180_000);
});

describe('the version a placement targets', () => {
  it('replaces the previous placement suffix rather than chaining onto it', () => {
    // Bounded, because this string is a CDN key segment, a cache key and a column
    // on every verdict payload — and replay-stable, because a replayed
    // `executePlacement` reads a category whose version this placement has
    // already moved and has to compute the SAME target rather than a third one.
    expect(nextCategorySnapshotVersion('cat-v1', 8)).toBe('cat-v1+p8');
    expect(nextCategorySnapshotVersion('cat-v1+p8', 9)).toBe('cat-v1+p9');
    expect(nextCategorySnapshotVersion('cat-v1+p8', 8)).toBe('cat-v1+p8');
    expect(nextCategorySnapshotVersion('seed-2', 41)).toBe('seed-2+p41');
  });
});

describe('an anonymous listing on the durable path', () => {
  it('puts its real name and URL nowhere on the enqueued event', async () => {
    // Asserted over the SERIALIZED event, because that is the thing an Inngest
    // log, a replay and any observability attached to the queue actually hold. A
    // field assertion would miss a copy that reappeared elsewhere on it.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);

    const { event, submissionId } = await place(bindings, snapshots, { anonymous: true });
    const body = JSON.stringify(event);

    expect(body).not.toContain(NAME);
    expect(body).not.toContain('Ashgrove');
    expect(body).not.toContain('ashgrove.dev');
    expect(body).not.toContain(URL_TYPED);
    expect(body).not.toContain(NORMALIZED);

    // What it carries instead is the id of the row the buyer typed into.
    expect(event.payer?.submissionId).toBe(submissionId);
    expect(event.payer?.anonymous).toBe(true);
  }, 180_000);

  it('still stores the truth on the products row, which is where it belongs', async () => {
    // `products` holds the identity and every read path redacts on the way out
    // (`pg-catalog.ts`). That is the only arrangement in which the one legal
    // transition — `anonymous -> named`, on a listing whose owner has been
    // verified — has anything to reveal, and the only one that keeps
    // `normalized_url` pointing at the address `brief §2.5`'s cap keys on.
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);
    await place(bindings, snapshots, { anonymous: true });

    const row = await placedRow(FIRST_ID);
    expect(row.name).toBe(NAME);
    expect(row.url).toBe(URL_TYPED);
    expect(row.normalized_url).toBe(NORMALIZED);
    expect(row.anonymous).toBe(true);
    expect(row.source).toBe('paid');
    expect(row.submitted_by_email).toBe(PAYER);
  }, 180_000);

  it('publishes a board that names neither', async () => {
    const { bindings, snapshots } = pgBindings();
    await seed(bindings);
    const { snapshot } = await place(bindings, snapshots, { anonymous: true });

    const document = JSON.stringify(snapshot);
    expect(document).not.toContain(NAME);
    expect(document).not.toContain('Ashgrove');
    expect(document).not.toContain(URL_TYPED);
    expect(snapshot.anonymous_ids).toContain(FIRST_ID);
  }, 180_000);
});
