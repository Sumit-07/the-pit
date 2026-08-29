/**
 * The Phase 1 report — `docs/plans/phase-1-engine.md` Task 8.
 *
 * `the-pit-agent-prompts.md` Phase 1: "Then STOP and report … Do not proceed to
 * Phase 2 until I've seen these numbers." Everything the other eight tasks built
 * exists to produce this document.
 *
 * Two halves, deliberately separated:
 *
 * - **`buildReport` / `renderReport` are PURE.** Arithmetic over stored
 *   `results.json` and `ranking.json` rows. No model call, no network, no clock.
 *   A statistic that needed a model would not belong in a gate report: the report
 *   has to be re-derivable from the integrity record long after the run.
 * - **`runAbCheck` SPENDS.** The fix-1.1 A/B and the test-retest baseline require
 *   running products through both scoring paths, which is model calls. It lives
 *   behind its own command, writes `ab.json`, and the report reads that file.
 */

export type {
  AbCheckInput,
  AbCheckResult,
  AbPathResult,
  AbProduct,
  AbSummary,
} from './ab-check.js';
export { abSlug, runAbCheck, selectTargets, summarizeAb, sumLedgers } from './ab-check.js';
export type {
  ClusterReport,
  ClusterSizeBar,
  DemandCoverage,
  NoveltyReport,
  Spread,
} from './clusters.js';
export { BLEND_WEIGHTS, clusterReport, demandCoverage, noveltyReport, summarize } from './clusters.js';
export type {
  CostBasis,
  MeasuredCost,
  PassProjection,
  PriceRow,
  RecalibrationSchedule,
  ScheduleInput,
} from './cost.js';
export {
  measuredCost,
  monthlySpend,
  NIGHTS_PER_MONTH,
  priceTable,
  projectSchedule,
  PRICE_TABLE_SOURCE_DATE,
  WEEKS_PER_MONTH,
} from './cost.js';
export type { LeakReport } from './leak.js';
export { describeLeak, leakReport } from './leak.js';
export type { GateCheck, ReportInput, ReportModel, ReportProvenance } from './model.js';
export { buildReport } from './model.js';
export type {
  CorrelationInput,
  CorrelationReport,
  DeductionReport,
  DistributionInput,
  JurorDeductionRate,
  JurorMetricDistribution,
  JurorPair,
  PanelCompleteness,
  PanelCompletenessInput,
} from './panel.js';
export {
  discriminationOverFullPanel,
  jurorCorrelations,
  jurorDeductions,
  jurorDistributions,
  panelCompleteness,
} from './panel.js';
export { formatReportSummary, renderReport } from './render.js';
export { median, pearson, quantile, rankAverages, spearman } from './stats.js';
