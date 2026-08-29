/**
 * One seeded category and one placement against it, offline. Not a test file.
 *
 * The seed is a REAL full pipeline run — `runPipeline` over eight products, the
 * same harness the rest of the suite uses — so the `results.json` and
 * `ranking.json` a placement appends to are the documents the pipeline actually
 * produces, not a hand-typed guess at their shape. That matters most for the
 * calibration sample: `selectCalibrationSample` reads published per-metric scores
 * out of the ranking, and a hand-built ranking would let a placement pass with a
 * calibration block the real one could never produce.
 *
 * Everything below runs with no network, no database and no API key (Global
 * Constraint 5); the only thing stubbed is the model, through the engine's
 * `FixtureClient`.
 */

import { FixtureClient, phaseVersions, type Product, type PhaseVersions } from '@the-pit/engine';

import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import { runPlacement, type PlacementInput, type PlacementOutcome } from '@/lib/pipeline/placement';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore, PlacementPhaseStore, placementScope } from '@/lib/pipeline/store';
import type { DeliveryRecord, PipelineDeps } from '@/lib/pipeline/types';

import {
  CATEGORY,
  CATEGORY_VERSION,
  makeJury,
  makePanel,
  makeScript,
  type ScriptOptions,
} from './panel.js';
import { makeHarness, run, FIXED_NOW } from './run.js';

/** The seeded category's size. Eight products, clustered into four pairs. */
export const SEED_SIZE = 8;

/** The id of the submitted product. Deliberately far from the seeded 0-7. */
export const NEW_ID = 99;

/** The submission. Its text is UNTRUSTED and passes `DECISIONS.md` S9's gate. */
export function newProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: NEW_ID,
    name: 'Margin',
    description: 'Turns meeting notes into a shared action list without anyone typing one.',
    url: 'https://example.com/99',
    normalized_url: 'example.com/99',
    orig_rank: 999,
    ...overrides,
  };
}

/** A delivered full run: the category a placement appends to. */
export interface SeededCategory {
  store: MemoryPipelineStore;
  products: Product[];
  input: PlacementInput;
}

/**
 * Run the full pipeline over `SEED_SIZE` products and hand back the category it
 * leaves behind. Eleven model calls: 6 jurors x 1 chunk, 1 clustering pass, 4
 * personas over 4 sets.
 */
export async function seedCategory(): Promise<SeededCategory> {
  const seed = makeHarness({ products: SEED_SIZE });
  await run(seed);

  const results = await seed.store.readResults();
  const ranking = await seed.store.readRanking();
  if (results === undefined || ranking === undefined) throw new Error('the seed run produced no artifacts');

  return {
    store: seed.store,
    products: [...seed.input.products],
    input: {
      category: CATEGORY,
      product: newProduct(),
      products: seed.input.products,
      ranking,
      results,
      jury: makeJury(),
      personas: makePanel(),
      config: { categoryVersion: CATEGORY_VERSION },
    },
  };
}

/** One placement's wiring, held open so a test can inspect every side of it. */
export interface PlacementHarness {
  input: PlacementInput;
  deps: PipelineDeps;
  /** The CATEGORY's store: `results.json`, `ranking.json`, and the seed's phases. */
  category: MemoryPipelineStore;
  /** The PLACEMENT's phase scope. See `placementScope`. */
  phases: MemoryPipelineStore;
  store: PlacementPhaseStore;
  snapshots: MemorySnapshotSink;
  /** The panel itself, which records every request the pipeline SENT. */
  fixture: FixtureClient;
  meter: CallMeter;
  runner: RecordingStepRunner;
  versions: PhaseVersions;
  delivered: DeliveryRecord[];
}

export interface PlacementOptions extends ScriptOptions {
  seeded?: SeededCategory;
  product?: Product;
  /** Reuse an earlier placement's phase scope — this is how a retry is set up. */
  phases?: MemoryPipelineStore;
  snapshots?: MemorySnapshotSink;
}

/** Wire one placement against a seeded category. */
export async function makePlacementHarness(options: PlacementOptions = {}): Promise<PlacementHarness> {
  const seeded = options.seeded ?? (await seedCategory());
  const product = options.product ?? seeded.input.product;
  const input: PlacementInput = { ...seeded.input, product };

  const phases = options.phases ?? new MemoryPipelineStore(placementScope(CATEGORY, product.id));
  const store = new PlacementPhaseStore(seeded.store, phases);
  const snapshots = options.snapshots ?? new MemorySnapshotSink();
  const fixture = new FixtureClient(makeScript(options));
  const meter = new CallMeter(fixture);
  const runner = new RecordingStepRunner();
  const delivered: DeliveryRecord[] = [];

  return {
    input,
    category: seeded.store,
    phases,
    store,
    snapshots,
    fixture,
    meter,
    runner,
    versions: phaseVersions(input),
    delivered,
    deps: {
      client: meter,
      store,
      snapshots,
      now: () => FIXED_NOW,
      onDelivered: (record) => {
        delivered.push(record);
        return Promise.resolve();
      },
    },
  };
}

/** Place the product, expecting it to succeed. */
export async function place(harness: PlacementHarness): Promise<PlacementOutcome> {
  return runPlacement(harness.input, harness.deps, harness.runner);
}

/** Place the product, expecting it to throw, and hand back what it threw. */
export async function placeExpectingFailure(harness: PlacementHarness): Promise<unknown> {
  try {
    await place(harness);
  } catch (error) {
    return error;
  }
  throw new Error('the placement was expected to fail and did not');
}

/** Narrow a placement outcome, failing loudly rather than silently skipping assertions. */
export function placed(outcome: PlacementOutcome): Extract<PlacementOutcome, { status: 'placed' }> {
  if (outcome.status !== 'placed') throw new Error(`expected a placement, got ${outcome.status}`);
  return outcome;
}
