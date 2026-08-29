/**
 * The orchestrator — `01 §2`'s phase graph, `01 §4` Steps 4-6, and the artifacts
 * they write. `docs/plans/phase-1-engine.md` Task 7.
 *
 * Two entry points:
 *
 * - `runCategory` — a whole category: Score || Uniqueness, then Customer.
 * - `runIncremental` — one new product against the calibration sample
 *   (`brief §1.1`), the path every paid submission takes.
 *
 * Plus `projectRun`, the dry run of `01 §4` Step 4's approval gate, which takes
 * no `ModelClient` at all and therefore cannot spend.
 *
 * Everything model-facing goes through the injected `ModelClient` and through
 * `dispatch` (Global Constraint 5): no SDK import, no client construction, no
 * network anywhere below this barrel. That is what lets Task 9 drop in a third
 * adapter and run the whole pipeline against local subagents with no API key.
 */

export { auditScoreCoverage, describeCoverage } from './coverage.js';
export type { CoverageInput } from './coverage.js';
export { dispatch } from './dispatch.js';
export type { DispatchFailed, DispatchOk, DispatchResult } from './dispatch.js';
export { estimateRequestTokens, formatProjection, projectRun } from './dry-run.js';
export type { DryRunInput } from './dry-run.js';
export type { IncrementalInput, IncrementalOutcome, PlacedCluster } from './incremental.js';
export { runIncremental } from './incremental.js';
export { buildLedger, callCost, MODEL_PRICES, PhaseLedger, tierPrices, zeroCost } from './ledger.js';
export type { ModelPrices } from './ledger.js';
export { runCustomerPhase } from './phases/customer.js';
export type { CustomerPhaseInput } from './phases/customer.js';
export { runScorePhase } from './phases/score.js';
export type { ScorePhaseInput } from './phases/score.js';
export { runUniquenessPhase } from './phases/uniqueness.js';
export type { UniquenessPhaseInput } from './phases/uniqueness.js';
export { isDeliverable, runCategory } from './run-category.js';
export type { RunCategoryInput, RunConfig } from './run-category.js';
export { DEFAULT_WORKDIR, FileRunStore, MemoryRunStore } from './store.js';
export type { RunStore } from './store.js';
export type {
  CostLedger,
  CustomerPhaseValue,
  DryRunPhase,
  DryRunProjection,
  FailureCode,
  PhaseCost,
  PhaseFailed,
  PhaseFailure,
  PhaseName,
  PhaseOk,
  PhaseResult,
  PhaseSkipped,
  PhaseSummary,
  RunDemand,
  RunMeta,
  RunOutcome,
  RunResults,
  ScoreCoverage,
  ScorePhaseValue,
  SkipReason,
  SubstitutedCell,
  UniquenessPhaseValue,
} from './types.js';
