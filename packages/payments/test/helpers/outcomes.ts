/**
 * Hand-built pipeline outcomes.
 *
 * Written out rather than produced by running the engine. The engine is what
 * these tests are checking the money rules AGAINST; generating the fixtures from
 * it would mean a change in engine behaviour silently changed the expectations
 * as well, and the tests would keep passing while the rule they encode quietly
 * moved. Every field below was chosen to encode one specific situation from
 * `brief §2.3`, and the situations are named in the exported function names.
 */

import type {
  CostLedger,
  PhaseCost,
  PhaseFailure,
  PhaseName,
  PhaseSummary,
  Ranking,
  RunMeta,
  RunOutcome,
  RunResults,
  ScoreCoverage,
} from '@the-pit/engine';

const ZERO_COST: PhaseCost = {
  calls: 0,
  failed_calls: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  cost_usd: 0,
  unpriced_models: [],
};

const COMPLETE_COVERAGE: ScoreCoverage = {
  complete: true,
  missing_roles: [],
  substituted: [],
  jurors_answered: 6,
  jurors_expected: 6,
};

const LEDGER: CostLedger = {
  phases: { score: ZERO_COST, uniqueness: ZERO_COST, customer: ZERO_COST },
  total: ZERO_COST,
};

const EMPTY_RANKING: Ranking = {
  category: 'Developer Tools',
  prompt_version: 'jury-v1',
  uniqueness_version: 'uniq-v1',
  demand_version: 'personas-v1',
  type: 'b2b',
  weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
  personas: [],
  metrics: [],
  clusters: [],
  ranking: [],
  health: { avg_metric_spread: 0, discrimination: 0, demand_discrimination: 0, tiebreak_count: 0 },
  flaggedInjections: [],
};

function summary(status: PhaseSummary['status'], extra: Partial<PhaseSummary> = {}): PhaseSummary {
  return { status, cost: ZERO_COST, warnings: [], ...extra };
}

function meta(
  outcome: RunMeta['outcome'],
  phases: Record<PhaseName, PhaseSummary>,
  coverage: ScoreCoverage = COMPLETE_COVERAGE,
): RunMeta {
  return {
    category: 'Developer Tools',
    slug: 'developer-tools',
    category_version: 'cat-v1',
    prompt_version: 'jury-v1',
    persona_version: 'personas-v1',
    uniqueness_version: 'uniq-v1',
    outcome,
    phases,
    ledger: LEDGER,
    coverage,
    warnings: [],
    engine_version: '0.1.0',
  };
}

function results(phases: Record<PhaseName, PhaseSummary>, coverage?: ScoreCoverage): RunResults {
  return {
    scoreLog: [],
    uniqueness: null,
    demand: null,
    flaggedInjections: [],
    meta: meta(
      Object.values(phases).some((phase) => phase.status === 'failed') ? 'failed' : 'delivered',
      phases,
      coverage,
    ),
  };
}

/** Every phase ran and the Floor convened: the ordinary delivery. */
export function deliveredWithFloor(): RunOutcome {
  return {
    status: 'delivered',
    ranking: EMPTY_RANKING,
    results: results({ score: summary('ok'), uniqueness: summary('ok'), customer: summary('ok') }),
  };
}

/**
 * The Six scored, the clustering pass ran, and the Customer phase found no
 * cluster with two or more members — `DECISIONS.md` S3 and S11's genuine solo
 * cluster. A SUCCESSFUL delivery, and the common case: 32 of 48 Developer Tools
 * products and 26 of 44 Health & Fitness products land here.
 */
export function deliveredSoloCluster(): RunOutcome {
  return {
    status: 'delivered',
    ranking: EMPTY_RANKING,
    results: results({
      score: summary('ok'),
      uniqueness: summary('ok'),
      customer: summary('skipped', { skipped: 'no_sets' }),
    }),
  };
}

const MODEL_CALL_FAILURE: PhaseFailure = {
  code: 'model_call',
  retryable: true,
  message: 'provider timed out',
  causes: ['persona:price-led buyer'],
};

const INTERNAL_FAILURE: PhaseFailure = {
  code: 'internal',
  retryable: false,
  message: 'ranking assembly threw',
  causes: ['assembleResults'],
};

/** A provider timeout in the Customer phase. `brief §2.3`: a free retry. */
export function providerTimeout(): RunOutcome {
  return {
    status: 'failed',
    retryable: true,
    failures: [MODEL_CALL_FAILURE],
    results: results({
      score: summary('ok'),
      uniqueness: summary('ok'),
      customer: summary('failed', { failure: MODEL_CALL_FAILURE }),
    }),
  };
}

/**
 * `brief §2.3`'s partial success, verbatim: "the Six scored but the Floor call
 * failed", so the composite is missing 35% of its weight. A FAILURE. Note that
 * the outcome carries no `ranking` field at all — the engine's union makes the
 * degraded verdict unrepresentable, and this fixture could not be written the
 * other way even on purpose.
 */
export function sixScoredFloorFailed(): RunOutcome {
  return {
    status: 'failed',
    retryable: true,
    failures: [MODEL_CALL_FAILURE],
    results: results({
      score: summary('ok'),
      uniqueness: summary('ok'),
      customer: summary('failed', { failure: MODEL_CALL_FAILURE }),
    }),
  };
}

/** Two phases down. `brief §2.3` retries only the failed ones. */
export function scoreAndCustomerFailed(): RunOutcome {
  return {
    status: 'failed',
    retryable: true,
    failures: [MODEL_CALL_FAILURE, MODEL_CALL_FAILURE],
    results: results(
      {
        score: summary('failed', { failure: MODEL_CALL_FAILURE }),
        uniqueness: summary('ok'),
        customer: summary('failed', { failure: MODEL_CALL_FAILURE }),
      },
      { complete: false, missing_roles: ['throughput critic'], substituted: [], jurors_answered: 5, jurors_expected: 6 },
    ),
  };
}

/** An engine bug. Retrying spends money to reproduce it; goes straight to a human. */
export function internalFailure(): RunOutcome {
  return {
    status: 'failed',
    retryable: false,
    failures: [INTERNAL_FAILURE],
    results: results({
      score: summary('ok'),
      uniqueness: summary('ok'),
      customer: summary('failed', { failure: INTERNAL_FAILURE }),
    }),
  };
}
