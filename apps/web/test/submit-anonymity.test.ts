/**
 * The anonymity choice, from the radio button to `products.anonymous`.
 *
 * ## What was broken
 *
 * `packages/anon` generated the robots, `0009_anonymous_listings.sql` made
 * `products.anonymous` the source of truth and froze it, the boards redacted
 * correctly, and 92 seeded listings rendered as robots. Nothing offered the choice
 * to a customer. `/submit` had no control, `POST /api/checkout` never mentioned
 * the word, and every paying customer was published named — so
 * `products_anonymity_immutable` was guarding a decision nobody had ever been
 * allowed to make.
 *
 * ## Why the test is one long path rather than four short ones
 *
 * The flag crosses five components, and four of the five would keep passing their
 * own unit tests if the fifth dropped it:
 *
 * ```
 * the form  ->  POST /api/checkout  ->  submissions  ->  the webhook's enqueue
 *                                                             |
 *                                            pit/placement.requested
 *                                                             |
 *                                       executePlacement  ->  products.anonymous
 * ```
 *
 * A dropped field anywhere on that line publishes a paying customer's name after
 * they asked us to withhold it, and there is no code path that can take it back:
 * the trigger refuses `named -> anonymous`, which is the correct rule and is also
 * why the mistake is permanent. So the assertions below run the WHOLE line with
 * real components — the real handler, a real Postgres `submissions` store, the
 * real enqueue, the real `executePlacement`, and a real `PgPipelineStore` — with
 * only the model and the payment transport swapped for fixtures.
 *
 * PGlite is Postgres in-process, so `products_seeded_is_anonymous`,
 * `products_source_submitter` and `products_anonymity_immutable` are all live
 * during this run. Nothing here would pass against a mock that agreed with it.
 *
 * ## And the leak that is not a dropped field
 *
 * A listing can carry `anonymous = true` and still publish its own name, because
 * the name reaches three juror prompts and every one of those produces free text
 * that is published verbatim. `lib/pipeline/pg-catalog.ts` stops that for the rows
 * already on the board; the row being PLACED is not on the board yet, so
 * `lib/payments/enqueue.ts` does the same thing for it — the event carries the
 * designation and a blank address, and the panel never sees anything else. The
 * render assertions below are therefore ABSENCE assertions over the whole served
 * document, not a check that a robot appeared: `toContain(robot)` passes on a page
 * that also prints the name four paragraphs down.
 *
 * The remaining half of the rule — that nothing can flip the flag after delivery —
 * is asserted where it is actually enforced, against the database with no
 * application code in between, in `packages/db/test/schema/anonymity.test.ts`.
 */

import { categorySlug, FixtureClient, phaseVersions, type PhaseVersions } from '@the-pit/engine';
import {
  acceptAllClassifier,
  FixtureDodoTransport,
  type DodoConfig,
  type ListingSnapshot,
} from '@the-pit/payments';
import { createPostgresSubmissionStore } from '@the-pit/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CategoryBoard } from '@/components/category-board';
import { anonSeed, pseudonymFor } from '@/lib/anon';
import type { BoardDocument } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';
import { BYLINE_ANONYMOUS, BYLINE_NAMED, readByline } from '@/lib/checkout/byline';
import type { ListingLookup } from '@/lib/checkout/guards';
import { handleCheckoutCreate, type CheckoutHandlerDeps } from '@/lib/checkout/handlers';
import { enqueuePlacementForPayment, type PlacementQueue } from '@/lib/payments/enqueue';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { executePlacement, executeRun, type PlacementRequestedData } from '@/lib/pipeline/inngest';
import { RecordingStepRunner } from '@/lib/pipeline/local';
import { PgPipelineStore } from '@/lib/pipeline/pg-store';
import type { RunnerBindings, RunScope } from '@/lib/pipeline/service';
import { MemorySnapshotSink, type BoardSnapshot } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore, placementScope, type PipelineStore } from '@/lib/pipeline/store';

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
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';
import { passthroughUrlResolver } from './helpers/url-resolver.js';

/** The seeded category's size. The submission lands at engine id 8. */
const SEED_SIZE = 8;
const PLACED_ID = SEED_SIZE;

const ORIGIN = 'https://thepit.show';
const NOW = new Date('2026-06-01T20:00:00.000Z');
const ACCOUNT = '99999999-8888-4777-8666-555555555555';
const PAYER = 'founder@ashgrove.dev';

/**
 * The submission. Its name and host are deliberately unlike anything the fixtures
 * produce, so an absence assertion over the whole document cannot pass by
 * accident — `makeProducts` names its rows "Product 0" and every fixture juror
 * reason is "thin evidence for <metric>".
 */
const NAME = 'Ashgrove Ledger';
const URL_TYPED = 'https://ashgrove.dev/ledger';
const NORMALIZED = 'ashgrove.dev/ledger';
const DESCRIPTION =
  'Reconciles a fitness studio’s class bookings against its payouts every night, without a spreadsheet.';

/** The designation this listing gets: engine id 8, alone in the anonymous population. */
const DESIGNATION = pseudonymFor(anonSeed(CATEGORY_SLUG, PLACED_ID));

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec('TRUNCATE categories, jobs, products, snapshots, rankings, submissions CASCADE;');
  await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
});

// ---------------------------------------------------------------------------
// Wiring: the real components, with fixtures where money or a model would be
// ---------------------------------------------------------------------------

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: 'whsec_' + 'a'.repeat(40),
  productIds: { prod_single: 'single' },
  returnUrl: `${ORIGIN}/checkout/success`,
};

/** No listing is on the board at this URL. The guards pass; the cap has nothing to bite. */
const NO_LISTINGS: ListingLookup = {
  findByNormalizedUrl: (): Promise<ListingSnapshot | null> => Promise.resolve(null),
};

function checkoutDeps(): { deps: CheckoutHandlerDeps; transport: FixtureDodoTransport } {
  const transport = new FixtureDodoTransport();
  return {
    transport,
    deps: {
      config: CONFIG,
      transport,
      // The REAL Postgres writer. A memory `Map` here would let a store that
      // silently drops the column pass the whole file.
      submissions: { create: (draft) => createPostgresSubmissionStore(database.db).create(draft) },
      guards: {
        listings: NO_LISTINGS,
        resolveUrl: passthroughUrlResolver(),
        // Said out loud, per `SubmissionGuardDeps.classifier`: the category rule is
        // not what this file is about, and a mismatch would refuse before the
        // byline was ever written.
        classifier: acceptAllClassifier,
        candidateCategories: () => Promise.resolve([CATEGORY_SLUG]),
      },
      now: () => NOW,
    },
  };
}

/** A plain `<form method="post">`, which is the only way most buyers will send this. */
function post(byline: string | undefined): Request {
  const body = new URLSearchParams({
    url: URL_TYPED,
    name: NAME,
    description: DESCRIPTION,
    category: CATEGORY_SLUG,
    tier: 'single',
    ...(byline === undefined ? {} : { anonymous: byline }),
  });
  return new Request(`${ORIGIN}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: body.toString(),
  });
}

class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

/**
 * The artifacts in memory, the CATALOGUE in Postgres.
 *
 * `writeProducts` is the write this file is about — it is where `scope.paid`
 * becomes a `products` row, and where `products_source_submitter`,
 * `products_seeded_is_anonymous` and the anonymity trigger all apply — so it runs
 * against a real Postgres through the real `PgPipelineStore`. Everything else
 * (phases, `results.json`, `ranking.json`) stays in memory.
 *
 * That split is not a convenience. `PgPipelineStore.writeRanking` addresses a
 * board by `(category_id, category_snapshot_version)` and
 * `snapshots_body_immutable_trg` refuses to rewrite one, while a placement reads
 * and re-publishes its category under the SAME version it read
 * (`enqueuePlacementForPayment` sends `category.config.categoryVersion`, and
 * `executePlacement` uses it for both the read and the write). Nothing in the
 * placement path bumps `categories.category_snapshot_version`, which
 * `pg-catalog.ts`'s header says the placement path is supposed to do. So a
 * durably-stored seed run followed by a durably-stored placement raises
 * `SnapshotVersionConflictError` inside the `rank` step — a real, separate,
 * pre-existing defect on the money path, reported with this work and deliberately
 * NOT worked around here in a way that would hide it.
 */
class CatalogueOnPostgres implements PipelineStore {
  constructor(
    private readonly artifacts: PipelineStore,
    private readonly catalogue: PgPipelineStore,
  ) {}

  get slug(): string {
    return this.artifacts.slug;
  }

  get runId(): string | undefined {
    return this.artifacts.runId;
  }

  writePhase(phase: Parameters<PipelineStore['writePhase']>[0], envelope: unknown): Promise<void> {
    return this.artifacts.writePhase(phase, envelope);
  }

  readPhase(phase: Parameters<PipelineStore['readPhase']>[0]): Promise<unknown> {
    return this.artifacts.readPhase(phase);
  }

  async writeProducts(set: Parameters<PipelineStore['writeProducts']>[0]): Promise<void> {
    await this.artifacts.writeProducts(set);
    await this.catalogue.writeProducts(set);
  }

  writeResults(results: Parameters<PipelineStore['writeResults']>[0]): Promise<void> {
    return this.artifacts.writeResults(results);
  }

  writeRanking(ranking: Parameters<PipelineStore['writeRanking']>[0]): Promise<void> {
    return this.artifacts.writeRanking(ranking);
  }

  readResults(): ReturnType<PipelineStore['readResults']> {
    return this.artifacts.readResults();
  }

  readRanking(): ReturnType<PipelineStore['readRanking']> {
    return this.artifacts.readRanking();
  }
}

/**
 * Bindings assembled the way `service.ts`'s `postgres` branch assembles them,
 * except for the artifact split above.
 *
 * The store factory is under test as much as anything else: it is what carries
 * `scope.paid` — the payer, the choice, and the identity the run was never shown —
 * into `writeProducts`. A factory that dropped the third argument would make every
 * assertion in this file about a listing nobody paid for.
 */
function pgBindings(): { bindings: RunnerBindings; snapshots: MemorySnapshotSink } {
  const snapshots = new MemorySnapshotSink();
  const artifacts = new Map<string, MemoryPipelineStore>();
  const memory = (key: string): MemoryPipelineStore => {
    const existing = artifacts.get(key);
    if (existing !== undefined) return existing;
    const created = new MemoryPipelineStore(key);
    artifacts.set(key, created);
    return created;
  };

  return {
    snapshots,
    bindings: {
      claims: new MemoryPlacementClaims(),
      categories: new MemoryCategorySource([
        {
          category: CATEGORY,
          products: makeProducts(SEED_SIZE),
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion: CATEGORY_VERSION },
        },
      ]),
      store: (category: string, versions: PhaseVersions, scope?: RunScope): PipelineStore => {
        // A placement's phases live in their own scope — see `placementScope`.
        // They are not a catalogue and never reach `products`.
        if (scope?.placement !== undefined) return memory(placementScope(category, scope.placement));
        return new CatalogueOnPostgres(
          memory(category),
          new PgPipelineStore(database.db, category, {
            versions,
            ...(scope?.paid === undefined ? {} : { paid: scope.paid }),
          }),
        );
      },
      snapshots,
    },
  };
}

/** The whole line, from the form post to the placed row. */
async function buy(byline: string | undefined): Promise<{
  submissionId: string;
  event: PlacementRequestedData;
  snapshot: BoardSnapshot;
}> {
  const { deps, transport } = checkoutDeps();

  const response = await handleCheckoutCreate(post(byline), deps);
  if (response.status !== 303) throw new Error(`the checkout refused: ${response.status}`);

  const opened = transport.calls[0];
  const submissionId = opened?.metadata?.['submission_id'];
  if (submissionId === undefined) throw new Error('the Dodo session carried no submission id');

  const { bindings, snapshots } = pgBindings();

  // The category has to have a delivered run before anything can be placed into
  // it, exactly as production does: seed first, place second.
  await executeRun({ slug: CATEGORY_SLUG }, bindings, new RecordingStepRunner(), undefined, new FixtureClient(makeScript()));

  const queue = new RecordingQueue();
  const enqueued = await enqueuePlacementForPayment(
    { accountId: ACCOUNT, email: PAYER, metadata: { submission_id: submissionId } },
    {
      // The REAL lookup, over the row the checkout just wrote.
      submissions: { find: (id) => createPostgresSubmissionStore(database.db).find(id) },
      categories: bindings.categories,
      queue,
      now: () => NOW,
    },
  );
  if (!enqueued.enqueued) throw new Error(`the placement was refused: ${enqueued.reason}`);

  const event = queue.sent[0];
  if (event === undefined) throw new Error('no placement event was sent');

  await executePlacement(event, bindings, new RecordingStepRunner(), undefined, new FixtureClient(makeScript()));

  const snapshot = await snapshots.read(CATEGORY_SLUG);
  if (snapshot === undefined) throw new Error('no board was published');

  return { submissionId, event, snapshot };
}

/** The placed row, as Postgres holds it. */
async function placedRow(): Promise<{
  anonymous: boolean;
  name: string;
  url: string;
  normalized_url: string;
  source: string;
  submitted_by_email: string | null;
}> {
  const rows = await database.pg.query<{
    anonymous: boolean;
    name: string;
    url: string;
    normalized_url: string;
    source: string;
    submitted_by_email: string | null;
  }>(
    `select anonymous, name, url, normalized_url, source, submitted_by_email
       from products
      where engine_id = $1
        and category_id = (select id from categories where slug = $2)`,
    [PLACED_ID, CATEGORY_SLUG],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`no product was written at engine id ${PLACED_ID}`);
  return row;
}

/** The published board, rendered the way a reader receives it. */
function renderBoard(snapshot: BoardSnapshot): string {
  const document_: BoardDocument = {
    slug: snapshot.slug,
    category: snapshot.category,
    generatedAt: snapshot.generated_at,
    productCount: snapshot.product_count,
    categoryVersion: snapshot.category_version,
    origin: 'snapshot',
    anonymousIds: snapshot.anonymous_ids ?? [],
    ranking: snapshot.ranking,
  };
  return renderToStaticMarkup(createElement(CategoryBoard, { board: toBoardView(document_) }));
}

/**
 * The served markup with its entities decoded — for PRESENCE assertions only.
 *
 * Absence is always asserted against the raw bytes: a name that survives as
 * `&#x27;` or inside an attribute is still on the page, and decoding first would
 * be a way to miss it.
 */
const decoded = (html: string): string =>
  html
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

// ---------------------------------------------------------------------------

describe('the choice reaches products.anonymous', () => {
  it('carries “as a robot” from the form all the way to the column', async () => {
    // The assertion the whole file exists for. If ANY of the five hops drops the
    // field — the parser, the draft, the `submissions` row, the placement event,
    // the catalogue write — this is `false` and the customer has been published
    // under a name they asked us to withhold.
    await buy(BYLINE_ANONYMOUS);

    expect((await placedRow()).anonymous).toBe(true);
  }, 120_000);

  it('carries “under your name” to the column as false', async () => {
    // The default is not "whatever happens when nothing is set". It is a value
    // this path writes, and it is asserted as one.
    await buy(BYLINE_NAMED);

    expect((await placedRow()).anonymous).toBe(false);
  }, 120_000);

  it('publishes a caller that says nothing as NAMED', async () => {
    // The documented default, for an API caller and for a form rendered by
    // something older than the control. Named is the ordinary case, it is what
    // `products.anonymous` defaults to, and it is the one direction a verified
    // owner can still change later.
    await buy(undefined);

    expect((await placedRow()).anonymous).toBe(false);
  }, 120_000);

  it('writes the choice onto the submissions row before any money moves', async () => {
    // The hop the webhook depends on, asserted on its own so a failure upstream is
    // distinguishable from a failure downstream.
    const { deps } = checkoutDeps();
    await handleCheckoutCreate(post(BYLINE_ANONYMOUS), deps);

    const rows = await database.pg.query<{ anonymous: boolean }>('select anonymous from submissions');
    expect(rows.rows).toEqual([{ anonymous: true }]);
  });

  it('carries it onto the placement event, where the run can act on it', async () => {
    const { event } = await buy(BYLINE_ANONYMOUS);

    expect(event.payer?.anonymous).toBe(true);
  }, 120_000);
});

describe('the row keeps its real identity, because a claim has to have something to reveal', () => {
  it('stores the name and the URL the buyer typed, not the designation', async () => {
    // `products` holds the truth and every read path redacts on the way out. A row
    // that had stored its own pseudonym would have forgotten who it was, and
    // `products_anonymity_immutable`'s one legal transition — anonymous -> named on
    // a verified claim — would reveal a robot. It would also lose `normalized_url`,
    // which `brief §2.5`'s per-product cap keys on.
    await buy(BYLINE_ANONYMOUS);
    const row = await placedRow();

    expect(row.name).toBe(NAME);
    expect(row.url).toBe(URL_TYPED);
    expect(row.normalized_url).toBe(NORMALIZED);
  }, 120_000);

  it('is still a PAID row with its payer on it', async () => {
    // Anonymity withholds the name from READERS. It does not make a paying
    // customer's listing look like a seeded one — `products_source_submitter`
    // requires the payer, and four of `brief §2.4`'s rules read it.
    await buy(BYLINE_ANONYMOUS);
    const row = await placedRow();

    expect(row.source).toBe('paid');
    expect(row.submitted_by_email).toBe(PAYER);
  }, 120_000);
});

describe('the panel is never shown the name it could write into a reason', () => {
  it('sends the designation and a blank address on the placement event', async () => {
    // The defence that has to happen BEFORE the run, not after it. Three prompts
    // render a product's name and every one of those passes produces free text
    // that is published in full; there is no filter that takes a name back out of
    // prose about the thing it names. `pg-catalog.ts` does this for the rows
    // already on the board, and the row being placed is not on the board yet.
    const { event } = await buy(BYLINE_ANONYMOUS);

    expect(event.product.name).toBe(DESIGNATION);
    expect(event.product.url).toBe('');
    expect(event.product.normalized_url).toBe('');
  }, 120_000);

  it('sends the id of the submission and not the identity on it', async () => {
    // The event used to carry the real name and URL on `payer.listing`, which
    // put the identity of a listing the customer had asked us to withhold into
    // an Inngest event body — a log, its replays, and whatever observability is
    // attached to the queue. Asserted over the SERIALIZED event, because that is
    // the thing that is actually written down, and a field assertion would miss
    // a copy that reappeared somewhere else on it.
    const { event, submissionId } = await buy(BYLINE_ANONYMOUS);
    const body = JSON.stringify(event);

    expect(body).not.toContain(NAME);
    expect(body).not.toContain('Ashgrove');
    expect(body).not.toContain(URL_TYPED);
    expect(body).not.toContain(NORMALIZED);
    // The bare host is deliberately NOT asserted: `payer.email` is
    // `founder@ashgrove.dev`, and the address Dodo verified is a fact about the
    // customer rather than about the listing's byline. It is what
    // `products_source_submitter` requires on a paid row and what the ownership
    // rule joins on, it is carried knowingly, and anonymity was never a promise
    // about the buyer's email.

    // What it carries instead: the id of the row the buyer typed into, which the
    // catalogue write resolves inside the deployment that owns the table.
    expect(event.payer?.submissionId).toBe(submissionId);
  }, 120_000);

  it('leaves a NAMED submission identity exactly as it was typed', async () => {
    const { event, submissionId } = await buy(BYLINE_NAMED);

    expect(event.product.name).toBe(NAME);
    expect(event.product.url).toBe(URL_TYPED);
    // The id rides on every paid placement, named or not. A field that appeared
    // only for anonymous listings would make the event body itself say which is
    // which.
    expect(event.payer?.submissionId).toBe(submissionId);
  }, 120_000);
});

describe('the published board withholds the name and the URL, and nothing else', () => {
  it('does not contain the product name, its host, or its address', async () => {
    // Searched over the WHOLE served document rather than the element that was
    // supposed to hold the name. A name in a title attribute, in a juror's reason
    // or in the ledger renders correctly, passes a visual check, and is the leak.
    const { snapshot } = await buy(BYLINE_ANONYMOUS);
    const html = renderBoard(snapshot);

    expect(html).not.toContain(NAME);
    expect(html).not.toContain('Ashgrove');
    expect(html).not.toContain('ashgrove.dev');
    expect(html).not.toContain(URL_TYPED);
    expect(html).not.toContain(NORMALIZED);
  }, 120_000);

  it('does not put the name in the published JSON either', async () => {
    // The snapshot is served verbatim by `/api/boards/<slug>` and sits in a bucket.
    // Redacting on the way out to HTML would leave the name in the document a
    // reader can fetch directly.
    const { snapshot } = await buy(BYLINE_ANONYMOUS);

    expect(JSON.stringify(snapshot)).not.toContain('Ashgrove');
    expect(JSON.stringify(snapshot)).not.toContain('ashgrove.dev');
  }, 120_000);

  it('names the row as anonymous in the document, so the renderer draws a robot', async () => {
    const { snapshot } = await buy(BYLINE_ANONYMOUS);

    expect(snapshot.anonymous_ids).toContain(PLACED_ID);
    expect(renderBoard(snapshot)).toContain(DESIGNATION);
  }, 120_000);

  it('still publishes the score, the cuts, the reasons, the jurors and the cluster', async () => {
    // The other half of the promise, and the half that makes the first half
    // acceptable. A verdict nobody can check is the opaque leaderboard this place
    // exists to replace, so anonymity withholds two fields and nothing else.
    const { snapshot } = await buy(BYLINE_ANONYMOUS);
    const html = decoded(renderBoard(snapshot));

    const row = snapshot.ranking.ranking.find((entry) => entry.id === PLACED_ID);
    if (row === undefined) throw new Error('the placed row is not on the published board');

    // The score, on the page as a number.
    expect(html).toContain(String(Math.round(row.composite)));

    // Every cut the panel took, its reason and the juror who took it — served on
    // the anonymous row as fully as on any other.
    const cuts = row.scorecard.flatMap((card) => card.deductions);
    expect(cuts.length).toBeGreaterThan(0);
    for (const cut of cuts) {
      expect(html).toContain(cut.reason);
      expect(html).toContain(cut.role);
    }

    // And the cluster it was judged inside, which still joins the roster.
    expect(row.cluster.label.length).toBeGreaterThan(0);
    expect(snapshot.ranking.clusters.some((cluster) => cluster.cluster_id === row.cluster.id)).toBe(true);
    expect(decoded(renderBoard(snapshot))).toContain(row.cluster.label);
  }, 120_000);

  it('leaves a NAMED submission on the board under its own name', async () => {
    // The control. Without it every assertion above would also pass on a board
    // that had lost the name for everybody.
    const { snapshot } = await buy(BYLINE_NAMED);
    const html = renderBoard(snapshot);

    expect(snapshot.anonymous_ids ?? []).not.toContain(PLACED_ID);
    expect(decoded(html)).toContain(NAME);
  }, 120_000);
});

describe('the wire format, on its own', () => {
  it('defaults an absent value to named', () => {
    expect(readByline(undefined)).toEqual({ ok: true, anonymous: false });
    expect(readByline('')).toEqual({ ok: true, anonymous: false });
  });

  it('reads both form values and both JSON booleans', () => {
    expect(readByline(BYLINE_NAMED)).toEqual({ ok: true, anonymous: false });
    expect(readByline(BYLINE_ANONYMOUS)).toEqual({ ok: true, anonymous: true });
    expect(readByline(false)).toEqual({ ok: true, anonymous: false });
    expect(readByline(true)).toEqual({ ok: true, anonymous: true });
    expect(readByline('true')).toEqual({ ok: true, anonymous: true });
  });

  it('refuses a value it does not recognise rather than guessing', () => {
    // The asymmetry, as a test. Defaulting an unreadable value to "named" would
    // publish an identity that cannot be withdrawn; refusing costs one edit and no
    // money. `unknown_tier` is refused for the same shape of reason.
    expect(readByline('ture').ok).toBe(false);
    expect(readByline('yes please').ok).toBe(false);
    expect(readByline(42).ok).toBe(false);
  });

  it('refuses the checkout on an unreadable byline, before anything is written', async () => {
    const { deps, transport } = checkoutDeps();
    const response = await handleCheckoutCreate(post('ture'), deps);

    expect(response.status).toBe(422);
    expect(transport.sessionCount).toBe(0);
    const rows = await database.pg.query('select id from submissions');
    expect(rows.rows).toEqual([]);
  });
});

describe('a refusal does not quietly re-decide the byline', () => {
  it('re-renders the form with the robot still selected', async () => {
    // The refusal page is reached by being told nothing was charged, and it holds
    // every field the visitor typed so a rejection is an edit rather than a
    // retype. The byline is the one field where losing that would flip a decision
    // rather than cost a retype — and it would do it silently, on the page whose
    // whole message is "nothing happened".
    const { deps } = checkoutDeps();
    const body = new URLSearchParams({
      url: URL_TYPED,
      name: NAME,
      description: DESCRIPTION,
      category: CATEGORY_SLUG,
      tier: 'single',
      anonymous: BYLINE_ANONYMOUS,
      // Over `PITCH_LIMIT`, so the handler refuses before it reaches the guards.
      pitch: 'x'.repeat(900),
    });
    const response = await handleCheckoutCreate(
      new Request(`${ORIGIN}/api/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: body.toString(),
      }),
      deps,
    );

    expect(response.status).toBe(422);
    const html = await response.text();
    const radios = [...html.matchAll(/<input type="radio" name="anonymous" value="([a-z]+)"( checked)?>/g)];
    expect(radios[0]?.[2]).toBeUndefined();
    expect(radios[1]?.[2]).toBe(' checked');
  });
});

describe('the slug the designation is minted under', () => {
  it('is the category slug, so a listing keeps one designation across every board', () => {
    // Guards the seed: `anonSeed(slug, engineId)`. A designation minted from the
    // category NAME would give the same listing a different robot on the board
    // than on its verdict page.
    expect(categorySlug(CATEGORY)).toBe(CATEGORY_SLUG);
    expect(DESIGNATION).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
  });
});
