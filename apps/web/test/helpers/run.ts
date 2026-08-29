/**
 * One assembled pipeline run, offline. Not a test file.
 *
 * Every test in this package drives the REAL `runPipeline` through the REAL
 * `RecordingStepRunner` and `CallMeter` that ship in `src/lib/pipeline/local.ts`.
 * Nothing is stubbed except the model, which is the engine's `FixtureClient`. A
 * harness that reimplemented the step loop would let the pipeline's step
 * granularity drift without a single test noticing, which is the one regression
 * this suite exists to catch.
 */

import { FixtureClient, phaseVersions, type ModelClient, type PhaseVersions } from '@the-pit/engine';

import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import { runPipeline, type PipelineResult } from '@/lib/pipeline/run';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore } from '@/lib/pipeline/store';
import type { DeliveryRecord, PaidPlacement, PipelineDeps, PipelineInput } from '@/lib/pipeline/types';

import {
  CATEGORY,
  CATEGORY_VERSION,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
  type ScriptOptions,
} from './panel.js';

/** A run's wiring, held open so a test can inspect every side of it. */
export interface Harness {
  input: PipelineInput;
  deps: PipelineDeps;
  store: MemoryPipelineStore;
  snapshots: MemorySnapshotSink;
  meter: CallMeter;
  runner: RecordingStepRunner;
  versions: PhaseVersions;
  delivered: DeliveryRecord[];
}

export interface HarnessOptions extends ScriptOptions {
  products?: number;
  promptVersion?: string;
  personaVersion?: string;
  categoryVersion?: string;
  /** Reuse an earlier run's store, which is how a resumed run is set up. */
  store?: MemoryPipelineStore;
  /** Reuse an earlier run's snapshot sink. */
  snapshots?: MemorySnapshotSink;
  /** Override the model entirely — used to prove a resumed run buys nothing. */
  client?: ModelClient;
  /**
   * Bill this run to somebody.
   *
   * Absent, the run delivers a board and settles nothing, which is a seed run and
   * an admin re-run. Present, `deliverStep` puts a decision and a frozen verdict
   * document on the delivery record and the settling path can spend an attempt.
   */
  paid?: PaidPlacement;
  /** The durable run identity, when the test needs one to settle against. */
  runId?: string;
}

/** The frozen clock every snapshot in this suite is stamped with. */
export const FIXED_NOW = new Date('2026-03-01T12:00:00.000Z');

/**
 * A memory store that also has a durable run identity.
 *
 * `MemoryPipelineStore` has none, and correctly so: `PipelineStore.runId` is
 * `jobs.id`, and a store that keys a run by nothing has no row to mark delivered.
 * The settling path reads it off the record, so a test that wants to drive a
 * settle has to supply one — naming it here rather than teaching the production
 * store to invent one keeps "a run that cannot be charged for has no id" true
 * everywhere outside this file.
 */
export class IdentifiedMemoryStore extends MemoryPipelineStore {
  readonly runId: string;

  constructor(category: string, runId: string) {
    super(category);
    this.runId = runId;
  }
}

/** The `jobs.id` every paid harness in this suite delivers under. */
export const RUN_ID = '11111111-2222-4333-8444-555555555555';

/** The payer every paid harness in this suite bills. */
export const PAYER: PaidPlacement = {
  accountId: '99999999-8888-4777-8666-555555555555',
  email: 'payer@example.com',
  engineId: 3,
  attemptNumber: 1,
};

export function makeHarness(options: HarnessOptions = {}): Harness {
  const jury = makeJury(options.promptVersion);
  const personas = makePanel(options.personaVersion);
  const input: PipelineInput = {
    category: CATEGORY,
    products: makeProducts(options.products ?? 8),
    jury,
    personas,
    config: { categoryVersion: options.categoryVersion ?? CATEGORY_VERSION },
  };

  const store =
    options.store ??
    (options.runId === undefined
      ? new MemoryPipelineStore(CATEGORY)
      : new IdentifiedMemoryStore(CATEGORY, options.runId));
  const snapshots = options.snapshots ?? new MemorySnapshotSink();
  const meter = new CallMeter(options.client ?? new FixtureClient(makeScript(options)));
  const runner = new RecordingStepRunner();
  const delivered: DeliveryRecord[] = [];

  return {
    input,
    store,
    snapshots,
    meter,
    runner,
    versions: phaseVersions(input),
    delivered,
    deps: {
      client: meter,
      store,
      snapshots,
      now: () => FIXED_NOW,
      ...(options.paid === undefined ? {} : { paid: options.paid }),
      onDelivered: (record) => {
        delivered.push(record);
        return Promise.resolve();
      },
    },
  };
}

/** Run the pipeline and hand back both the harness and the result. */
export async function run(harness: Harness): Promise<PipelineResult> {
  return runPipeline(harness.input, harness.deps, harness.runner);
}

/** Run the pipeline, expecting it to throw, and hand back what it threw. */
export async function runExpectingFailure(harness: Harness): Promise<unknown> {
  try {
    await run(harness);
  } catch (error) {
    return error;
  }
  throw new Error('the pipeline was expected to fail and did not');
}
