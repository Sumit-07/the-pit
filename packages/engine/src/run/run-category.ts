/**
 * `runCategory` — the orchestrator. `01 §2`'s phase graph, `01 §4` Steps 4-6.
 *
 *   Round 1 (parallel):  Score  ||  Uniqueness      both read only the products
 *   Round 2:             Customer                    needs Round 1's clusters
 *
 * Then `rankCategory` — pure TypeScript over the stored raw rows — turns those
 * votes into `ranking.json`. No model call ever produces or sees a rank (Global
 * Constraint 1); the panels return scores, cluster assignments and picks, and
 * every ordering operation happens here, afterwards, offline.
 *
 * ## The delivery decision
 *
 * `isDeliverable` reads the three `PhaseResult` unions and NOTHING else. It never
 * inspects the ranking to work out whether the run was whole. That temptation is
 * real and specific: a category whose clustering call failed produces a board on
 * which every row reads `cluster.id === 'unclustered'` and `demand_status:
 * 'solo_cluster'`, which is byte-identical to a category of genuinely unique
 * products — a correct, deliverable run under `DECISIONS.md` S11. Deciding
 * deliver-vs-retry by string-matching a fallback cluster id, on the path that
 * charges a customer, would refund good runs and charge for broken ones with
 * equal confidence. The phase that made the call is the only thing that knows,
 * and it says so in its own result.
 *
 * ## Persistence
 *
 * Each phase result is written the moment it lands (`store.writePhase`), never
 * batch-committed at the end. `brief §2.3` retries only the failed phase and
 * `brief` Part 7 makes each phase one Inngest step; both are only true if a
 * completed phase survives a later phase failing. `resume: true` reads those
 * files back, so a retry re-buys nothing that already succeeded.
 *
 * ## What this does NOT do
 *
 * It does not generate or approve a jury or a persona panel. `01 §4` Steps 2 and
 * 3 are human approval gates, and Task 6's prompt builders return TEXT for a
 * person to dispatch, not dispatchable requests. `runCategory` is handed panels
 * that are already installed and already validated, and it refuses to run without
 * them.
 */

import { ENGINE_VERSION, JUROR_COUNT } from '../config/constants.js';
import type { ModelClient } from '../model/types.js';
import type { CalibrationSample } from '../panels/calibration.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { rankCategory } from '../rank/ranking.js';
import type { FlaggedInjection, Jury, PersonaPanel, Product, Ranking } from '../types.js';
import { buildLedger, zeroCost } from './ledger.js';
import { runCustomerPhase } from './phases/customer.js';
import { runScorePhase } from './phases/score.js';
import { runUniquenessPhase } from './phases/uniqueness.js';
import type { RunStore } from './store.js';
import { MemoryRunStore } from './store.js';
import type {
  CustomerPhaseValue,
  PersistedPhase,
  PhaseCost,
  PhaseFailure,
  PhaseName,
  PhaseResult,
  PhaseSummary,
  PhaseVersions,
  RunMeta,
  RunOutcome,
  RunResults,
  RunSeeding,
  ScoreCoverage,
  ScorePhaseValue,
  UniquenessPhaseValue,
} from './types.js';

/** The `cfg` of `01 §7.2`, as this engine needs it. */
export interface RunConfig {
  /** The category snapshot version. Seeds the render order and the calibration sample. */
  categoryVersion: string;
  /**
   * Identifies the clustering output. Defaults to `categoryVersion`: clusters are
   * append-only (`brief §1.5`) and are rebuilt when the snapshot is, so the
   * snapshot version is what invalidates them.
   */
  uniquenessVersion?: string;
  /**
   * Identifies the demand output. Defaults to the installed panel's
   * `persona_version`, which `01 §4` Step 3 says invalidates cached demand.
   */
  demandVersion?: string;
  /** Max products per scoring call. Defaults to `CHUNK_SIZE`. */
  chunkSize?: number;
  /** Reuse phase results already on disk instead of re-buying them. `brief §2.3`. */
  resume?: boolean;
  /** Peers embedded as pre-scored reference. Only the incremental path sets this. */
  calibration?: CalibrationSample;
  /**
   * How this run's votes are being produced. Set by the locally-seeded path
   * (Task 9's `HandoffClient`); omitted on the Messages API path, where a run
   * with no stamp is the priced path by construction.
   *
   * Stamped into `meta.seeding` AND repeated at the head of `meta.warnings`, so
   * the caveat reaches the report, which carries warnings through verbatim.
   */
  seeding?: RunSeeding;
}

export interface RunCategoryInput {
  category: string;
  products: readonly Product[];
  /** An INSTALLED jury, past `01 §4` Step 2's approval gate and `validateJury`. */
  jury: Jury;
  /** An INSTALLED persona panel, past `01 §4` Step 3's gate and `validatePersonas`. */
  personas: PersonaPanel;
  client: ModelClient;
  config: RunConfig;
  /** Where artifacts land. Defaults to an in-memory store, which spends nothing and writes nothing. */
  store?: RunStore;
}

/** Run one category end to end. */
export async function runCategory(input: RunCategoryInput): Promise<RunOutcome> {
  if (input.products.length === 0) throw new RangeError('runCategory: no products');
  if (input.jury.jurors.length === 0) throw new RangeError('runCategory: the installed jury has no jurors');
  if (input.jury.metrics.length === 0) throw new RangeError('runCategory: the installed rubric has no metrics');

  const store = input.store ?? new MemoryRunStore(input.category);
  const ordering: PanelOrdering = { category: input.category, categoryVersion: input.config.categoryVersion };
  const resume = input.config.resume === true;
  const versions = phaseVersions(input);
  const resumeWarnings: string[] = [];

  // --- Round 1: Score || Uniqueness ------------------------------------------
  // Both read only the products, so `01 §2` runs them together. Each is persisted
  // by its own `then`, the moment it lands — not after both settle, or a slow
  // clustering pass would hold six finished juror calls unwritten.
  const [score, uniqueness] = await Promise.all([
    resumePhase<ScorePhaseValue>(store, 'score', resume, versions, resumeWarnings).then(
      async (cached) =>
        cached ??
        (await persist(
          store,
          versions,
          runScorePhase({
            client: input.client,
            products: input.products,
            jury: input.jury,
            ordering,
            ...(input.config.calibration === undefined ? {} : { calibration: input.config.calibration }),
            ...(input.config.chunkSize === undefined ? {} : { chunkSize: input.config.chunkSize }),
          }),
        )),
    ),
    resumePhase<UniquenessPhaseValue>(store, 'uniqueness', resume, versions, resumeWarnings).then(
      async (cached) =>
        cached ??
        (await persist(
          store,
          versions,
          runUniquenessPhase({ client: input.client, products: input.products, ordering }),
        )),
    ),
  ]);

  // --- Round 2: Customer ------------------------------------------------------
  // Depends on Round 1's clusters, so it cannot start earlier and must not start
  // at all if they never arrived: with no clusters there are no sets, and running
  // it anyway would return `skipped: 'no_sets'` — S11's SUCCESSFUL status — for a
  // run that actually failed. `notRun` is a third thing: neither success nor a
  // failure of its own.
  const customer: PhaseResult<CustomerPhaseValue> =
    uniqueness.status === 'ok'
      ? ((await resumePhase<CustomerPhaseValue>(store, 'customer', resume, versions, resumeWarnings)) ??
        (await persist(
          store,
          versions,
          runCustomerPhase({
            client: input.client,
            products: input.products,
            personas: input.personas.personas,
            uniqueness: uniqueness.value.uniqueness,
            ordering,
          }),
        )))
      : notRun();

  // --- Assemble ---------------------------------------------------------------
  const results = assembleResults({
    category: input.category,
    slug: store.slug,
    config: input.config,
    jury: input.jury,
    personas: input.personas,
    score,
    uniqueness,
    customer,
    extraWarnings: resumeWarnings,
  });

  await store.writeResults(results);

  const failures = collectFailures([score, uniqueness, customer]);
  if (failures.length > 0) {
    return {
      status: 'failed',
      // Free only if EVERY failure is retryable. One terminal failure means the
      // run cannot come out differently, so it belongs in the support queue
      // rather than in a retry loop (`brief §2.3`).
      retryable: failures.every((failure) => failure.retryable),
      failures,
      results,
    };
  }

  const ranking = buildRanking(input, results, score, uniqueness, customer);
  await store.writeRanking(ranking);

  return { status: 'delivered', results, ranking };
}

/**
 * Whether the three phases together constitute a delivery.
 *
 * Reads the phase unions only. A `skipped` Customer phase is a delivery
 * (`DECISIONS.md` S11); a `failed` one is not (`brief §2.3`). Exported because
 * that one line is the whole money path and deserves to be tested directly.
 */
export function isDeliverable(
  score: PhaseResult<ScorePhaseValue>,
  uniqueness: PhaseResult<UniquenessPhaseValue>,
  customer: PhaseResult<CustomerPhaseValue>,
): boolean {
  return score.status === 'ok' && uniqueness.status === 'ok' && customer.status !== 'failed';
}

/** The versions a phase run right now would be produced under. */
export function phaseVersions(input: {
  config: RunConfig;
  jury: Jury;
  personas: PersonaPanel;
}): PhaseVersions {
  return {
    category_version: input.config.categoryVersion,
    prompt_version: input.jury.prompt_version,
    persona_version: input.personas.persona_version,
    engine_version: ENGINE_VERSION,
  };
}

/**
 * Persist a phase result the instant it resolves, then hand it on unchanged.
 *
 * Written as a version-stamped envelope: the file path carries only the slug
 * (`cjr/runs/<slug>/phases/<phase>.json`), so the only place the versions can
 * live is inside the file.
 */
async function persist<T>(
  store: RunStore,
  versions: PhaseVersions,
  running: Promise<PhaseResult<T>>,
): Promise<PhaseResult<T>> {
  const result = await running;
  const envelope: PersistedPhase<T> = { versions, result };
  await store.writePhase(result.phase, envelope);
  return result;
}

/**
 * A previously persisted phase result, if resuming, if it succeeded, AND if it
 * was produced under the versions this run is using.
 *
 * A persisted FAILURE is deliberately not reused: `brief §2.3` retries the failed
 * phase, so reading one back would make the retry a no-op that re-reports the
 * original failure forever.
 *
 * A persisted result from DIFFERENT VERSIONS is refused for a sharper reason.
 * The phase path carries only the slug, so without this check the sequence
 * "transient failure -> edit the installed jury and bump `prompt_version` as
 * `01 §4` Step 2 instructs -> re-run with --resume" reads the old Score phase
 * straight off disk and delivers it, while `meta.prompt_version` is stamped with
 * the NEW version. The board would then claim scores from a rubric that never
 * produced them — exactly what `01 §9` rule 5 and `brief §1.3` exist to prevent.
 * It would also break this task's own `orderedChunks` guarantee, because the
 * ordering seed is `(slug, categoryVersion)`: resumed chunks would no longer be
 * the composition the current version produces.
 *
 * A mismatch is not silent. It re-runs the phase and records a warning naming
 * the version that moved, so the extra spend has a stated reason.
 */
async function resumePhase<T>(
  store: RunStore,
  phase: PhaseName,
  resume: boolean,
  versions: PhaseVersions,
  warnings: string[],
): Promise<PhaseResult<T> | undefined> {
  if (!resume) return undefined;

  const stored = await store.readPhase(phase);
  if (stored === null || typeof stored !== 'object') return undefined;

  const envelope = stored as Partial<PersistedPhase<T>>;
  const result = envelope.result;
  if (result === null || typeof result !== 'object') {
    warnings.push(`resume: the stored ${phase} phase is not a version-stamped result; re-running it`);
    return undefined;
  }
  if (result.phase !== phase) return undefined;
  if (result.status !== 'ok' && result.status !== 'skipped') return undefined;

  const moved = versionsMoved(envelope.versions, versions);
  if (moved.length > 0) {
    warnings.push(
      `resume: refused the stored ${phase} phase because ${moved.join(' and ')}. ` +
        'A phase produced under different versions is a stale answer, not a saving — it would be ' +
        'delivered under this run’s version stamps (01 §9 rule 5, brief §1.3). Re-running it.',
    );
    return undefined;
  }

  return result;
}

/**
 * Which of the four versions differ, named for a human.
 *
 * The version predicate `resumePhase` decides on, exported because it is decided
 * in more than one process. A durable executor runs each phase as its own step,
 * so it has to ask "is this phase already bought under these versions?" at every
 * step boundary rather than once inside `runCategory`; a status page has to ask
 * the same question about the same envelopes to avoid showing a stale phase as
 * progress. The whole point of version-stamped phases is that a stale phase is
 * never delivered as fresh, and a second copy of that rule — however carefully
 * written — is a place where the two can quietly disagree and a phase the caller
 * called reusable gets re-bought inside a step that is supposed to spend nothing.
 *
 * Field by field rather than a whole-object comparison: "the category snapshot
 * moved" and "the engine was rebuilt" are different explanations for the same
 * re-spend, and a support answer needs the right one. An empty result means the
 * stamp matches and the stored phase may be reused; `undefined` means no stamp at
 * all, which is refused for the same reason.
 */
export function versionsMoved(stored: PhaseVersions | undefined, current: PhaseVersions): string[] {
  if (stored === undefined) return ['it carries no version stamp'];

  const keys: (keyof PhaseVersions)[] = ['category_version', 'prompt_version', 'persona_version', 'engine_version'];
  return keys
    .filter((key) => stored[key] !== current[key])
    .map((key) => `${key} moved from ${JSON.stringify(stored[key])} to ${JSON.stringify(current[key])}`);
}

/**
 * The Customer phase's "never got the chance" state.
 *
 * Recorded as a failure so it can never be mistaken for S11's skip, and marked
 * retryable with no causes of its own — the real cause is Uniqueness's failure,
 * which is reported separately and would only be duplicated by restating it.
 */
function notRun(): PhaseResult<CustomerPhaseValue> {
  return {
    phase: 'customer',
    status: 'failed',
    cost: zeroCost(),
    warnings: [],
    failure: {
      code: 'incomplete_panel',
      retryable: true,
      message: 'customer panel did not run: the clustering pass it depends on failed, so there were no sets to show',
      causes: [],
    },
  };
}

interface AssembleInput {
  category: string;
  slug: string;
  config: RunConfig;
  jury: Jury;
  personas: PersonaPanel;
  score: PhaseResult<ScorePhaseValue>;
  uniqueness: PhaseResult<UniquenessPhaseValue>;
  customer: PhaseResult<CustomerPhaseValue>;
  /** Warnings raised outside any one phase — a refused resume, for instance. */
  extraWarnings: readonly string[];
}

/**
 * `cjr/runs/<slug>/results.json` — `01 §4` Step 5's
 * `{scoreLog, uniqueness, demand, flaggedInjections, meta}`.
 *
 * Written on a FAILED run too, with `meta.outcome: 'failed'`, so a retry has
 * something to read and a support queue has something to look at.
 *
 * A failed phase contributes NO votes: `scoreLog` is empty when the merit panel
 * failed, `uniqueness` is null when the clustering pass did, `demand` is null
 * when the Floor did. `results.scoreLog` is the field `rankCategory` reads, so a
 * five-juror log sitting in it is a degraded verdict waiting for someone to
 * recompute a board offline — `brief §2.3` forbids delivering one, and the
 * cheapest way to keep that true is for one never to exist. What a failed run
 * keeps instead is the DIAGNOSIS: `meta.phases[...].failure` with its causes, and
 * `meta.coverage` naming every juror that did not answer.
 */
function assembleResults(input: AssembleInput): RunResults {
  const uniquenessVersion = input.config.uniquenessVersion ?? input.config.categoryVersion;
  const demandVersion = input.config.demandVersion ?? input.personas.persona_version;

  const scoreValue = input.score.status === 'ok' ? input.score.value : undefined;
  const uniquenessValue = input.uniqueness.status === 'ok' ? input.uniqueness.value : undefined;
  const customerValue = input.customer.status === 'ok' ? input.customer.value : undefined;

  const phases: Record<PhaseName, PhaseSummary> = {
    score: summarize(input.score),
    uniqueness: summarize(input.uniqueness),
    customer: summarize(input.customer),
  };

  const costs: Record<PhaseName, PhaseCost> = {
    score: input.score.cost,
    uniqueness: input.uniqueness.cost,
    customer: input.customer.cost,
  };

  const flaggedInjections: FlaggedInjection[] = [
    ...(scoreValue?.flaggedInjections ?? []),
    ...(uniquenessValue?.flaggedInjections ?? []),
    ...(customerValue?.flaggedInjections ?? []),
  ];

  const meta: RunMeta = {
    category: input.category,
    slug: input.slug,
    category_version: input.config.categoryVersion,
    prompt_version: input.jury.prompt_version,
    persona_version: input.personas.persona_version,
    uniqueness_version: uniquenessVersion,
    outcome: isDeliverable(input.score, input.uniqueness, input.customer) ? 'delivered' : 'failed',
    phases,
    ledger: buildLedger(costs),
    // The failure arm carries a coverage audit too (see `PhaseFailure.coverage`),
    // so `meta.coverage` names the missing jurors on a failed run as well as on a
    // clean one — which is the run where it matters most.
    coverage:
      scoreValue?.coverage ??
      (input.score.status === 'failed' ? input.score.failure.coverage : undefined) ??
      emptyCoverage(input.jury.jurors.length),
    warnings: [
      // First, deliberately. A reader who stops after one line should have read
      // the one that says these numbers did not come from the priced path.
      ...(input.config.seeding === undefined ? [] : [input.config.seeding.caveat]),
      ...input.extraWarnings,
      ...input.score.warnings,
      ...input.uniqueness.warnings,
      ...input.customer.warnings,
      ...unpricedWarning(buildLedger(costs).total.unpriced_models),
    ],
    engine_version: ENGINE_VERSION,
    ...(input.config.seeding === undefined ? {} : { seeding: input.config.seeding }),
  };

  return {
    scoreLog: scoreValue?.scoreLog ?? [],
    uniqueness:
      uniquenessValue === undefined
        ? null
        : { ...uniquenessValue.uniqueness, uniqueness_version: uniquenessVersion },
    demand:
      customerValue === undefined
        ? null
        : {
            personas: [...input.personas.personas],
            demandLog: customerValue.demandLog,
            demand_version: demandVersion,
          },
    flaggedInjections,
    meta,
  };
}

/** Strip a phase result down to what `meta` carries: outcome and cost, no votes. */
function summarize<T>(result: PhaseResult<T>): PhaseSummary {
  const base = { status: result.status, cost: result.cost, warnings: result.warnings };
  if (result.status === 'skipped') return { ...base, status: 'skipped', skipped: result.skipped };
  if (result.status === 'failed') return { ...base, status: 'failed', failure: result.failure };
  return { ...base, status: 'ok' };
}

/** Coverage for a run whose Score phase produced nothing at all. */
function emptyCoverage(expected: number): ScoreCoverage {
  return {
    complete: false,
    missing_roles: [],
    substituted: [],
    jurors_answered: 0,
    jurors_expected: expected === 0 ? JUROR_COUNT : expected,
  };
}

/**
 * A cost total that is short, said out loud.
 *
 * `callCost` books an unrecognised model id at $0 so a paid run is never lost to
 * a bookkeeping gap. Left there, the run would report `$0.0000` and Task 8's
 * report would print it as the Phase 1 cost picture. Task 9's handoff adapter
 * cannot report a priced id at all, so this is the normal case for every
 * locally-seeded run, not an edge one.
 */
function unpricedWarning(models: readonly string[]): string[] {
  if (models.length === 0) return [];
  return [
    `cost is UNDERSTATED: no price is known for model id(s) ${models.map((m) => JSON.stringify(m)).join(', ')}, ` +
      'so their tokens were booked at $0. Treat this run’s cost_usd as a lower bound, not a total.',
  ];
}

function collectFailures(phases: readonly PhaseResult<unknown>[]): PhaseFailure[] {
  return phases.flatMap((phase) => (phase.status === 'failed' ? [phase.failure] : []));
}

/**
 * `ranking.json` — `01 §6.6`. Pure arithmetic over what is already stored, so it
 * can be recomputed offline from `results.json` at any time without a model, a
 * key, or a network (`01 §2`).
 */
function buildRanking(
  input: RunCategoryInput,
  results: RunResults,
  score: PhaseResult<ScorePhaseValue>,
  uniqueness: PhaseResult<UniquenessPhaseValue>,
  customer: PhaseResult<CustomerPhaseValue>,
): Ranking {
  // Unreachable unless `isDeliverable` and this function disagree; checked
  // because the alternative is publishing a board built from nothing.
  if (score.status !== 'ok' || uniqueness.status !== 'ok') {
    throw new Error('runCategory: cannot rank a run whose Score or Uniqueness phase did not succeed');
  }

  return rankCategory({
    category: input.category,
    type: input.jury.type,
    prompt_version: input.jury.prompt_version,
    uniqueness_version: results.meta.uniqueness_version,
    demand_version: results.demand?.demand_version ?? input.personas.persona_version,
    products: input.products,
    metrics: input.jury.metrics.map((metric) => ({ name: metric.name, description: metric.description })),
    jury: input.jury.jurors,
    personas: input.personas.personas,
    scoreLog: score.value.scoreLog,
    uniqueness: uniqueness.value.uniqueness,
    demandLog: customer.status === 'ok' ? customer.value.demandLog : null,
    flaggedInjections: results.flaggedInjections,
  });
}
