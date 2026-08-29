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
 * `pg-store.ts` and `service.ts` are out for the same reason one level down —
 * they pull in `@the-pit/db`, Drizzle and the Postgres driver, and the status
 * page, the boards route and every test of the pure pipeline have no business
 * loading a database driver to read a type. Both are imported by path, exactly as
 * the routes already import `service`.
 *
 * `bucket.ts` IS re-exported: it is `fetch` and JSON, with the transport
 * injected, so it costs a consumer nothing.
 */

export {
  BucketSnapshotSink,
  boardKey,
  datedKey,
  HttpObjectStore,
  MemoryObjectStore,
  ObjectStoreError,
} from './bucket';
export type { HttpObjectStoreConfig, ObjectStore, PutOptions } from './bucket';
export { CategoryNotRunnableError, FileCategorySource, MemoryCategorySource } from './catalog';
export type { CategorySource } from './catalog';
export { MemoryPlacementClaims, placementRunKey, PlacementInFlightError } from './claims';
export type { PlacementClaim, PlacementClaims, PlacementSubmission } from './claims';
export { isTerminalFailure, NoModelClient, PhaseFailedError, SNAPSHOT_VERSION_CONFLICT } from './errors';
export { CallMeter, RecordingStepRunner, stepInProgress } from './local';
export { runPlacement } from './placement';
export type { PlacementInput, PlacementOutcome, PlacementResult } from './placement';
export type { StoredPhase } from './resume';
export { readStoredPhase, reusableStoredPhase, versionsMoved } from './resume';
export { deliverStep, phaseStep, runPipeline } from './run';
export type { DeliverReport, PipelineResult } from './run';
export {
  BOARD_CACHE_CONTROL,
  DATED_SNAPSHOT_CACHE_CONTROL,
  datedSnapshotKey,
  FileSnapshotSink,
  MemorySnapshotSink,
  SNAPSHOT_VERSION,
} from './snapshot';
// `buildSnapshot` alone imports `ENGINE_VERSION` as a VALUE, so it lives in its
// own module: the board read path resolves `SnapshotSink` through `snapshot.ts`,
// and `02 §4` does not let the engine onto that graph. See `snapshot-build.ts`.
export { buildSnapshot } from './snapshot-build';
export type { BoardSnapshot, PublishedSnapshot, SnapshotSink } from './snapshot';
export { readRunStatus } from './status';
export type { RunState, RunStatus, StatusInput, StepStatus } from './status';
export { FilePipelineStore, MemoryPipelineStore, PlacementPhaseStore, placementScope } from './store';
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
