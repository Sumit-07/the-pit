/**
 * Cost: what was spent, what a schedule would spend, and the wall between them.
 *
 * ## Measured and estimated are never added together
 *
 * There are exactly two kinds of dollar figure in this engine and they answer
 * different questions. A MEASURED figure is summed from `usage` on responses that
 * actually came back (`src/run/ledger.ts`). An ESTIMATED figure is
 * `projectRun`'s: input tokens counted off the rendered bytes of requests that
 * were never sent, output tokens derived from the `MAX_TOKENS_*` worst cases.
 * They are reported in separate tables with separate totals, and nothing here
 * ever produces a single number combining the two.
 *
 * ## A measured figure can still be unmeasurable
 *
 * `callCost` books a model id with no price at $0 rather than throwing, because a
 * call has already been paid for by the time it reaches the ledger. `PhaseCost`
 * carries `unpriced_models` so the shortfall travels with the number. Task 9
 * seeds categories through local Claude Code subagents, which cannot report a
 * priced model id at all — so on a locally-seeded run EVERY call lands there and
 * `cost_usd` is `$0.0000` with no meaning behind it. `costBasis` turns that into
 * one of three explicit states, and the report prints the state, never the bare
 * number.
 *
 * ## The price table is printed, with its date
 *
 * Prices are the one input not derivable from a document in this repository, and
 * nothing in the codebase notices when they go stale. `priceTable` and
 * `PRICE_TABLE_DATE` exist so a reader can check a dollar figure against the
 * published rates without opening the source.
 */

import {
  CATEGORY_COUNT,
  DAYS_PER_WEEK,
  DAYS_PER_YEAR,
  MONTHS_PER_YEAR,
  PRICE_TABLE_DATE,
  RECAL_BUDGET_CATEGORIES,
  RECAL_BUDGET_MAX_USD,
  RECAL_BUDGET_MIN_USD,
  RECAL_NIGHTLY_TOP_N,
} from '../config/constants.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { projectRun } from '../run/dry-run.js';
import { MODEL_PRICES } from '../run/ledger.js';
import type { CostLedger, PhaseCost, PhaseName } from '../run/types.js';
import type { Jury, Persona, Product } from '../types.js';

// --- The price table ------------------------------------------------------------

/** One row of the printed price table. USD per million tokens. */
export interface PriceRow {
  model_id: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/** The date `MODEL_PRICES` was last checked against published rates. */
export const PRICE_TABLE_SOURCE_DATE = PRICE_TABLE_DATE;

/**
 * `MODEL_PRICES` as printable rows, sorted by id so the table is stable across
 * runs and a diff of two reports shows a price change rather than a reordering.
 */
export function priceTable(): PriceRow[] {
  return Object.entries(MODEL_PRICES)
    .map(([model_id, prices]) => ({ model_id, ...prices }))
    .sort((a, b) => (a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0));
}

// --- What was actually spent ----------------------------------------------------

/**
 * - `measured` — every call reported a priced model id. `cost_usd` is the cost.
 * - `lower_bound` — some calls did, some did not. `cost_usd` is short by an
 *   unknown amount and must be labelled as a floor.
 * - `unmeasured` — no call reported a priced id, so `cost_usd` is $0 because
 *   nothing could be priced, NOT because nothing was spent. The normal state of
 *   a Task 9 locally-seeded run.
 * - `no_calls` — the run made no model calls at all. Distinct from `unmeasured`:
 *   here $0.00 is the truth.
 */
export type CostBasis = 'measured' | 'lower_bound' | 'unmeasured' | 'no_calls';

/** A run's actual spend, with the honesty of the number attached to it. */
export interface MeasuredCost {
  basis: CostBasis;
  phases: Record<PhaseName, PhaseCost>;
  total: PhaseCost;
  /** Model ids seen with no entry in `MODEL_PRICES`. */
  unpriced_models: string[];
  /** One sentence a report can print verbatim beside the dollar figure. */
  note: string;
}

/**
 * Classify a run's ledger.
 *
 * `unmeasured` is decided by "every call was unpriced", which is checked as
 * `unpriced_models` being non-empty while `cost_usd` is exactly 0. A run that
 * mixed a priced and an unpriced model would have a non-zero cost and lands in
 * `lower_bound`, which is the weaker and therefore safer claim.
 */
export function measuredCost(ledger: CostLedger): MeasuredCost {
  const { total } = ledger;
  const unpriced = [...total.unpriced_models];

  const basis: CostBasis =
    total.calls === 0 ? 'no_calls' :
    unpriced.length === 0 ? 'measured' :
    total.cost_usd === 0 ? 'unmeasured' :
    'lower_bound';

  const note =
    basis === 'measured'
      ? 'MEASURED — every call reported a priced model id; this is the cost.'
      : basis === 'no_calls'
        ? 'No model calls were made in this run, so $0.00 is the whole story. ' +
          'A resumed run reads its phases off disk and spends nothing; the spend is in the run that produced them.'
        : basis === 'unmeasured'
          ? 'UNMEASURED — not $0.00. No call reported a model id this engine has a price for ' +
            `(${unpriced.map((id) => JSON.stringify(id)).join(', ')}), so every token was booked at zero. ` +
            'A locally-seeded run (Task 9) is unmeasurable by construction: Claude Code subagents ' +
            'do not report a priced model id. Per-run cost must be re-baselined once a key exists.'
          : 'LOWER BOUND, not a total — some calls reported a model id with no price ' +
            `(${unpriced.map((id) => JSON.stringify(id)).join(', ')}) and their tokens were booked at $0.`;

  return { basis, phases: ledger.phases, total, unpriced_models: unpriced, note };
}

// --- The recalibration schedule -------------------------------------------------

/** One kind of recalibration pass, projected. Every figure is an ESTIMATE. */
export interface PassProjection {
  label: string;
  products: number;
  chunks: number;
  calls: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  /**
   * The Score phase alone — the LOWER bound on a recalibration pass.
   *
   * `brief §1.5` establishes only that a routine pass cannot RE-CLUSTER: full
   * re-clustering is an explicit admin operation that clears demand. It says
   * nothing about re-polling the customer panel over clusters whose membership
   * did not move, which shifts no membership and clears no demand — so
   * Score + Customer is a real third reading, and `DECISIONS.md` S7 records
   * exactly that question ("Does nightly recalibration re-run the Floor?") as
   * still OPEN. See `customer_cost_usd`.
   */
  score_only_cost_usd: number;
  /**
   * The Customer phase alone, so the intermediate Score + Customer reading can
   * be read off the table rather than inferred. That reading is arguably the
   * likeliest of the three and is bracketed by the other two columns.
   */
  customer_cost_usd: number;
  /** Score + Uniqueness + Customer. The ceiling, if a pass rebuilt everything. */
  full_pipeline_cost_usd: number;
}

/** The whole monthly schedule, against `brief` Part 7's line. */
export interface RecalibrationSchedule {
  categories: number;
  /** `DAYS_PER_YEAR / MONTHS_PER_YEAR` — 30.4167, not a rounded 30. */
  nights_per_month: number;
  /** `nights_per_month / DAYS_PER_WEEK` — 4.3452, not a rounded 4. */
  weeks_per_month: number;
  nightly: PassProjection;
  weekly: PassProjection;
  /** Per category, per month, Score phase only. */
  monthly_score_only_per_category_usd: number;
  /** Per category, per month, Score + Customer — the S7 intermediate reading. */
  monthly_score_and_customer_per_category_usd: number;
  /** Per category, per month, whole pipeline. */
  monthly_full_pipeline_per_category_usd: number;
  /** Across `categories`. The figure `brief` Part 7's line is about. */
  monthly_score_only_usd: number;
  /** Across `categories`, Score + Customer. Bracketed by the other two. */
  monthly_score_and_customer_usd: number;
  monthly_full_pipeline_usd: number;
  budget: {
    min_usd: number;
    max_usd: number;
    /** Categories the brief's figure was stated over. */
    stated_categories: number;
  };
  /** `monthly_score_only_usd / budget.max_usd`. Above 1 means over the ceiling. */
  score_only_vs_budget_max: number;
  score_and_customer_vs_budget_max: number;
  full_pipeline_vs_budget_max: number;
  score_only_within_budget: boolean;
  score_and_customer_within_budget: boolean;
  full_pipeline_within_budget: boolean;
  /**
   * True when EVERY reading is inside the ceiling, and false when every reading
   * is outside it — the verdict that does not depend on `DECISIONS.md` S7 being
   * resolved. When the readings disagree, the answer genuinely turns on S7 and
   * the report has to say so rather than pick one.
   */
  verdict_survives_s7: boolean;
  /**
   * The inputs the token estimate is driven by, printed so a reader can judge
   * whether the MAGNITUDE transfers to a real category. The composition is
   * verified; the magnitude is only as good as these.
   */
  inputs: ScheduleInputs;
  /** Assumptions the schedule rests on, printed with it. */
  caveats: string[];
}

/** What the projected prompt sizes actually depend on. */
export interface ScheduleInputs {
  products: number;
  metrics: number;
  personas: number;
  jurors: number;
  /** Median product description length in characters — the largest single driver. */
  median_description_chars: number;
  /**
   * `DECISIONS.md` S5's measured median for the real seeded corpus, 141
   * characters. Printed beside `median_description_chars` so a projection run
   * against synthetic fixture text is visibly a projection against synthetic
   * fixture text.
   */
  seeded_corpus_median_chars: number;
}

/**
 * `DECISIONS.md` S5: "Seeded median is 141 chars; paid submissions will use the
 * full 300." The reference point a projection's own description length is
 * printed against.
 */
const SEEDED_CORPUS_MEDIAN_CHARS = 141;

/**
 * Nights in an average month: `365 / 12 = 30.4167`, not a rounded 30.
 *
 * Rounding down here understates a monthly cost by ~1.4% on the nightly line and
 * ~8% on the weekly one, both in the direction that flatters the budget. The
 * whole point of this section is a budget comparison, so the rounding that makes
 * it pass is the rounding not to do.
 */
export const NIGHTS_PER_MONTH = DAYS_PER_YEAR / MONTHS_PER_YEAR;

/** Weeks in an average month: `365 / 12 / 7 = 4.3452`, not a rounded 4. */
export const WEEKS_PER_MONTH = NIGHTS_PER_MONTH / DAYS_PER_WEEK;

/**
 * The schedule composition itself: `categories x (nights x nightly + weeks x weekly)`.
 *
 * Exported and separate from `projectSchedule` so the arithmetic can be checked
 * against a hand-computed expectation without going through a token estimate. It
 * is the line the last report got wrong — comparing ONE pass of ONE category
 * against a monthly, all-category budget — so it is the line that most deserves a
 * test of its own.
 */
export function monthlySpend(nightlyPass: number, weeklyPass: number, categories: number): number {
  return categories * (NIGHTS_PER_MONTH * nightlyPass + WEEKS_PER_MONTH * weeklyPass);
}

export interface ScheduleInput {
  category: string;
  /** Every product in the category — the weekly full-board pass. */
  products: readonly Product[];
  /**
   * The nightly pass's products. Defaults to the first `RECAL_NIGHTLY_TOP_N` of
   * `products`; the report passes the actual top 20 of the board, since that is
   * what `brief` Part 3 means and their descriptions are what get rendered.
   */
  nightlyProducts?: readonly Product[];
  jury: Jury;
  personas: readonly Persona[];
  ordering: PanelOrdering;
  /** Categories the schedule runs over. Defaults to the measured `CATEGORY_COUNT`. */
  categories?: number;
  chunkSize?: number;
}

/**
 * Compose the real schedule: `brief` Part 3's "top 20 per category nightly, full
 * board weekly", over every category, for one month — and compare THAT against
 * `brief` Part 7's $17-25 line.
 *
 * A single pass of a single category is not the comparison. Task 7's dry run
 * projects one pass and its report compared that against the monthly budget,
 * which it necessarily fits; the number the budget is about is this one.
 *
 * ## Which phases a pass runs is NOT settled
 *
 * `brief` Part 3 does not say. `brief §1.5` settles exactly one half of it:
 * clusters are append-only and full re-clustering is an explicit admin operation
 * that clears demand, so a routine pass cannot RE-CLUSTER. It does not settle
 * whether the pass re-polls the Floor — re-asking the customer panel about
 * clusters whose membership did not move shifts no membership and clears no
 * demand — and `DECISIONS.md` S7 records that question as still OPEN.
 *
 * So there are three readings, not two, and this projection reports the phases
 * separately so all three can be read off one table:
 *
 *   Score only              lower bound
 *   Score + Customer        the intermediate reading S7 leaves open, arguably
 *                           the likeliest, bracketed by the other two
 *   Score + Uniqueness + Customer   ceiling, if a pass rebuilt everything
 *
 * A budget verdict that holds across all three does not depend on S7 being
 * resolved. One that held only at the lower bound would, and the report would
 * have to say so.
 *
 * ## Where a night and a week collide
 *
 * The weekly full board falls on a night that also has a top-20 pass due. This
 * counts both, which slightly OVERSTATES the total — by about 4.35 nightly passes
 * a month. Overstating is the right direction for a budget check, and it is in
 * `caveats` rather than in a comment.
 */
export function projectSchedule(input: ScheduleInput): RecalibrationSchedule {
  const categories = input.categories ?? CATEGORY_COUNT;
  const nightlyProducts = input.nightlyProducts ?? input.products.slice(0, RECAL_NIGHTLY_TOP_N);

  const pass = (label: string, products: readonly Product[]): PassProjection => {
    const projection = projectRun({
      category: input.category,
      products,
      jury: input.jury,
      personas: input.personas,
      ordering: input.ordering,
      ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
    });
    const phaseCost = (name: PhaseName): number =>
      projection.phases.find((phase) => phase.phase === name)?.estimated_cost_usd ?? 0;
    return {
      label,
      products: products.length,
      chunks: projection.chunks,
      calls: projection.calls,
      estimated_input_tokens: projection.estimated_input_tokens,
      estimated_output_tokens: projection.estimated_output_tokens,
      score_only_cost_usd: phaseCost('score'),
      customer_cost_usd: phaseCost('customer'),
      full_pipeline_cost_usd: projection.estimated_cost_usd,
    };
  };

  const nightly = pass(`nightly top-${RECAL_NIGHTLY_TOP_N}`, nightlyProducts);
  const weekly = pass('weekly full board', input.products);

  const nightsPerMonth = NIGHTS_PER_MONTH;
  const weeksPerMonth = WEEKS_PER_MONTH;

  // Three readings, because `DECISIONS.md` S7 leaves the middle one open.
  const scoreAndCustomer = (pass: PassProjection): number =>
    pass.score_only_cost_usd + pass.customer_cost_usd;

  const perCategoryScoreOnly = monthlySpend(nightly.score_only_cost_usd, weekly.score_only_cost_usd, 1);
  const perCategoryBoth = monthlySpend(scoreAndCustomer(nightly), scoreAndCustomer(weekly), 1);
  const perCategoryFull = monthlySpend(nightly.full_pipeline_cost_usd, weekly.full_pipeline_cost_usd, 1);

  const monthlyScoreOnly = monthlySpend(nightly.score_only_cost_usd, weekly.score_only_cost_usd, categories);
  const monthlyBoth = monthlySpend(scoreAndCustomer(nightly), scoreAndCustomer(weekly), categories);
  const monthlyFull = monthlySpend(nightly.full_pipeline_cost_usd, weekly.full_pipeline_cost_usd, categories);

  const within = (monthly: number): boolean => monthly <= RECAL_BUDGET_MAX_USD;
  const readings = [monthlyScoreOnly, monthlyBoth, monthlyFull];

  return {
    categories,
    nights_per_month: nightsPerMonth,
    weeks_per_month: weeksPerMonth,
    nightly,
    weekly,
    monthly_score_only_per_category_usd: perCategoryScoreOnly,
    monthly_score_and_customer_per_category_usd: perCategoryBoth,
    monthly_full_pipeline_per_category_usd: perCategoryFull,
    monthly_score_only_usd: monthlyScoreOnly,
    monthly_score_and_customer_usd: monthlyBoth,
    monthly_full_pipeline_usd: monthlyFull,
    budget: {
      min_usd: RECAL_BUDGET_MIN_USD,
      max_usd: RECAL_BUDGET_MAX_USD,
      stated_categories: RECAL_BUDGET_CATEGORIES,
    },
    score_only_vs_budget_max: monthlyScoreOnly / RECAL_BUDGET_MAX_USD,
    score_and_customer_vs_budget_max: monthlyBoth / RECAL_BUDGET_MAX_USD,
    full_pipeline_vs_budget_max: monthlyFull / RECAL_BUDGET_MAX_USD,
    score_only_within_budget: within(monthlyScoreOnly),
    score_and_customer_within_budget: within(monthlyBoth),
    full_pipeline_within_budget: within(monthlyFull),
    verdict_survives_s7: readings.every(within) || readings.every((monthly) => !within(monthly)),
    inputs: {
      products: input.products.length,
      metrics: input.jury.metrics.length,
      personas: input.personas.length,
      jurors: input.jury.jurors.length,
      median_description_chars: medianDescriptionChars(input.products),
      seeded_corpus_median_chars: SEEDED_CORPUS_MEDIAN_CHARS,
    },
    caveats: [
      `every figure here is ESTIMATED, never measured: input tokens are counted off the rendered ` +
        `bytes of requests that were never sent, output tokens come from the MAX_TOKENS_* worst cases`,
      `one category's pass cost is multiplied by ${categories} categories. Category sizes differ, so the ` +
        `error in this line is the spread of products per category, not the error in one projection`,
      `the weekly full board falls on a night that also has a top-${RECAL_NIGHTLY_TOP_N} pass due; ` +
        `both are counted, which overstates the total by about ${weeksPerMonth.toFixed(2)} nightly passes a month`,
      `brief Part 7's $${RECAL_BUDGET_MIN_USD}-${RECAL_BUDGET_MAX_USD} was stated over ` +
        `${RECAL_BUDGET_CATEGORIES} categories (brief Part 3); the data has ${CATEGORY_COUNT}, and the ` +
        `panel is ${input.jury.jurors.length} jurors where 01 §4 assumed 5 (DECISIONS.md S1)`,
      'a cold prompt cache is assumed throughout — a real pass reads the shared juror prefix from ' +
        'cache and costs less, so this errs high',
      `which phases a pass runs is NOT settled: brief §1.5 establishes only that it cannot re-cluster. ` +
        `DECISIONS.md S7 ("Does nightly recalibration re-run the Floor?") is OPEN, and Score + Customer ` +
        `is a real third reading between the two bounds`,
      `the MAGNITUDE is only as good as the inputs it was rendered from — ${input.products.length} ` +
        `products at a ${medianDescriptionChars(input.products)}-character median description, ` +
        `${input.jury.metrics.length} metrics, ${input.personas.length} personas. DECISIONS.md S5 puts the ` +
        `real seeded median at ${SEEDED_CORPUS_MEDIAN_CHARS} characters; what has been verified here is the ` +
        `COMPOSITION of the schedule, not its magnitude`,
    ],
  };
}

/** Median description length, the largest single driver of a projected prompt size. */
function medianDescriptionChars(products: readonly Product[]): number {
  if (products.length === 0) return 0;
  const lengths = products.map((product) => product.description.length).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  if (lengths.length % 2 === 1) return lengths[middle] ?? 0;
  return ((lengths[middle - 1] ?? 0) + (lengths[middle] ?? 0)) / 2;
}
