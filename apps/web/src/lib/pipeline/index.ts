/**
 * The run pipeline — `the-pit-agent-prompts.md` Phase 2's `score → cluster →
 * persona → rank → deliver`, wrapped around `packages/engine`.
 *
 * The engine owns the ranking: the phase graph, the fan-out inside each phase,
 * the version-stamped persistence that makes a retry free, the failure
 * classification, and the three-armed `PhaseResult` union that decides whether a
 * customer is charged. This module owns only what a durable executor and a web
 * surface add on top of it — the step boundaries, the status reconstruction, and
 * the board snapshot a placement publishes.
 *
 * `inngest.ts` is deliberately NOT re-exported here: importing the pipeline
 * should never drag in the Inngest SDK, so the API route imports it directly.
 */

export { CategoryNotRunnableError, FileCategorySource, MemoryCategorySource } from './catalog';
export type { CategorySource } from './catalog';
export { NoModelClient, PhaseFailedError } from './errors';
export { CallMeter, RecordingStepRunner, stepInProgress } from './local';
export type { StoredPhase } from './resume';
export { readStoredPhase, reusableStoredPhase, versionsMoved } from './resume';
export { runPipeline } from './run';
export type { PipelineResult } from './run';
export {
  BOARD_CACHE_CONTROL,
  buildSnapshot,
  DATED_SNAPSHOT_CACHE_CONTROL,
  datedSnapshotKey,
  FileSnapshotSink,
  MemorySnapshotSink,
  SNAPSHOT_VERSION,
} from './snapshot';
export type { BoardSnapshot, PublishedSnapshot, SnapshotSink } from './snapshot';
export { readRunStatus } from './status';
export type { RunState, RunStatus, StatusInput, StepStatus } from './status';
export { FilePipelineStore, MemoryPipelineStore } from './store';
export type { PipelineStore } from './store';
export { PHASE_OF_STEP, PIPELINE_STEPS, STEP_OF_PHASE } from './types';
export type {
  DeliveryRecord,
  PipelineDeps,
  PipelineInput,
  PipelineStep,
  StepReport,
  StepRunner,
} from './types';
export { buildVoteCache, readVoteCache, voteCacheKey } from './vote-cache';
export type { VoteCache } from './vote-cache';
