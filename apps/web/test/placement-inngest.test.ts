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
function memoryBindings(): { bindings: RunnerBindings; stores: Map<string, MemoryPipelineStore>; snapshots: MemorySnapshotSink } {
  const stores = new Map<string, MemoryPipelineStore>();
  const snapshots = new MemorySnapshotSink();

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
    bindings: {
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
