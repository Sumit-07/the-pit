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
import type { DeliveryRecord, PipelineDeps, PipelineInput } from '@/lib/pipeline/types';

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
}

/** The frozen clock every snapshot in this suite is stamped with. */
export const FIXED_NOW = new Date('2026-03-01T12:00:00.000Z');

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

  const store = options.store ?? new MemoryPipelineStore(CATEGORY);
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
