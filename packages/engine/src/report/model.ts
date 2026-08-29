/**
 * `buildReport` — every number the Phase 1 gate demands, assembled from stored
 * rows and nothing else.
 *
 * `the-pit-agent-prompts.md` Phase 1 ends "Do not proceed to Phase 2 until I've
 * seen these numbers." This function produces them, and it is PURE: its inputs
 * are `results.json`, `ranking.json`, `products.json`, the installed jury, and
 * optionally a stored `ab.json`. It calls no model, opens no socket and reads no
 * file. A statistic that needed a model call would not belong in a gate report at
 * all — the report has to be re-derivable from the integrity record long after
 * the run, by someone disputing it (`brief` Part 7).
 *
 * The A/B check is the one exception, and it is handled by exclusion rather than
 * by a flag: `runAbCheck` spends, so it lives in its own module behind its own
 * command, writes `ab.json`, and this function merely reads the result. If the
 * file is absent the report says the fix-1.1 evidence is MISSING, in the gate
 * table, at the top — because a Phase 1 report without it does not answer the
 * question Phase 1 was for.
 *
 * ## Ordering
 *
 * `gates` is deliberately ordered by what would stop the project, not by what is
 * easy to compute: discrimination and panel completeness, then juror correlation,
 * then the A/B-versus-test-retest comparison, then cost. The descriptive
 * statistics — score distributions, cluster histograms — come last in the
 * rendered document. A founder reading this once should hit the numbers that
 * change a decision before the numbers that fill a page.
 */

import { DISCRIMINATION_FLOOR, JUROR_CORRELATION_CEILING, RECAL_NIGHTLY_TOP_N } from '../config/constants.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { categorySlug } from '../panels/seeded.js';
import type { RunResults } from '../run/types.js';
import type { Health, Jury, Persona, Product, Ranking } from '../types.js';
import type { AbCheckResult } from './ab-check.js';
import {
  clusterReport,
  demandCoverage,
  noveltyReport,
  type ClusterReport,
  type DemandCoverage,
  type NoveltyReport,
} from './clusters.js';
import {
  measuredCost,
  priceTable,
  projectSchedule,
  PRICE_TABLE_SOURCE_DATE,
  type MeasuredCost,
  type PriceRow,
  type RecalibrationSchedule,
} from './cost.js';
import { describeLeak, leakReport, type LeakReport } from './leak.js';
import {
  discriminationOverFullPanel,
  jurorCorrelations,
  jurorDeductions,
  jurorDistributions,
  panelCompleteness,
  type CorrelationReport,
  type DeductionReport,
  type JurorMetricDistribution,
  type PanelCompleteness,
} from './panel.js';

/** One line of the gate table at the top of the report. */
export interface GateCheck {
  name: string;
  /**
   * - `pass` — the number is where it should be.
   * - `flag` — it is not, and the report says what that means.
   * - `missing` — the evidence was not produced, which is not the same as passing.
   * - `info` — a number that must be read but that this report refuses to judge.
   *   The leak correlation is the only one: it cannot separate leakage from
   *   genuine agreement, so a pass/fail on it would be a claim the statistic
   *   does not support.
   */
  status: 'pass' | 'flag' | 'missing' | 'info';
  value: string;
  note: string;
}

/** The versions the numbers below were produced under. */
export interface ReportProvenance {
  category_version: string;
  prompt_version: string;
  persona_version: string;
  uniqueness_version: string;
  engine_version: string;
  /** `delivered` or `failed`, from `results.meta`. */
  outcome: string;
}

/** Everything the Phase 1 report contains. Rendered by `renderReport`. */
export interface ReportModel {
  category: string;
  slug: string;
  provenance: ReportProvenance;
  products: number;
  metrics: string[];
  health: Health;
  completeness: PanelCompleteness;
  /** `discrimination` renormalized over the installed panel; see `panel.ts`. */
  discrimination_over_full_panel: number;
  distributions: JurorMetricDistribution[];
  deductions: DeductionReport;
  correlation: CorrelationReport;
  clusters: ClusterReport;
  novelty: NoveltyReport;
  demand: DemandCoverage;
  leak: LeakReport;
  leak_reading: string;
  cost: MeasuredCost;
  schedule: RecalibrationSchedule;
  prices: PriceRow[];
  price_table_date: string;
  /** Absent when no `ab.json` was produced — a gate failure, not an omission. */
  ab?: AbCheckResult;
  gates: GateCheck[];
  /** `results.meta.warnings`, carried through verbatim. */
  warnings: string[];
}

export interface ReportInput {
  ranking: Ranking;
  results: RunResults;
  products: readonly Product[];
  /** The INSTALLED jury: authoritative for who should have answered and with what weights. */
  jury: Jury;
  personas: readonly Persona[];
  /** A stored A/B result, if one has been produced. */
  ab?: AbCheckResult;
  /** Categories the schedule projects over. Defaults to the measured `CATEGORY_COUNT`. */
  categories?: number;
  chunkSize?: number;
}

/** Assemble the Phase 1 report. Pure — see the header. */
export function buildReport(input: ReportInput): ReportModel {
  const rows = input.ranking.ranking;
  const productIds = input.products.map((product) => product.id);
  const metricNames = input.ranking.metrics.map((metric) => metric.name);

  const completeness = panelCompleteness({
    scoreLog: input.results.scoreLog,
    jury: input.jury.jurors,
    productIds,
    metricNames,
  });

  const correlation = jurorCorrelations({
    scoreLog: input.results.scoreLog,
    jury: input.jury.jurors,
    productIds,
  });

  const deductions = jurorDeductions({ scoreLog: input.results.scoreLog, productIds, metricNames });
  const distributions = jurorDistributions({ scoreLog: input.results.scoreLog, productIds, metricNames });

  const clusters = clusterReport(rows);
  const novelty = noveltyReport(rows);
  const demand = demandCoverage(rows);
  const leak = leakReport(rows, input.products);

  const ordering: PanelOrdering = {
    category: input.ranking.category,
    categoryVersion: input.results.meta.category_version,
  };

  // The nightly pass re-scores the TOP 20 of the board (`brief` Part 3), so the
  // projection renders those products' text, not an arbitrary slice. Falling back
  // to the head of the product list would project a different prompt from the one
  // a nightly pass would send.
  const byId = new Map(input.products.map((product) => [product.id, product]));
  const nightlyProducts = [...rows]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, RECAL_NIGHTLY_TOP_N)
    .flatMap((row) => {
      const product = byId.get(row.id);
      return product === undefined ? [] : [product];
    });

  const schedule = projectSchedule({
    category: input.ranking.category,
    products: input.products,
    nightlyProducts,
    jury: input.jury,
    personas: input.personas,
    ordering,
    ...(input.categories === undefined ? {} : { categories: input.categories }),
    ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
  });

  const cost = measuredCost(input.results.meta.ledger);
  const adjusted = discriminationOverFullPanel(input.ranking.health.discrimination, completeness);

  const model: ReportModel = {
    category: input.ranking.category,
    slug: categorySlug(input.ranking.category),
    provenance: {
      category_version: input.results.meta.category_version,
      prompt_version: input.results.meta.prompt_version,
      persona_version: input.results.meta.persona_version,
      uniqueness_version: input.results.meta.uniqueness_version,
      engine_version: input.results.meta.engine_version,
      outcome: input.results.meta.outcome,
    },
    products: rows.length,
    metrics: metricNames,
    health: input.ranking.health,
    completeness,
    discrimination_over_full_panel: adjusted,
    distributions,
    deductions,
    correlation,
    clusters,
    novelty,
    demand,
    leak,
    leak_reading: describeLeak(leak),
    cost,
    schedule,
    prices: priceTable(),
    price_table_date: PRICE_TABLE_SOURCE_DATE,
    gates: [],
    warnings: [...input.results.meta.warnings],
  };
  if (input.ab !== undefined) model.ab = input.ab;

  model.gates = buildGates(model);
  return model;
}

/**
 * The gate table, in the order a finding would stop the project.
 *
 * Every `flag` carries the consequence, not just the number: a founder deciding
 * go/no-go needs to know what a low `discrimination` DOES, which is that the
 * board is decided by the 0.075 uniqueness tilt and by demand rather than by
 * merit.
 */
function buildGates(model: ReportModel): GateCheck[] {
  const gates: GateCheck[] = [];
  const money = (usd: number): string => `$${usd.toFixed(2)}`;

  // 1. Discrimination — `01 §6.5`.
  const belowFloor = model.health.discrimination < DISCRIMINATION_FLOOR;
  const adjustedBelowFloor = model.discrimination_over_full_panel < DISCRIMINATION_FLOOR;
  const flips = belowFloor !== adjustedBelowFloor;
  gates.push({
    name: 'discrimination',
    status: belowFloor || adjustedBelowFloor ? 'flag' : 'pass',
    value: model.health.discrimination.toFixed(4),
    note: belowFloor
      ? `Below ${DISCRIMINATION_FLOOR} (01 §6.5): products score alike, so MERIT ALONE IS FRAGILE. ` +
        'The board is then decided by demand and by the ±0.075 uniqueness tilt rather than by the jury.'
      : flips
        ? `Above ${DISCRIMINATION_FLOOR} as reported, but the panel is short: normalized over the whole ` +
          `installed jury it is ${model.discrimination_over_full_panel.toFixed(4)}, which is BELOW the floor. ` +
          'The pass is an artefact of dividing by the jurors that answered.'
        : `Above ${DISCRIMINATION_FLOOR} (01 §6.5): the jury separates the products.`,
  });

  // 2. Panel completeness — read alongside the above, never after it.
  const { jurors_present, jurors_expected, cells_substituted, missing_roles } = model.completeness;
  gates.push({
    name: 'panel completeness',
    status: model.completeness.complete ? 'pass' : 'flag',
    value: `${jurors_present}/${jurors_expected} jurors, ${cells_substituted} substituted cells`,
    note: model.completeness.complete
      ? 'Every installed juror answered every product on every metric.'
      : `computeComposite divides by the jurors PRESENT (${jurors_present}), not by the installed panel ` +
        `(${jurors_expected}), so every composite — and therefore discrimination — is scaled by ` +
        `${jurors_expected}/${jurors_present} = ${(jurors_expected / Math.max(jurors_present, 1)).toFixed(3)} ` +
        `relative to a full-panel normalization. ` +
        (missing_roles.length > 0 ? `Missing: ${missing_roles.join(', ')}. ` : '') +
        (cells_substituted > 0
          ? `${cells_substituted} scorecard cells publish a substituted ${'50'} where a juror's opinion should be.`
          : ''),
  });

  // 3. Juror correlation — the only quantitative proxy for `01 §4` Step 2's
  //    "the jury must genuinely disagree", which is otherwise a human gate.
  const worst = model.correlation.max_pair;
  gates.push({
    name: 'juror independence',
    status: model.correlation.flagged.length > 0 ? 'flag' : 'pass',
    value:
      worst === undefined
        ? 'n/a (fewer than two jurors)'
        : `max pair r = ${worst.r.toFixed(4)} (${worst.a} / ${worst.b})`,
    note:
      model.correlation.flagged.length > 0
        ? `${model.correlation.flagged.length} pair(s) at or above ${JUROR_CORRELATION_CEILING}: those jurors ` +
          'are one juror with a doubled vote. REDESIGN THE MANDATES before seeding further categories — ' +
          'a panel that agrees with itself produces a board with no information in it.'
        : `No pair reaches ${JUROR_CORRELATION_CEILING}; mean pair correlation ` +
          `${model.correlation.mean_pair_correlation.toFixed(4)}. The jurors are saying different things.`,
  });

  // 4. Dead weight.
  gates.push({
    name: 'juror deduction rate',
    status: model.deductions.dead_weight_roles.length > 0 ? 'flag' : 'pass',
    value: `median ${model.deductions.median_points.toFixed(0)} points, cut at ${model.deductions.threshold.toFixed(0)}`,
    note:
      model.deductions.dead_weight_roles.length > 0
        ? `Dead weight: ${model.deductions.dead_weight_roles.join(', ')} — under half the panel median. ` +
          'A juror that barely deducts still counts in the composite divisor, so it dilutes everyone else.'
        : 'Every juror deducts at least half the panel median.',
  });

  // 5. Fix 1.1 — the reason Phase 1 exists.
  if (model.ab === undefined) {
    gates.push({
      name: 'fix 1.1 evidence (A/B vs test-retest)',
      status: 'missing',
      value: 'not produced',
      note:
        'No ab.json for this category. The A/B check is the ONLY evidence that the calibration sample ' +
        'works, and without it Phase 1 has not answered its own question. Run `engine ab --category "…" --run`.',
    });
  } else {
    const summary = model.ab.summary;
    gates.push({
      name: 'fix 1.1 evidence (A/B vs test-retest)',
      status: summary.ab_exceeds_retest ? 'flag' : 'pass',
      value:
        `A/B ${summary.mean_abs_metric_delta_ab.toFixed(3)} pts vs retest ` +
        `${summary.mean_abs_metric_delta_retest.toFixed(3)} pts over ${model.ab.products.length} product(s)`,
      note: summary.reading,
    });
  }

  // 6. The leak test. `info`, never pass/fail — see `GateCheck.status`.
  gates.push({
    name: 'source-ranking correlation (leak test)',
    status: 'info',
    value: `Spearman ${model.leak.final_rank_vs_orig_rank.toFixed(4)} vs orig_rank (n=${model.leak.n})`,
    note: model.leak_reading,
  });

  // 7. Cost basis.
  gates.push({
    name: 'measured cost basis',
    status: model.cost.basis === 'measured' || model.cost.basis === 'no_calls' ? 'pass' : 'flag',
    value: `${model.cost.basis} — ${money(model.cost.total.cost_usd)} over ${model.cost.total.calls} call(s)`,
    note: model.cost.note,
  });

  // 8. The schedule against `brief` Part 7.
  const schedule = model.schedule;
  gates.push({
    name: 'recalibration schedule vs brief Part 7',
    status: schedule.score_only_within_budget ? 'pass' : 'flag',
    value:
      `${money(schedule.monthly_score_only_usd)}/mo score-only, ` +
      `${money(schedule.monthly_full_pipeline_usd)}/mo full pipeline, over ${schedule.categories} categories`,
    note: schedule.score_only_within_budget
      ? `Inside the $${schedule.budget.min_usd}-${schedule.budget.max_usd} line, which was stated over ` +
        `${schedule.budget.stated_categories} categories. ESTIMATED, not measured.`
      : `OVER the $${schedule.budget.min_usd}-${schedule.budget.max_usd} line by ` +
        `${schedule.score_only_vs_budget_max.toFixed(2)}x on the score-only reading and ` +
        `${schedule.full_pipeline_vs_budget_max.toFixed(2)}x on the full pipeline. That line was stated over ` +
        `${schedule.budget.stated_categories} categories; this schedule runs ${schedule.categories}. ESTIMATED, not measured.`,
  });

  // 9. The demand axis.
  const degenerate = model.demand.degenerate_two || model.demand.degenerate_one || model.demand.no_demand_at_all;
  gates.push({
    name: 'demand coverage',
    status: degenerate ? 'flag' : 'pass',
    value: `${model.demand.with_demand}/${model.demand.products} products have a demand entry`,
    note: model.demand.degenerate_two
      ? 'EXACTLY TWO products carry a demand entry. 01 §6.3 re-standardizes demand, so a population of two ' +
        'always standardizes to ±1: demand contributes a fixed ±0.35 to core regardless of what the personas ' +
        'actually said. The degenerate case is reachable in this data.'
      : model.demand.degenerate_one
        ? 'EXACTLY ONE product carries a demand entry, so its z_demand is 0 (population std of one value) and ' +
          'the demand term vanishes — while it still keeps only MERIT_W of its merit. It is strictly worse off ' +
          'than a solo-cluster product.'
        : model.demand.no_demand_at_all
          ? 'NO product carries a demand entry: the Floor never convened, and every product ranks on merit ' +
            'alone at full weight (DECISIONS.md S3).'
          : `${model.demand.with_demand} products across ${model.demand.clusters_with_demand} cluster(s); ` +
            'the demand axis has a real population to standardize over.',
  });

  return gates;
}
