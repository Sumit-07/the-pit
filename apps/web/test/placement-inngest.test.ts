/**
 * The paid path through the registered function body — one seeded category, one
 * submission, end to end, with only the bindings and the model swapped for
 * in-memory ones.
 *
 * `executePlacement` is what `pit/placement.requested` actually runs, so this is
 * the test that says the path is WIRED rather than merely implemented: the event
 * payload turns into a category, its stored votes and its board; the placement
 * runs as five steps; the board is republished and an attempt is consumed.
 *
 * Hand-derived: the seed run is 8 products (6 + 1 + 4 = 11 calls) and the
 * placement is 6 + 1 + 4 = 11 more, across five steps each.
 */

import { FixtureClient, phaseVersions, type PhaseVersions } from '@the-pit/engine';
import { NonRetriableError } from 'inngest';
import { describe, expect, it } from 'vitest';

import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import {
  executePlacement,
  executeRun,
  PLACEMENT_REQUESTED,
  type PlacementRequestedData,
} from '@/lib/pipeline/inngest';
import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import type { RunnerBindings, RunScope } from '@/lib/pipeline/service';
import { MemoryPlacementClaims, PlacementInFlightError } from '@/lib/pipeline/claims';
import { isTerminalFailure } from '@/lib/pipeline/errors';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore, placementScope, type PipelineStore } from '@/lib/pipeline/store';
import { PIPELINE_STEPS } from '@/lib/pipeline/types';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
  OPEN_NEW,
} from './helpers/panel.js';
import { newProduct, NEW_ID, SEED_SIZE } from './helpers/place.js';

/**
 * Bindings whose store factory is keyed by name, exactly as a durable one is.
 *
 * A factory that returned ONE store whatever it was asked for would hide the
 * thing this suite most needs to be true: a placement's phases and the seed run's
 * phases are different documents under the same version stamp, and they are kept
 * apart by being addressed differently.
 */
function memoryBindings(): {
  bindings: RunnerBindings;
  stores: Map<string, MemoryPipelineStore>;
  snapshots: MemorySnapshotSink;
  claims: MemoryPlacementClaims;
} {
  const stores = new Map<string, MemoryPipelineStore>();
  const snapshots = new MemorySnapshotSink();
  const claims = new MemoryPlacementClaims();

  const store = (category: string): PipelineStore => {
    const existing = stores.get(category);
    if (existing !== undefined) return existing;
    const created = new MemoryPipelineStore(category);
    stores.set(category, created);
    return created;
  };

  return {
    stores,
    snapshots,
    claims,
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
      // The third argument is what keeps a placement's phases off the seed run's.
      // A factory that ignored it would put both under one key — and the test
      // below would then read a cluster ROSTER back as this placement's
      // assignment, which is the whole hazard `placementScope` exists to remove.
      store: (category: string, _versions: PhaseVersions, scope?: RunScope) =>
        store(scope?.placement === undefined ? category : placementScope(category, scope.placement)),
      snapshots,
    },
  };
}

/** Seed the category the way the run function does, so a placement has votes to append to. */
async function seed(bindings: RunnerBindings): Promise<void> {
  await executeRun(
    { slug: CATEGORY_SLUG },
    bindings,
    new RecordingStepRunner(),
    undefined,
    new FixtureClient(makeScript()),
  );
}

describe('the placement event', () => {
  it('names the event the enqueuer sends', () => {
    expect(PLACEMENT_REQUESTED).toBe('pit/placement.requested');
  });
});

describe('one submission, end to end through the function body', () => {
  it('places it, republishes the board, and consumes an attempt', async () => {
    const { bindings, snapshots } = memoryBindings();
    await seed(bindings);
    expect(snapshots.published).toHaveLength(1);

    const meter = new CallMeter(new FixtureClient(makeScript()));
    const runner = new RecordingStepRunner();
    const delivered: unknown[] = [];

    const data: PlacementRequestedData = { slug: CATEGORY_SLUG, product: newProduct() };
    const outcome = await executePlacement(
      data,
      bindings,
      runner,
      (record) => {
        delivered.push(record);
        return Promise.resolve();
      },
      meter,
    );

    if (outcome.status !== 'placed') throw new Error(`expected a placement, got ${outcome.status}`);
    expect(outcome.assignment.cluster_id).toBe('pair-0');
    expect(outcome.product_count).toBe(SEED_SIZE + 1);

    expect(runner.ids).toHaveLength(PIPELINE_STEPS.length);
    expect(meter.total).toBe(11);

    // The board the seed published, republished — same key, one more product.
    expect(snapshots.published).toHaveLength(2);
    expect((await snapshots.read(CATEGORY_SLUG))?.ranking.ranking).toHaveLength(SEED_SIZE + 1);
    // `brief §2.3`: an attempt is consumed only on delivery, after the board exists.
    expect(delivered).toHaveLength(1);
  });

  it('stores the placement’s phases apart from the seeded run’s', async () => {
    const { bindings, stores } = memoryBindings();
    await seed(bindings);

    await executePlacement(
      { slug: CATEGORY_SLUG, product: newProduct() },
      bindings,
      new RecordingStepRunner(),
      undefined,
      new FixtureClient(makeScript()),
    );

    // Two scopes, one category. The category's own store holds the seed's phases
    // and the updated `results.json`/`ranking.json`; the placement's holds three
    // envelopes of its own.
    expect([...stores.keys()]).toEqual([CATEGORY, `${CATEGORY} placement ${NEW_ID}`]);
    const placement = stores.get(`${CATEGORY} placement ${NEW_ID}`);
    expect([...(placement?.phases.keys() ?? [])].sort()).toEqual(['customer', 'score', 'uniqueness']);
    expect(placement?.results).toBeUndefined();
    expect(stores.get(CATEGORY)?.results?.scoreLog[0]?.scores).toHaveLength(SEED_SIZE + 1);
  });

  it('delivers a solo placement rather than failing it', async () => {
    const { bindings, snapshots } = memoryBindings();
    await seed(bindings);

    const outcome = await executePlacement(
      { slug: CATEGORY_SLUG, product: newProduct() },
      bindings,
      new RecordingStepRunner(),
      undefined,
      new FixtureClient(makeScript({ assignAnswer: OPEN_NEW })),
    );

    if (outcome.status !== 'placed') throw new Error(`expected a placement, got ${outcome.status}`);
    expect(outcome.assignment.is_new).toBe(true);
    expect(snapshots.published).toHaveLength(2);
  });

  it('refuses a slug that is not seeded, without retrying it', async () => {
    const { bindings } = memoryBindings();
    await expect(
      executePlacement(
        { slug: 'not-a-category', product: newProduct() },
        bindings,
        new RecordingStepRunner(),
        undefined,
        new FixtureClient([]),
      ),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it('refuses a category that has never been run', async () => {
    // No amount of retrying produces the scores, clusters and votes a placement
    // appends to. Seeding the category is a separate operation.
    const { bindings } = memoryBindings();
    await expect(
      executePlacement(
        { slug: CATEGORY_SLUG, product: newProduct() },
        bindings,
        new RecordingStepRunner(),
        undefined,
        new FixtureClient([]),
      ),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it('addresses the store by the versions the run is judged under', async () => {
    const { bindings } = memoryBindings();
    await seed(bindings);

    // The same value `runPlacement` stamps its envelopes with, so a bumped
    // `prompt_version` reads no phases and re-runs rather than resuming another
    // run's work.
    const input = await bindings.categories.load(CATEGORY_SLUG);
    expect(input).toBeDefined();
    expect(phaseVersions(input!)).toMatchObject({
      category_version: CATEGORY_VERSION,
      prompt_version: 'jury-v1',
      persona_version: 'personas-v1',
    });
  });
});

describe('one submission buys one placement', () => {
  /**
   * `jobIdempotencyKey` from `@the-pit/payments`, as a submission would carry it.
   *
   * The real one is a SHA-256 over `(accountId, normalizedUrl, descriptionHash,
   * cycleId)`. Only two properties matter here and both are the payments
   * package's: the same submission produces the same key, and a re-pitch in a
   * LATER cycle produces a different one.
   */
  const KEY = 'a'.repeat(64);
  const RE_PITCH_KEY = 'b'.repeat(64);

  /** One placement, metered, so a second one is visible as calls rather than as prose. */
  async function place(
    bindings: RunnerBindings,
    data: Partial<PlacementRequestedData> = {},
  ): Promise<{ outcome: Awaited<ReturnType<typeof executePlacement>>; calls: number }> {
    const meter = new CallMeter(new FixtureClient(makeScript()));
    const outcome = await executePlacement(
      { slug: CATEGORY_SLUG, product: newProduct(), ...data },
      bindings,
      new RecordingStepRunner(),
      undefined,
      meter,
    );
    return { outcome, calls: meter.total };
  }

  it('runs ONE pipeline for two events carrying the same key, and resolves to the first', async () => {
    // The gap. `place-product` serializes placements against each other per slug,
    // which does not stop a genuinely new event for the same submission entering
    // the queue — a retried webhook, a re-POSTed status page, a replay fired in
    // the window between a successful `rank` and a failed `deliver`. The customer
    // is charged once (`brief §2.3` consumes an attempt only on delivery) and the
    // inference is bought twice.
    //
    // 11 then 0 is the whole assertion: 6 juror calls + 1 clustering + 4 forced
    // choices, and then nothing. A pipeline that ran again reads 11 and 11.
    const { bindings, snapshots } = memoryBindings();
    await seed(bindings);
    expect(snapshots.published).toHaveLength(1);

    const first = await place(bindings, { idempotencyKey: KEY });
    expect(first.calls).toBe(11);
    if (first.outcome.status !== 'placed') throw new Error('expected a placement');

    // The second event carries the bumped population version the first placement
    // produced — which is what makes it a genuinely different RUN and not an
    // Inngest retry, and is exactly the shape the double-placement takes
    // (`brief §1.2` moves every z-score, so the version has to move with it).
    const second = await place(bindings, { idempotencyKey: KEY, categoryVersion: 'cat-v2' });
    expect(second.calls).toBe(0);
    expect(second.outcome).toEqual(first.outcome);

    // And the board was republished once, not twice.
    expect(snapshots.published).toHaveLength(2);
  });

  it('still runs twice for two genuinely different submissions, so a re-pitch is not blocked', async () => {
    // The negative control, and it is not optional: `brief §2.4` lets the same
    // product be pitched again after the next rebuild, which
    // `packages/payments/src/listing/repitch.ts` implements. The cycle id is IN
    // the key precisely so that an identical re-pitch a week later does not
    // silently resolve to the first job — a guard keyed on the product would have
    // blocked the one path the brief explicitly allows.
    const { bindings, snapshots } = memoryBindings();
    await seed(bindings);

    const first = await place(bindings, { idempotencyKey: KEY });
    // A re-pitch inserts a NEW product row (`migrations/0002` freezes a scored
    // product's text, so it cannot be an edit) under a new cycle, therefore a new
    // key. Both halves have to differ or the test is asserting the resume gate
    // rather than the guard.
    const second = await place(bindings, {
      idempotencyKey: RE_PITCH_KEY,
      product: newProduct({ id: NEW_ID + 1, url: 'https://example.com/100', normalized_url: 'example.com/100' }),
    });

    expect(first.calls).toBe(11);
    expect(second.calls).toBe(11);
    expect(snapshots.published).toHaveLength(3);
  });

  it('lets the SAME event retry, because a retry is not a duplicate', async () => {
    // `brief §2.3`'s free retry has to survive the guard. A retried event carries
    // the same key AND the same versions, so it addresses the claim it already
    // owns rather than colliding with someone else's — and it resumes the phases
    // it already paid for instead of being refused outright.
    const { bindings } = memoryBindings();
    await seed(bindings);

    const first = await place(bindings, { idempotencyKey: KEY });
    expect(first.calls).toBe(11);

    // Same key, same versions: attempt two of ONE event. It resolves to the
    // outcome attempt one recorded and buys nothing — a finished submission never
    // runs again, whoever asks.
    const retry = await place(bindings, { idempotencyKey: KEY });
    expect(retry.calls).toBe(0);
    expect(retry.outcome).toEqual(first.outcome);
  });

  it('lets a FAILED attempt be retried under its own claim', async () => {
    // The other half of the same rule, and the one that would break `brief §2.3`
    // if the guard were a blanket: a claim taken before the first step is still
    // held when that step fails, and the retry has to be allowed through to
    // resume the phases it already paid for. Nothing was recorded, because a
    // failure is not an outcome.
    const { bindings, claims } = memoryBindings();
    await seed(bindings);

    const versions = phaseVersions((await bindings.categories.load(CATEGORY_SLUG))!);
    const submission = { key: KEY, slug: CATEGORY_SLUG, versions, productId: NEW_ID };
    const claimed = await claims.claim(submission);
    expect(claimed.mine).toBe(true);
    expect(claimed.outcome).toBeUndefined();

    // The retry re-claims the key it already owns and runs.
    const retry = await place(bindings, { idempotencyKey: KEY });
    expect(retry.outcome.status).toBe('placed');
    expect(retry.calls).toBe(11);
  });

  it('tells a duplicate to come back when the first placement has not finished', async () => {
    // Nothing was spent and nothing is decided yet, so the honest answer is "not
    // now" — an ordinary error, which Inngest retries with backoff. NOT terminal:
    // the thing that makes the retry succeed is the first placement landing.
    const { bindings, claims } = memoryBindings();
    await seed(bindings);

    const versions = phaseVersions((await bindings.categories.load(CATEGORY_SLUG))!);
    // An owner that claimed and has not recorded — the in-flight state exactly.
    await claims.claim({ key: KEY, slug: CATEGORY_SLUG, versions, productId: NEW_ID });

    const meter = new CallMeter(new FixtureClient(makeScript()));
    await expect(
      executePlacement(
        { slug: CATEGORY_SLUG, product: newProduct(), idempotencyKey: KEY, categoryVersion: 'cat-v2' },
        bindings,
        new RecordingStepRunner(),
        undefined,
        meter,
      ),
    ).rejects.toBeInstanceOf(PlacementInFlightError);

    expect(meter.total).toBe(0);
    expect(isTerminalFailure(new PlacementInFlightError('run-1'))).toBe(false);
  });

  it('places normally when no key is supplied, so an admin placement is not blocked', async () => {
    // An admin placement has no submission and no payer. Making the key mandatory
    // would only mean that path invented one.
    const { bindings } = memoryBindings();
    await seed(bindings);
    const outcome = await place(bindings);
    expect(outcome.outcome.status).toBe('placed');
    expect(outcome.calls).toBe(11);
  });
});
