/**
 * The money path, end to end, as one sequence of wiring assertions.
 *
 * The failure this file exists to catch is not a wrong value — it is a step that
 * is never taken. `deliverStep` fired `onDelivered`, the function turned it into
 * a `pit/run.delivered` event, and NOTHING WAS REGISTERED FOR THAT EVENT. Every
 * assertion upstream of the gap kept passing: the board republished, the snapshot
 * was correct, the pipeline reported five steps. What was missing had no
 * observable failure at all, because an Inngest event with no consumer is not an
 * error.
 *
 * So the assertions here are about the JOINS:
 *
 * 1. a function is registered for `pit/run.delivered`;
 * 2. the settled payment carries the payer as far as the placement event;
 * 3. the placement writes the payer onto the catalogue and onto the record;
 * 4. the record carries everything a settle needs and nothing it should not;
 * 5. the rendered board pages are invalidated when a board republishes.
 *
 * Hand-derived: the seed run is 8 products (6 scoring + 1 clustering + 4 persona
 * = 11 calls) and the placement is 11 more, five steps each.
 */

import { FixtureClient, JUROR_COUNT, phaseVersions, type PhaseVersions } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { INNGEST_FUNCTIONS } from '@/app/api/inngest/route';
import { GET as verdictGet } from '@/app/v/[slug]/route';
import { boardPaths } from '@/lib/delivery/revalidate';
import { settleDelivery } from '@/lib/delivery/settle';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import {
  executePlacement,
  executeRun,
  RUN_DELIVERED,
  type PlacementRequestedData,
} from '@/lib/pipeline/inngest';
import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import type { RunnerBindings, RunScope, PaidListing } from '@/lib/pipeline/service';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore, placementScope, type PipelineStore } from '@/lib/pipeline/store';
import type { DeliveryRecord } from '@/lib/pipeline/types';
import { registerVerdictStore, resetVerdictStore } from '@/lib/verdict/service';
import { MemoryVerdictStore } from '@/lib/verdict/store';

import { FakeDelivery, RecordingInvalidator } from './helpers/delivery.js';
import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  JURORS,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
} from './helpers/panel.js';
import { newProduct, NEW_ID, SEED_SIZE } from './helpers/place.js';

const ACCOUNT = '99999999-8888-4777-8666-555555555555';
const EMAIL = 'payer@example.com';
const LISTING = '77777777-6666-4555-8444-333333333333';
const PLACEMENT_RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A memory store that also carries the run identity a durable one would. */
class IdentifiedStore extends MemoryPipelineStore {
  readonly runId: string;

  constructor(category: string, runId: string) {
    super(category);
    this.runId = runId;
  }
}

/** One call to the store factory, kept so a test can assert what was ASKED for. */
interface StoreRequest {
  readonly category: string;
  readonly placement: number | undefined;
  readonly paid: PaidListing | undefined;
}

/**
 * Bindings that record every scope the pipeline asked a store for.
 *
 * The scope is what carries "this row was bought" to the durable store —
 * `MemoryRunStore` has no `source` column to write it into, and the Postgres
 * assertion lives in `test/delivery-pg.test.ts`. What this double proves is the
 * WIRING: that the placement path asks for a paid-scoped store for the
 * CATEGORY's catalogue and an unscoped one for its own phase envelopes. A
 * placement that silently stopped passing the scope would still place the
 * product, still republish the board, and write the customer's listing as
 * unclaimed.
 */
function memoryBindings(): {
  bindings: RunnerBindings;
  requests: StoreRequest[];
  stores: Map<string, IdentifiedStore>;
  snapshots: MemorySnapshotSink;
} {
  const stores = new Map<string, IdentifiedStore>();
  const requests: StoreRequest[] = [];
  const snapshots = new MemorySnapshotSink();
  const claims = new MemoryPlacementClaims();

  const store = (key: string, runId: string): PipelineStore => {
    const existing = stores.get(key);
    if (existing !== undefined) return existing;
    const created = new IdentifiedStore(key, runId);
    stores.set(key, created);
    return created;
  };

  return {
    stores,
    requests,
    snapshots,
    bindings: {
      claims,
      categories: new MemoryCategorySource([
        {
          category: CATEGORY,
          products: makeProducts(SEED_SIZE),
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion: CATEGORY_VERSION },
        },
      ]),
      store: (category: string, _versions: PhaseVersions, scope?: RunScope) => {
        requests.push({ category, placement: scope?.placement, paid: scope?.paid });
        return scope?.placement === undefined
          ? store(category, `run:${category}`)
          : store(placementScope(category, scope.placement), PLACEMENT_RUN_ID);
      },
      snapshots,
    },
  };
}

async function seed(bindings: RunnerBindings): Promise<void> {
  await executeRun(
    { slug: CATEGORY_SLUG },
    bindings,
    new RecordingStepRunner(),
    undefined,
    new FixtureClient(makeScript()),
  );
}

/** One paid placement through the registered function body. */
async function paidPlacement(): Promise<{
  record: DeliveryRecord;
  requests: StoreRequest[];
  snapshots: MemorySnapshotSink;
}> {
  const { bindings, requests, snapshots } = memoryBindings();
  await seed(bindings);
  requests.length = 0; // the seed's own store requests are not the subject

  const delivered: DeliveryRecord[] = [];
  const data: PlacementRequestedData = {
    slug: CATEGORY_SLUG,
    product: newProduct(),
    payer: { accountId: ACCOUNT, email: EMAIL, attemptNumber: 2 },
  };

  const outcome = await executePlacement(
    data,
    bindings,
    new RecordingStepRunner(),
    (record) => {
      delivered.push(record);
      return Promise.resolve();
    },
    new CallMeter(new FixtureClient(makeScript())),
  );

  if (outcome.status !== 'placed') throw new Error(`expected a placement, got ${outcome.status}`);
  const record = delivered[0];
  if (record === undefined) throw new Error('the placement delivered nothing');
  return { record, requests, snapshots };
}

describe('pit/run.delivered has a consumer', () => {
  it('registers a function for it', () => {
    // The whole bug, in one assertion. Before this, `api/inngest/route.ts`
    // registered `[runCategoryFunction, placeProductFunction]` and the delivered
    // event went nowhere: `AttemptsLedger.deliver` had zero callers and no
    // verdict was ever written for a paying customer.
    const ids = INNGEST_FUNCTIONS.map((fn) => fn.id(''));
    expect(ids).toContain('settle-delivery');
  });

  it('registers exactly the three functions the app has', () => {
    // The set, not just the presence: an event whose function is dropped in a
    // refactor produces no error anywhere, so the roster is asserted whole.
    expect(INNGEST_FUNCTIONS.map((fn) => fn.id(''))).toEqual([
      'run-category',
      'place-product',
      'settle-delivery',
    ]);
  });

  it('names the event the pipeline sends', () => {
    expect(RUN_DELIVERED).toBe('pit/run.delivered');
  });
});

describe('the payer reaches the catalogue and the delivery record', () => {
  it('asks for a paid-scoped catalogue store and an unscoped phase store', async () => {
    const { requests } = await paidPlacement();

    // The store the placement writes its CATALOGUE through knows which engine id
    // was bought and by whom — that is what becomes `source = 'paid'` with the
    // submitter's address, and what `products_source_submitter` requires.
    const catalogue = requests.filter((request) => request.placement === undefined);
    expect(catalogue.some((request) => request.paid?.engineId === NEW_ID && request.paid.email === EMAIL)).toBe(
      true,
    );

    // The placement's own PHASE store is unscoped, because it holds envelopes and
    // no products. A paid scope on it would be a claim about a table it never
    // writes.
    const phases = requests.filter((request) => request.placement !== undefined);
    expect(phases).not.toHaveLength(0);
    expect(phases.every((request) => request.paid === undefined)).toBe(true);
  });

  it('puts the payer, the decision and the frozen verdict on the record', async () => {
    const { record } = await paidPlacement();

    expect(record.slug).toBe(CATEGORY_SLUG);
    expect(record.category_version).toBe(CATEGORY_VERSION);
    expect(record.product_count).toBe(SEED_SIZE + 1);
    // The PLACEMENT's job row, not the category's seed run. That is the row
    // `jobs.delivered_at` is set on and the row the consume is keyed to.
    expect(record.run_id).toBe(PLACEMENT_RUN_ID);

    expect(record.paid?.accountId).toBe(ACCOUNT);
    expect(record.paid?.email).toBe(EMAIL);
    expect(record.paid?.engineId).toBe(NEW_ID);
    // `brief §2.4`'s ordinal, computed before the money moved and carried
    // through untouched — the pipeline never recomputes it.
    expect(record.paid?.attemptNumber).toBe(2);
    expect(record.paid?.decision).toMatchObject({ action: 'consume', consumesAttempt: true });
  });

  it('freezes the verdict against the board the customer was shown', async () => {
    const { record, snapshots } = await paidPlacement();

    const payload = record.paid?.payload as {
      product_count: number;
      issued_at: string;
      category_snapshot_version: string;
      verdict: { id: number; name: string };
    };

    // Frozen against THIS board at THIS instant: `brief §1.2` moves every z-score
    // on the next placement, so a payload built later would describe a board the
    // customer never saw, on a URL that is permanent.
    expect(payload.verdict.id).toBe(NEW_ID);
    expect(payload.verdict.name).toBe('Margin');
    expect(payload.product_count).toBe(SEED_SIZE + 1);
    expect(payload.category_snapshot_version).toBe(CATEGORY_VERSION);
    expect(payload.issued_at).toBe(record.delivered_at);

    const board = await snapshots.read(CATEGORY_SLUG);
    expect(board?.generated_at).toBe(record.delivered_at);
    expect(board?.ranking.ranking).toHaveLength(SEED_SIZE + 1);
  });

  it('freezes the panel that judged them — both halves, on a PAID verdict', async () => {
    // `freezePanel` writes the biography behind every axis of both radials, and
    // the buyers come off `ranking.personas` so they ride every path. The JURORS
    // have no roster on a `Ranking` at all (`packages/db/src/verdict-panel.ts`),
    // so only a caller holding the installed jury can supply one — the seed
    // builder did and the delivery path did not, which left a paying customer's
    // verdict page drawing six merit spokes it could name nobody behind.
    //
    // Frozen rather than read at render for the reason the rank is
    // (`DECISIONS.md §1.2`): a jury is versioned, `01 §4` Step 2 bumps
    // `prompt_version` on any mandate edit, and a page that read the current
    // panel would re-attribute its own sentences on a permanent URL.
    const { record } = await paidPlacement();

    const panel = (record.paid?.payload as { panel?: { jurors?: unknown[]; buyers?: unknown[] } }).panel;

    expect(panel?.jurors).toHaveLength(JUROR_COUNT);
    expect(panel?.jurors?.[0]).toEqual({
      role: JURORS[0]?.role,
      who: JURORS[0]?.who,
      cares_most: JURORS[0]?.cares_most,
      biased_against: JURORS[0]?.biased_against,
    });
    // The control: the buyers were never the broken half, and an assertion that
    // only counted a non-empty `panel` would have passed on them alone.
    expect(panel?.buyers).toHaveLength(makePanel().personas.length);
  });

  it('leaves an admin placement unpaid and unclaimed', async () => {
    // The discriminating control. An admin placement has no submission and no
    // payer, so nothing may be charged and no listing may be marked bought.
    const { bindings, requests } = memoryBindings();
    await seed(bindings);
    requests.length = 0;

    const delivered: DeliveryRecord[] = [];
    await executePlacement(
      { slug: CATEGORY_SLUG, product: newProduct() },
      bindings,
      new RecordingStepRunner(),
      (record) => {
        delivered.push(record);
        return Promise.resolve();
      },
      new CallMeter(new FixtureClient(makeScript())),
    );

    expect(delivered[0]?.paid).toBeUndefined();
    expect(requests.every((request) => request.paid === undefined)).toBe(true);
  });
});

describe('the record settles', () => {
  it('consumes exactly one attempt and writes one verdict', async () => {
    const { record } = await paidPlacement();

    const fake = new FakeDelivery();
    fake.grant(ACCOUNT, 3); // the $15 tier: 3 attempts
    fake.addListing(CATEGORY_SLUG, NEW_ID, { productId: LISTING, email: EMAIL });

    const result = await settleDelivery(record, { bindings: fake.bindings() });

    expect(result.outcome).toBe('settled');
    expect(fake.consumes).toHaveLength(1);
    expect(fake.balance(ACCOUNT)).toBe(2);
    expect(fake.state.verdicts[0]?.verdict.attemptNumber).toBe(2);
    expect(fake.state.verdicts[0]?.productCount).toBe(SEED_SIZE + 1);
  });
});

describe('a published placement invalidates the rendered pages, not only the JSON', () => {
  it('names every rendered path that reads the board', () => {
    // `SNAPSHOT_PURGE_URL` purges the board JSON at the CDN. These three are the
    // Next ISR pages built FROM it, and nothing was invalidating them: a paid
    // placement could be live in `/api/boards/<slug>` and up to a day stale on
    // every page a visitor actually lands on.
    expect(boardPaths('health-fitness-wellness')).toEqual([
      '/',
      '/boards',
      '/boards/health-fitness-wellness',
    ]);
  });

  it('invalidates them on a paid delivery', async () => {
    const { record } = await paidPlacement();
    const invalidator = new RecordingInvalidator();
    const fake = new FakeDelivery();
    fake.grant(ACCOUNT, 1);
    fake.addListing(CATEGORY_SLUG, NEW_ID, { productId: LISTING, email: EMAIL });

    await settleDelivery(record, { bindings: fake.bindings(), invalidator });
    expect(invalidator.slugs).toEqual([CATEGORY_SLUG]);
  });
});

describe('the frozen payload renders on the public page', () => {
  it('serves /v/<slug> to a request with no session at all', async () => {
    // The last join, and the one the customer actually sees. The payload asserted
    // above is the one `verdictPayload` froze inside the delivery, so this proves
    // the money path produces a document the PUBLIC route can parse — not merely
    // a jsonb blob that satisfies `verdicts_payload_is_document`.
    const { record } = await paidPlacement();
    const paid = record.paid;
    if (paid === undefined) throw new Error('the placement was not paid for');

    const slug = 'a'.repeat(32);
    resetVerdictStore();
    registerVerdictStore(
      new MemoryVerdictStore([
        {
          publicSlug: slug,
          payload: paid.payload,
          productCount: record.product_count,
          attemptNumber: paid.attemptNumber,
          deliveredAt: new Date(record.delivered_at),
        },
      ]),
    );

    try {
      const response = await verdictGet(new Request(`https://thepit.show/v/${slug}`), {
        params: Promise.resolve({ slug }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      // `brief §2.1`: verdict URLs are public and the balance sits behind a
      // session. A page that needed one could not be cached publicly at the edge
      // and could not be fetched with no cookies at all, so both are asserted.
      expect(response.headers.get('Cache-Control')).toContain('public');
      expect(response.headers.get('Set-Cookie')).toBeNull();

      expect(body).toContain('Margin');
      // `brief §2.4`: the attempt count, shown publicly.
      expect(body).toContain('2nd pitch');
      // `brief` Part 5's stamp: the board this verdict is a claim about.
      expect(body).toContain(String(SEED_SIZE + 1));
    } finally {
      resetVerdictStore();
    }
  });
});
