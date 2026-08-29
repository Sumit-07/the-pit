/**
 * The run pipeline: five durable steps over the engine's phase graph.
 *
 *   score  ──┐                       (Round 1, `01 §2`: both read only products)
 *   cluster ─┘──▶ persona ──▶ rank ──▶ deliver
 *
 * ## One step per phase (`brief` Part 7)
 *
 * Every model call a phase makes goes out INSIDE that phase's single step. The
 * Score step fires `JUROR_COUNT x chunks` calls together; the Persona step fires
 * one per persona. The alternative — a `step.run` per juror — is invisible in
 * every output and shows up only as throttling against the free tier's five
 * concurrent steps. `PIPELINE_STEPS` is the exported list, and the tests assert
 * the executed step ids against it, because a step-count assertion is the only
 * one that catches the regression.
 *
 * `score` and `cluster` are launched together, which is `01 §2`'s Round 1 and
 * costs two concurrent steps out of five. Ordering them serially would be safe
 * for the concurrency limit and wrong for the graph — Uniqueness does not depend
 * on Score, and making a customer wait for it to finish first adds a phase of
 * latency to every run for nothing.
 *
 * ## Nothing here orchestrates that the engine already orchestrates
 *
 * The three phase steps call the engine's exported phase functions unchanged.
 * The `rank` step re-enters `runCategory` with `resume: true`, so the assembly of
 * `results.json`, the cost ledger, the coverage audit, `isDeliverable`'s
 * three-union delivery decision and `rankCategory` itself are all the engine's,
 * running over the phases the earlier steps persisted. It is handed a
 * `NoModelClient`: every phase must come back off disk, and a resume that missed
 * would otherwise re-buy a phase the customer has already paid for, silently, on
 * the step whose whole job is arithmetic.
 *
 * ## Failure and retry (`brief §2.3`)
 *
 * A phase that comes back `failed` is PERSISTED and then thrown, in that order.
 * Persisting first is what leaves a diagnosis for the support queue and the
 * status page; throwing is what stops the executor recording the failure as the
 * step's answer and marching on to rank nothing. Because every earlier phase is
 * already on disk and version-stamped, the retry re-runs only the failed step —
 * the free retry `brief §2.3` requires, with the vote cache making it nearly
 * free.
 *
 * Whether a failure is retryable at all is the engine's classification, keyed on
 * an error code in `dispatch`, never re-derived here.
 */

import {
  phaseVersions,
  runCategory,
  runCustomerPhase,
  runScorePhase,
  runUniquenessPhase,
  type CustomerPhaseValue,
  type PanelOrdering,
  type PersistedPhase,
  type PhaseFailure,
  type PhaseName,
  type PhaseResult,
  type PhaseVersions,
  type ScorePhaseValue,
  type UniquenessPhaseValue,
} from '@the-pit/engine';

import { NoModelClient, PhaseFailedError } from './errors';
import { reusableStoredPhase } from './resume';
import type { PublishedSnapshot } from './snapshot';
import { buildSnapshot } from './snapshot-build';
import {
  PHASE_OF_STEP,
  type PipelineDeps,
  type PipelineInput,
  type PipelineStep,
  type StepReport,
  type StepRunner,
} from './types';

/** What one delivered run produced, small enough to be an executor's return value. */
export interface PipelineResult {
  slug: string;
  /** One entry per executed step, in completion order. */
  reports: StepReport[];
  /** The CDN keys the board snapshot was published under, if a sink was configured. */
  published?: PublishedSnapshot;
  product_count: number;
}

/** The `deliver` step's report, which carries the two things the caller wants back. */
export interface DeliverReport extends StepReport {
  published?: PublishedSnapshot;
  product_count: number;
}

/**
 * Run one category through the pipeline.
 *
 * Throws `PhaseFailedError` on any phase failure. The caller decides what that
 * means to the executor — `inngest.ts` maps a terminal failure onto
 * `NonRetriableError` and lets a retryable one be retried, capped at
 * `brief §2.3`'s three.
 */
export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  step: StepRunner,
): Promise<PipelineResult> {
  const versions = phaseVersions(input);
  const ordering: PanelOrdering = { category: input.category, categoryVersion: input.config.categoryVersion };

  // --- Round 1: score || cluster ---------------------------------------------
  // `allSettled`, not `all`: both steps must be executed and reported before
  // either failure is raised. A bare `Promise.all` would reject the moment the
  // merit panel failed and leave a clustering pass that had ALREADY come back
  // unpersisted — the retry would then re-buy it, which is exactly the spend
  // "persist each phase result as it lands" exists to prevent.
  const round1 = await Promise.allSettled([
    step.run('score', () => scoreStep(input, deps, versions, ordering)),
    step.run('cluster', () => clusterStep(input, deps, versions, ordering)),
  ]);

  const reports: StepReport[] = [];
  for (const settled of round1) {
    if (settled.status === 'fulfilled') reports.push(settled.value);
  }
  const round1Failure = round1.find((settled) => settled.status === 'rejected');
  if (round1Failure?.status === 'rejected') throw round1Failure.reason;

  // --- Round 2: persona -------------------------------------------------------
  reports.push(await step.run('persona', () => personaStep(input, deps, versions, ordering)));

  // --- Rank: pure arithmetic over what is already persisted --------------------
  reports.push(await step.run('rank', () => rankStep(input, deps)));

  // --- Deliver: the placement that regenerates the board snapshot --------------
  const delivered = await step.run('deliver', () => deliverStep(input.config.categoryVersion, deps));
  reports.push(delivered);

  return {
    slug: deps.store.slug,
    reports,
    ...(delivered.published === undefined ? {} : { published: delivered.published }),
    product_count: delivered.product_count,
  };
}

// --- The steps -----------------------------------------------------------------

/**
 * The merit jury. ONE step, `JUROR_COUNT x chunks` calls fanned out inside it.
 *
 * `runScorePhase` does the fan-out with a single `Promise.all` over
 * `(juror x chunk)`, so the concurrency lives inside the engine and this step
 * simply awaits it. That is the arrangement `brief` Part 7 asks for, and the
 * reason it is stated here as well as in the engine is that the pipeline is where
 * it would be undone.
 *
 * `products.json` is written here, before anything is scored. `Product.id` is an
 * index into the usable rows of the source category, so pinning the file on the
 * first run is what makes every stored score, cluster and vote attach to a stable
 * id across a resume.
 */
async function scoreStep(
  input: PipelineInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
  ordering: PanelOrdering,
): Promise<StepReport> {
  return phaseStep<ScorePhaseValue>('score', deps, versions, async () => {
    await deps.store.writeProducts({ category: input.category, products: [...input.products] });
    return runScorePhase({
      client: deps.client,
      products: input.products,
      jury: input.jury,
      ordering,
      // `brief §1.1`: an incremental run scores one product against a fixed
      // sample of already-scored peers. `runCategory` passes the same field
      // through, so the resumed run in the `rank` step sees the same prompt.
      ...(input.config.calibration === undefined ? {} : { calibration: input.config.calibration }),
      ...(input.config.chunkSize === undefined ? {} : { chunkSize: input.config.chunkSize }),
    });
  });
}

/** The clustering pass. One call, one step — `01 §5.2`. */
async function clusterStep(
  input: PipelineInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
  ordering: PanelOrdering,
): Promise<StepReport> {
  return phaseStep<UniquenessPhaseValue>('cluster', deps, versions, () =>
    runUniquenessPhase({ client: deps.client, products: input.products, ordering }),
  );
}

/**
 * The Floor. One call per persona, all fired inside this one step.
 *
 * Reads its clusters back out of the persisted Uniqueness envelope rather than
 * being handed them from the previous step. That is not indirection for its own
 * sake: a step's return value is a memoized JSON blob and the cluster roster for
 * a full category is not small, and — more importantly — a run resumed in a fresh
 * process has no previous step to be handed anything by. The store is the state.
 */
async function personaStep(
  input: PipelineInput,
  deps: PipelineDeps,
  versions: PhaseVersions,
  ordering: PanelOrdering,
): Promise<StepReport> {
  return phaseStep<CustomerPhaseValue>('persona', deps, versions, async () => {
    const uniqueness = await reusableStoredPhase<UniquenessPhaseValue>(deps.store, 'uniqueness', versions);
    if (uniqueness === undefined || uniqueness.status !== 'ok') {
      // Unreachable while the cluster step throws on failure: this is the state
      // where the store lost a write or the versions moved mid-run. It is
      // reported as an engine-side `internal` failure — terminal, because
      // retrying it would spend the customer's free retries reproducing a
      // storage fault rather than a model one.
      throw new PhaseFailedError('persona', [
        {
          code: 'internal',
          retryable: false,
          message:
            'the customer panel could not start: no usable clustering result was persisted for this run. ' +
            'Without clusters the Floor cannot convene, and a run that skipped it would be indistinguishable ' +
            'on the board from a category of genuinely unique products (DECISIONS.md S11).',
          causes: [],
        },
      ]);
    }

    return runCustomerPhase({
      client: deps.client,
      products: input.products,
      personas: input.personas.personas,
      uniqueness: uniqueness.value.uniqueness,
      ordering,
    });
  });
}

/**
 * Rank — the engine, re-entered over what is already on disk.
 *
 * `runCategory({resume: true})` reads all three phases back through its own
 * version gate, assembles `results.json`, applies `isDeliverable` and writes
 * `ranking.json`. Every line of that is the engine's; this step supplies the
 * store and a client that must never be called.
 *
 * Global Constraint 1 holds here too: no model produces or sees a rank. This step
 * is arithmetic over stored rows, which is why it can be re-run offline from
 * `results.json` at any time if anyone disputes a ranking.
 */
async function rankStep(input: PipelineInput, deps: PipelineDeps): Promise<StepReport> {
  const outcome = await runCategory({
    category: input.category,
    products: input.products,
    jury: input.jury,
    personas: input.personas,
    client: new NoModelClient(
      'the rank step reassembles phases that are already persisted and must never buy one; ' +
        'a call here means a phase did not resume, and re-running it silently would charge twice for one board',
    ),
    config: { ...input.config, resume: true },
    store: deps.store,
  });

  if (outcome.status !== 'delivered') {
    throw new PhaseFailedError('rank', outcome.failures);
  }

  return {
    step: 'rank',
    status: 'ok',
    calls: 0,
    detail: `${outcome.ranking.ranking.length} product(s) ranked, ${outcome.ranking.clusters.length} cluster(s)`,
  };
}

/**
 * Deliver — the placement, and the only event that regenerates a board snapshot.
 *
 * `brief` Part 3 and `02 §4`: boards are CDN snapshots regenerated on placement,
 * and reads never touch a model. Publishing happens here, once, at the end of a
 * run that `isDeliverable` already said was whole — never on a read, never on a
 * failure, and never on a partial run.
 *
 * `brief §2.3` puts one more thing at this exact point: "An attempt is consumed
 * only on delivery — decrement in the same transaction that writes the verdict
 * and marks it delivered." That ledger is Phase 3's and another agent's;
 * `deps.onDelivered` is the join point it plugs into, and it is deliberately
 * called AFTER the snapshot exists, so an attempt can never be spent on a verdict
 * that was not published.
 */
export async function deliverStep(categoryVersion: string, deps: PipelineDeps): Promise<DeliverReport> {
  const ranking = await deps.store.readRanking();
  if (ranking === undefined) {
    throw new PhaseFailedError('deliver', [
      {
        code: 'internal',
        retryable: false,
        message: 'nothing to deliver: the rank step reported success but no ranking was persisted for this run',
        causes: [],
      },
    ]);
  }

  const snapshot = buildSnapshot({
    slug: deps.store.slug,
    ranking,
    categoryVersion,
    generatedAt: (deps.now ?? (() => new Date()))(),
  });

  const published = deps.snapshots === undefined ? undefined : await deps.snapshots.publish(snapshot);

  await deps.onDelivered?.({
    slug: snapshot.slug,
    category: snapshot.category,
    delivered_at: snapshot.generated_at,
    product_count: snapshot.product_count,
    ...(published === undefined ? {} : { published }),
  });

  return {
    step: 'deliver',
    status: 'ok',
    calls: 0,
    detail:
      published === undefined
        ? `${snapshot.product_count} product(s) delivered; no snapshot sink configured`
        : `${snapshot.product_count} product(s) delivered; board republished at ${published.board}`,
    ...(published === undefined ? {} : { published }),
    product_count: snapshot.product_count,
  };
}

// --- The shape every phase step shares -----------------------------------------

/**
 * Resume, or run and persist, or fail — the three things a phase step does.
 *
 * The order matters and is the whole of `brief §2.3`:
 *
 * 1. Ask the store whether this phase is already bought under these versions. If
 *    it is, spend nothing and report `resumed` with `calls: 0`.
 * 2. Run it, and persist the result the moment it lands — whatever it is.
 * 3. Only then, if it failed, throw. A failure that was thrown before it was
 *    written would leave the retry and the status page with nothing to read.
 */
export async function phaseStep<T>(
  step: Extract<PipelineStep, 'score' | 'cluster' | 'persona'>,
  deps: PipelineDeps,
  versions: PhaseVersions,
  run: () => Promise<PhaseResult<T>>,
): Promise<StepReport> {
  const phase: PhaseName = PHASE_OF_STEP[step];

  const cached = await reusableStoredPhase<T>(deps.store, phase, versions);
  if (cached !== undefined) {
    return {
      step,
      status: 'resumed',
      calls: 0,
      detail: `reused the stored ${phase} phase (${cached.status}); brief §2.3 makes this retry free`,
    };
  }

  const result = await run();
  const envelope: PersistedPhase<T> = { versions, result };
  await deps.store.writePhase(phase, envelope);

  if (result.status === 'failed') throw new PhaseFailedError(step, [result.failure]);

  return {
    step,
    status: result.status,
    calls: result.cost.calls,
    ...(result.status === 'skipped'
      ? { detail: `skipped: ${result.skipped} — a terminal, successful status (DECISIONS.md S11)` }
      : {}),
  };
}

/** Re-exported so a caller can narrow a thrown pipeline failure without importing two modules. */
export type { PhaseFailure };
