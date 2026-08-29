/**
 * `runIncremental` — placing ONE new product into an already-seeded category.
 *
 * This is the `--add-product` path, and it is the path every paid submission
 * takes. `the-pit-build-brief.md` §1.1 is about this function and nothing else:
 *
 * > "In a full run, jurors score up to 40 products in one prompt and spread
 * > deductions across them. In the `--add-product` path they score **one product
 * > alone**, which produces systematically different raw scores. Every paid
 * > submission uses that path, so the bias lands entirely on customers."
 *
 * The fix is `selectCalibrationSample` (Task 4) — `CALIBRATION_SAMPLE` existing
 * products embedded in the scoring prompt with the scores they were already
 * given, as reference, never re-scored. Supplying it is this function's first
 * responsibility, and the reason the sample is not optional here: a run that
 * silently omitted it would produce plausible scores that are biased in a
 * direction nobody can see from the output.
 *
 * ## Four steps
 *
 * 1. **Score** the new product alone, with the calibration sample. Reuses
 *    `runScorePhase` verbatim over a one-product category, so the incremental
 *    path and the full path share their coverage audit, their failure
 *    classification and their injection alarm — the A/B check in Task 8 compares
 *    two paths through the same code, not two implementations.
 * 2. **Place** it in a cluster, append-only (`brief §1.5`): it joins an existing
 *    cluster or opens a new one, and no existing membership moves. Re-clustering
 *    the category would invalidate every stored demand vote.
 * 3. **Re-ask the Floor about the one set that changed.** A persona's forced
 *    choice within a set can change when a new member appears in it, so that set
 *    is re-run for every persona; every OTHER set's votes stand untouched. If the
 *    product opened a cluster of its own, nothing changed for anybody and the
 *    Floor does not convene at all — `01 §5.3`, and a successful outcome under
 *    `DECISIONS.md` S11.
 * 4. **Re-rank** the whole category. `brief §1.2`: appending a product shifts the
 *    population mean and std, so EVERY existing z-score changes. That is correct
 *    behaviour and it is why nothing here may assume rank stability between
 *    placements.
 *
 * ## The input gate
 *
 * `screenInput` (`DECISIONS.md` S9) runs here and only here. It is the
 * hold-vs-serve gate for UNTRUSTED submitted text, and a submission is exactly
 * what it was written for. The seeding path does not screen: those products come
 * from our own catalogue, and holding one would silently change `n` and with it
 * every z-score in the category.
 */

import { SANITIZE_LIMIT } from '../config/constants.js';
import type { ModelClient } from '../model/types.js';
import { selectCalibrationSample } from '../panels/calibration.js';
import { sanitize } from '../ingest/sanitize.js';
import { screenInput } from '../panels/injection.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { buildAssignRequest, validateAssignResult } from '../panels/prompts/assign.js';
import { rankCategory } from '../rank/ranking.js';
import type {
  Cluster,
  ClusterId,
  DemandLogEntry,
  Jury,
  PersonaPanel,
  Product,
  Ranking,
  ScoreLogEntry,
  UniquenessProduct,
  UniquenessResult,
} from '../types.js';
import { dispatch } from './dispatch.js';
import { buildLedger, PhaseLedger, zeroCost } from './ledger.js';
import { runCustomerPhase } from './phases/customer.js';
import { runScorePhase } from './phases/score.js';
import { phaseVersions, type RunConfig } from './run-category.js';
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
  RunResults,
  ScorePhaseValue,
} from './types.js';

export interface IncrementalInput {
  category: string;
  /** The product being placed. Its `id` must not collide with an existing one. */
  product: Product;
  /** The category as it stands, from `products.json`. */
  products: readonly Product[];
  /** The category's current `ranking.json` — the source of the calibration peers' scores. */
  ranking: Ranking;
  /** The category's current `results.json` — the votes being added to. */
  results: RunResults;
  jury: Jury;
  personas: PersonaPanel;
  client: ModelClient;
  config: RunConfig;
  store?: RunStore;
}

/**
 * What a placement produced.
 *
 * `held` is a fourth arm, not a failure: the input gate stopped the text before
 * anything was spent, and per `DECISIONS.md` S9 that is a route-to-a-human
 * decision rather than a retry.
 */
export type IncrementalOutcome =
  | { status: 'held'; matched: string }
  | { status: 'placed'; results: RunResults; ranking: Ranking; assignment: PlacedCluster }
  | { status: 'failed'; retryable: boolean; failures: PhaseFailure[]; results: RunResults };

/** Where the new product ended up. */
export interface PlacedCluster {
  cluster_id: ClusterId;
  label: string;
  /** True when it opened a cluster of its own — no peers, so no demand signal. */
  is_new: boolean;
  /** Members AFTER the placement, the new product included. */
  size: number;
  uniqueness_score: number;
  reason: string;
}

/** Score one new product against its calibrated peers, place it, and re-rank. */
export async function runIncremental(input: IncrementalInput): Promise<IncrementalOutcome> {
  const existingIds = new Set(input.products.map((product) => product.id));
  if (existingIds.has(input.product.id)) {
    throw new RangeError(`runIncremental: product id ${input.product.id} already exists in this category`);
  }
  if (input.results.uniqueness === null) {
    throw new RangeError(
      'runIncremental: this category has no stored clusters, so there is nothing to append to. ' +
        'brief §1.5 makes full re-clustering an explicit admin operation, not a side effect of a placement.',
    );
  }

  // The gate, before anything is spent (`DECISIONS.md` S9).
  const screen = screenInput(`${input.product.name}\n${input.product.description}`);
  if (screen.hold) return { status: 'held', matched: screen.matched ?? '' };

  const store = input.store ?? new MemoryRunStore(input.category);
  const ordering: PanelOrdering = { category: input.category, categoryVersion: input.config.categoryVersion };
  const allProducts = [...input.products, input.product];
  const priorUniqueness = input.results.uniqueness;
  const versions = phaseVersions(input);

  // --- 1. Score, with the calibration sample (`brief §1.1`) -------------------
  const calibration =
    input.config.calibration ??
    selectCalibrationSample(input.products, input.ranking, input.config.categoryVersion);

  const score = await persist(
    store,
    versions,
    runScorePhase({
      client: input.client,
      // Deliberately one product: the whole point of the calibration sample is
      // that it, not a batch, supplies the comparative context.
      products: [input.product],
      jury: input.jury,
      ordering,
      calibration,
    }),
  );

  // --- 2. Place it, append-only (`brief §1.5`) --------------------------------
  const placement =
    score.status === 'ok'
      ? await persist(store, versions, assignCluster(input, priorUniqueness))
      : notRun<Placement>('uniqueness', 'the placement call was not made: the merit panel did not return usable scores');

  const merged =
    placement.status === 'ok'
      ? mergeUniqueness(priorUniqueness, input.product.id, placement.value)
      : priorUniqueness;

  // --- 3. Re-ask the Floor about the one set that changed ---------------------
  const changed = placement.status === 'ok' ? changedCluster(merged, placement.value.cluster_id) : undefined;

  const customer: PhaseResult<CustomerPhaseValue> =
    placement.status !== 'ok'
      ? notRun<CustomerPhaseValue>('customer', 'the customer panel did not run: the product was never placed in a cluster')
      : changed === undefined
        ? // The product opened a cluster of its own, so no set's membership moved
          // and there is nothing to re-ask. `DECISIONS.md` S11: this is a
          // SUCCESSFUL delivery — the same `skipped: 'no_sets'` a full run returns
          // for a category with no multi-member cluster — and emphatically not the
          // `failed` arm above, which is what a placement that never happened gets.
          await persist(store, versions, Promise.resolve(skippedCustomer()))
        : await persist(
            store,
            versions,
            runCustomerPhase({
              client: input.client,
              products: allProducts,
              personas: input.personas.personas,
              // Only the changed cluster. Every other set's votes stand, which is
              // the entire reason clusters are append-only.
              uniqueness: { clusters: [changed], products: merged.products },
              ordering,
            }),
          );

  // --- 4. Assemble and re-rank ------------------------------------------------
  const scoreLog = score.status === 'ok' ? appendScoreLog(input.results.scoreLog, score.value.scoreLog) : input.results.scoreLog;
  const demandLog =
    customer.status === 'ok' && changed !== undefined
      ? mergeDemandLog(input.results.demand?.demandLog ?? [], customer.value.demandLog, changed.cluster_id)
      : (input.results.demand?.demandLog ?? []);

  const failures = [score, placement, customer].flatMap((phase) =>
    phase.status === 'failed' ? [phase.failure] : [],
  );

  const results = assemble({
    input,
    scoreLog,
    uniqueness: placement.status === 'ok' ? merged : priorUniqueness,
    demandLog,
    score,
    placement,
    customer,
    delivered: failures.length === 0,
  });

  await store.writeResults(results);

  if (failures.length > 0) {
    return { status: 'failed', retryable: failures.every((failure) => failure.retryable), failures, results };
  }
  // Unreachable while `failures` is empty — both arms are checked so the compiler
  // agrees, and so a future edit that adds a fourth phase cannot slip past.
  if (placement.status !== 'ok' || score.status !== 'ok') {
    throw new Error('runIncremental: internal inconsistency — no failures recorded but a phase did not succeed');
  }

  const ranking = rankCategory({
    category: input.category,
    type: input.jury.type,
    prompt_version: input.jury.prompt_version,
    uniqueness_version: results.meta.uniqueness_version,
    demand_version: results.demand?.demand_version ?? input.personas.persona_version,
    products: allProducts,
    metrics: input.jury.metrics.map((metric) => ({ name: metric.name, description: metric.description })),
    jury: input.jury.jurors,
    personas: input.personas.personas,
    scoreLog,
    uniqueness: merged,
    demandLog,
    flaggedInjections: results.flaggedInjections,
  });

  await store.writeRanking(ranking);

  const placed = merged.clusters.find((cluster) => cluster.cluster_id === placement.value.cluster_id);
  return {
    status: 'placed',
    results,
    ranking,
    assignment: {
      cluster_id: placement.value.cluster_id,
      label: placed?.label ?? '',
      is_new: placement.value.isNew,
      size: placed?.member_ids.length ?? 1,
      uniqueness_score: placement.value.uniqueness_score,
      reason: placement.value.reason,
    },
  };
}

// --- The placement call --------------------------------------------------------

/** A resolved placement: which cluster, whether it is new, and the scarcity row. */
interface Placement {
  cluster_id: ClusterId;
  isNew: boolean;
  label: string;
  uniqueness_score: number;
  reason: string;
}

/**
 * One call: place the product against the fixed roster (`src/panels/prompts/assign.ts`).
 *
 * Reported under `phase: 'uniqueness'`. It is a different CALL from `01 §5.2`'s
 * clustering pass, but it is the same phase of the graph — it is what produces
 * this run's cluster assignment, it is what the Customer phase waits on, and it
 * lands in the same `results.meta.phases.uniqueness` slot. Giving it a fourth
 * `PhaseName` would fork every consumer of that record for no gain.
 */
async function assignCluster(input: IncrementalInput, prior: UniquenessResult): Promise<PhaseResult<Placement>> {
  const ledger = new PhaseLedger();
  const existingIds = new Set(prior.clusters.map((cluster) => cluster.cluster_id));

  const result = await dispatch(
    input.client,
    buildAssignRequest({ product: input.product, clusters: prior.clusters, products: input.products }),
    `placement of product ${input.product.id}`,
    ledger,
    (output) => validateAssignResult(output, existingIds),
  );

  const cost = ledger.total();
  if (!result.ok) {
    return {
      phase: 'uniqueness',
      status: 'failed',
      cost,
      warnings: [],
      failure: {
        code: result.code,
        retryable: result.retryable,
        message:
          'the new product could not be placed in a cluster. Without a placement it would rank on merit ' +
          'alone and look exactly like a genuine solo cluster (DECISIONS.md S11), so this is reported ' +
          'here rather than left to be guessed from the board.',
        causes: [result.message],
      },
    };
  }

  const assignment = result.value;
  const placement: Placement =
    assignment.cluster_id === undefined
      ? {
          cluster_id: newClusterId(input.product.id, existingIds),
          isNew: true,
          label: assignment.new_cluster_label ?? '',
          uniqueness_score: assignment.uniqueness_score,
          reason: assignment.reason,
        }
      : {
          cluster_id: assignment.cluster_id,
          isNew: false,
          label: prior.clusters.find((cluster) => cluster.cluster_id === assignment.cluster_id)?.label ?? '',
          uniqueness_score: assignment.uniqueness_score,
          reason: assignment.reason,
        };

  return { phase: 'uniqueness', status: 'ok', cost, warnings: [], value: placement };
}

/**
 * A cluster id for a product that opened its own cluster.
 *
 * Derived from the product id, so it is stable across a retry of the same
 * placement rather than fresh on every attempt — a demand vote keyed to a
 * regenerated id would be orphaned. Suffixed only on the collision that a
 * hand-edited roster could produce.
 */
function newClusterId(productId: number, taken: ReadonlySet<ClusterId>): ClusterId {
  const base = `p${productId}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- Merging -------------------------------------------------------------------

/**
 * Append the new product to the stored clusters. Append-only, literally: existing
 * `cluster_id`s, labels and memberships are copied through untouched, so every
 * demand vote keyed to one of them stays valid (`brief §1.5`).
 */
function mergeUniqueness(prior: UniquenessResult, productId: number, placement: Placement): UniquenessResult {
  const clusters: Cluster[] = prior.clusters.map((cluster) =>
    cluster.cluster_id === placement.cluster_id
      ? { ...cluster, member_ids: [...cluster.member_ids, productId] }
      : { ...cluster },
  );

  if (placement.isNew) {
    clusters.push({
      cluster_id: placement.cluster_id,
      label: sanitize(placement.label, SANITIZE_LIMIT),
      member_ids: [productId],
    });
  }

  const row: UniquenessProduct = {
    id: productId,
    uniqueness_score: placement.uniqueness_score,
    cluster_id: placement.cluster_id,
    reason: placement.reason,
  };

  return { clusters, products: [...prior.products, row] };
}

/** The cluster the new product landed in, if it now holds a choice worth putting to anybody. */
function changedCluster(merged: UniquenessResult, clusterId: ClusterId): Cluster | undefined {
  const cluster = merged.clusters.find((candidate) => candidate.cluster_id === clusterId);
  // `similarSets` filters to >= 2 members anyway; checking here is what lets the
  // Customer phase be skipped rather than called with a set it would discard.
  return cluster !== undefined && cluster.member_ids.length >= 2 ? cluster : undefined;
}

/**
 * Fold the new product's rows into the stored score log, per juror.
 *
 * `01 §6.1` merges every entry sharing a `juror_role` before normalizing, so
 * appending a second entry for the same role would work — but it would also make
 * the stored log grow an entry per placement forever. One entry per juror keeps
 * `results.json` the readable integrity record `brief` Part 7 wants.
 */
function appendScoreLog(prior: readonly ScoreLogEntry[], added: readonly ScoreLogEntry[]): ScoreLogEntry[] {
  const byRole = new Map(prior.map((entry) => [entry.juror_role, { ...entry, scores: [...entry.scores] }]));

  for (const entry of added) {
    const existing = byRole.get(entry.juror_role);
    if (existing === undefined) {
      byRole.set(entry.juror_role, { ...entry, scores: [...entry.scores] });
      continue;
    }
    existing.scores.push(...entry.scores);
    // The new product was scored under the CURRENT prompt version; recording it
    // is what lets a stale-epoch audit (`DECISIONS.md` S6) find mixed logs later.
    existing.prompt_version = entry.prompt_version;
  }

  return [...byRole.values()];
}

/**
 * Replace each persona's choice for the ONE changed cluster and keep the rest.
 *
 * Not a wholesale replacement: a persona's stored choices for every other set are
 * still valid, because no other set's membership moved. Re-running them would
 * cost a call per set and, worse, resample votes that were fine — turning a
 * placement into a source of rank movement for products that did not change.
 */
function mergeDemandLog(
  prior: readonly DemandLogEntry[],
  fresh: readonly DemandLogEntry[],
  clusterId: ClusterId,
): DemandLogEntry[] {
  const byPersona = new Map(
    prior.map((entry) => [
      entry.persona,
      { persona: entry.persona, choices: entry.choices.filter((choice) => choice.cluster_id !== clusterId) },
    ]),
  );

  for (const entry of fresh) {
    const existing = byPersona.get(entry.persona);
    if (existing === undefined) byPersona.set(entry.persona, { persona: entry.persona, choices: [...entry.choices] });
    else existing.choices.push(...entry.choices);
  }

  return [...byPersona.values()];
}

// --- Bookkeeping ---------------------------------------------------------------

/** Same version-stamped envelope the full run writes; see `run-category.ts`. */
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
 * The Floor legitimately not convening, on the incremental path. `01 §5.3`'s
 * gate and `DECISIONS.md` S11's terminal, successful status — structurally the
 * same arm a full run returns for a category with no multi-member cluster.
 */
function skippedCustomer(): PhaseResult<CustomerPhaseValue> {
  return { phase: 'customer', status: 'skipped', cost: zeroCost(), warnings: [], skipped: 'no_sets' };
}

/** A phase that never got the chance to run. Never S11's `skipped`. */
function notRun<T>(phase: PhaseName, message: string): PhaseResult<T> {
  return {
    phase,
    status: 'failed',
    cost: zeroCost(),
    warnings: [],
    failure: { code: 'incomplete_panel', retryable: true, message, causes: [] },
  };
}

interface AssembleIncremental {
  input: IncrementalInput;
  scoreLog: ScoreLogEntry[];
  uniqueness: UniquenessResult;
  demandLog: DemandLogEntry[];
  score: PhaseResult<ScorePhaseValue>;
  placement: PhaseResult<Placement>;
  customer: PhaseResult<CustomerPhaseValue>;
  delivered: boolean;
}

/** The updated `results.json`, with a ledger covering only what this placement spent. */
function assemble(args: AssembleIncremental): RunResults {
  const { input } = args;
  const uniquenessVersion = input.config.uniquenessVersion ?? input.config.categoryVersion;
  const demandVersion = input.config.demandVersion ?? input.personas.persona_version;

  const costs: Record<PhaseName, PhaseCost> = {
    score: args.score.cost,
    uniqueness: args.placement.cost,
    customer: args.customer.cost,
  };

  const phases: Record<PhaseName, PhaseSummary> = {
    score: summarize(args.score),
    uniqueness: summarize(args.placement),
    customer: summarize(args.customer),
  };

  // Appended, not reconciled. A re-voted set's OLD choice reasons keep their
  // flags here even though the choices themselves were replaced, so a re-placed
  // cluster can accumulate a stale duplicate. Accepted: `FlaggedInjection`
  // (`01 §8`) carries no cluster id to prune by, and per `DECISIONS.md` S9 the
  // output alarm is log-only and never gates delivery — the cost of the
  // duplicate is one extra line on an admin board.
  const flaggedInjections = [
    ...input.results.flaggedInjections,
    ...(args.score.status === 'ok' ? args.score.value.flaggedInjections : []),
    ...(args.customer.status === 'ok' ? args.customer.value.flaggedInjections : []),
  ];

  const meta: RunMeta = {
    ...input.results.meta,
    category: input.category,
    category_version: input.config.categoryVersion,
    prompt_version: input.jury.prompt_version,
    persona_version: input.personas.persona_version,
    uniqueness_version: uniquenessVersion,
    outcome: args.delivered ? 'delivered' : 'failed',
    phases,
    // This placement's spend only, NOT a running category total. `01 §7.3`'s cost
    // model is per run, and a ledger that silently accumulated across placements
    // could not answer "what did this customer's attempt cost".
    ledger: buildLedger(costs),
    // The failure arm carries its own audit (`PhaseFailure.coverage`), so a
    // failed placement still names the juror that did not answer. Falling back to
    // the SEED run's coverage here would report a complete panel for a run whose
    // panel was short — the one report that must not say that.
    coverage:
      args.score.status === 'ok'
        ? args.score.value.coverage
        : (args.score.status === 'failed' ? args.score.failure.coverage : undefined) ?? input.results.meta.coverage,
    warnings: [
      ...args.score.warnings,
      ...args.placement.warnings,
      ...args.customer.warnings,
      ...unpricedWarning(buildLedger(costs).total.unpriced_models),
    ],
  };

  return {
    scoreLog: args.scoreLog,
    uniqueness: { ...args.uniqueness, uniqueness_version: uniquenessVersion },
    demand:
      args.demandLog.length === 0
        ? null
        : { personas: [...input.personas.personas], demandLog: args.demandLog, demand_version: demandVersion },
    flaggedInjections,
    meta,
  };
}

/** See `run-category.ts`: a total booked short must say so. */
function unpricedWarning(models: readonly string[]): string[] {
  if (models.length === 0) return [];
  return [
    `cost is UNDERSTATED: no price is known for model id(s) ${models.map((m) => JSON.stringify(m)).join(', ')}, ` +
      'so their tokens were booked at $0. Treat this run’s cost_usd as a lower bound, not a total.',
  ];
}

function summarize<T>(result: PhaseResult<T>): PhaseSummary {
  const base = { status: result.status, cost: result.cost, warnings: result.warnings };
  if (result.status === 'skipped') return { ...base, status: 'skipped', skipped: result.skipped };
  if (result.status === 'failed') return { ...base, status: 'failed', failure: result.failure };
  return { ...base, status: 'ok' };
}
