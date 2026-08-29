/**
 * The five steps of the run pipeline, and the seam they execute through.
 *
 * ## One step per PHASE — the constraint the whole module is shaped around
 *
 * `brief` Part 7:
 *
 * > "Make each *phase* one step that fires its calls in parallel inside it — not
 * > one step per juror call. Free tier is 50K executions and **5 concurrent
 * > steps**; a 6-way fan-out as separate steps throttles badly. The vote cache
 * > makes a retried phase nearly free, so losing per-call retry granularity costs
 * > nothing."
 *
 * The failure mode this prevents is silent. A pipeline that made each juror call
 * its own `step.run` would produce byte-identical output and pass every
 * assertion about scores, ranks and delivery; it would only show up as latency in
 * production, on the free tier, once six calls started queueing behind a
 * concurrency limit of five. So the step LIST is a first-class, exported constant
 * and `StepRunner` records the ids it was asked to run — a test can then assert
 * the step count, which is the only assertion that catches the regression.
 *
 * `PIPELINE_STEPS` is `score -> cluster -> persona -> rank -> deliver`, the names
 * `the-pit-agent-prompts.md` Phase 2 gives. Three of them run an engine phase;
 * `rank` and `deliver` spend nothing on a model at all.
 *
 * ## Why the step names are not the engine's phase names
 *
 * The engine calls its phases `score`, `uniqueness` and `customer` (`01 §2`), and
 * those names are stamped into every persisted envelope under
 * `cjr/runs/<slug>/phases/`. The pipeline's step ids are Inngest's memoization
 * keys and appear in the Inngest UI and on the status page. Renaming either side
 * to match the other would either rewrite the engine's stored artifacts or put
 * `uniqueness` in front of a customer waiting on a status page. `PHASE_OF_STEP`
 * is the one place the two vocabularies meet.
 */

import type {
  Jury,
  ModelClient,
  PersonaPanel,
  PhaseName,
  Product,
  RunConfig,
} from '@the-pit/engine';
import type { AttemptDecision } from '@the-pit/payments';

import type { SnapshotSink } from './snapshot';
import type { PipelineStore } from './store';

/** One Inngest step. `the-pit-agent-prompts.md` Phase 2's `score → cluster → persona → rank → deliver`. */
export type PipelineStep = 'score' | 'cluster' | 'persona' | 'rank' | 'deliver';

/**
 * Every step the pipeline runs, in order — and, more to the point, the whole list
 * of them.
 *
 * Exported so a test can assert that a run produced exactly these five step ids.
 * That assertion is the guard on `brief` Part 7: splitting the juror fan-out into
 * per-call steps would leave this array untouched but make the executed list ten
 * entries long.
 */
export const PIPELINE_STEPS = ['score', 'cluster', 'persona', 'rank', 'deliver'] as const satisfies readonly PipelineStep[];

/**
 * Which engine phase each model-facing step runs.
 *
 * Only three of the five appear here: `rank` reassembles what is already stored
 * and `deliver` publishes it, and neither is allowed to call a model at all
 * (`02 §4`: "reads never touch a model").
 */
export const PHASE_OF_STEP = {
  score: 'score',
  cluster: 'uniqueness',
  persona: 'customer',
} as const satisfies Record<'score' | 'cluster' | 'persona', PhaseName>;

/** The step that runs a given engine phase — `PHASE_OF_STEP` read backwards. */
export const STEP_OF_PHASE = {
  score: 'score',
  uniqueness: 'cluster',
  customer: 'persona',
} as const satisfies Record<PhaseName, PipelineStep>;

/**
 * The durable-execution seam.
 *
 * Exactly the shape of Inngest's `step.run`, and deliberately nothing more. The
 * pipeline is written against this interface rather than against an Inngest
 * `context` so that the whole thing runs in a test with no Inngest client, no dev
 * server and no network — and so that a recording implementation can count the
 * steps a run actually asked for.
 *
 * A body's return value is memoized by the executor and replayed on a retry, so
 * it must be JSON-serializable and it must be SMALL. Every step here returns a
 * `StepReport`; the phase results, the assembled `results.json` and the ranking
 * live in the `RunStore`, which is where `brief §2.3`'s "retry only the failed
 * phase" reads them back from.
 */
export interface StepRunner {
  run<T>(id: PipelineStep, body: () => Promise<T>): Promise<T>;
}

/**
 * What a step tells the executor it did. Small on purpose — see `StepRunner`.
 *
 * `resumed` is a fourth status alongside the engine's three: the phase was not
 * run at all because a valid, version-matched result was already persisted from
 * an earlier attempt. It is the observable form of `brief §2.3`'s free retry, and
 * `calls: 0` next to it is the evidence that the retry cost nothing.
 */
export interface StepReport {
  step: PipelineStep;
  status: 'ok' | 'skipped' | 'failed' | 'resumed';
  /** Model calls this step made. Zero on `resumed`, and zero on `rank` and `deliver` always. */
  calls: number;
  /** A human-readable line for the status page: a skip reason, a failure message. */
  detail?: string;
}

/** The category a run is over, and the versions it runs under. */
export interface PipelineInput {
  category: string;
  products: readonly Product[];
  /** An INSTALLED jury, past `01 §4` Step 2's approval gate. */
  jury: Jury;
  /** An INSTALLED persona panel, past `01 §4` Step 3's gate. */
  personas: PersonaPanel;
  config: RunConfig;
}

/** Everything the pipeline talks to that is not the category itself. */
export interface PipelineDeps {
  /**
   * The one model seam (`packages/engine/src/model/types.ts`). The pipeline never
   * constructs a client and never imports an SDK; it is handed one, exactly as
   * `runCategory` is.
   */
  client: ModelClient;
  store: PipelineStore;
  /** Where a delivered run's board snapshot is published. Omitted, nothing is published. */
  snapshots?: SnapshotSink;
  /**
   * Called once, at the end of a delivered run, after the board snapshot exists.
   *
   * `brief §2.3`: "An attempt is consumed only on delivery — decrement in the
   * same transaction that writes the verdict and marks it delivered. Not on job
   * start, not on pipeline completion." The attempts ledger is Phase 3's and
   * another agent's; this is the join point it plugs into, declared here so that
   * the ONE place an attempt may be spent is fixed by the pipeline rather than
   * discovered later. It is deliberately not called on any failure path, and not
   * called before the snapshot is published.
   */
  onDelivered?: (record: DeliveryRecord) => Promise<void>;
  /**
   * Who bought this run, when somebody did.
   *
   * Absent on a seed run and on an admin re-run: those deliver a board and spend
   * nothing, because there is no attempt behind them. Present on every paid
   * placement, and it is the ONLY thing that distinguishes the two on this path —
   * `deliverStep` publishes the same board either way, and only a record carrying
   * a payer can be settled into a verdict and a decrement.
   *
   * It carries an account id AND an email because they answer to two different
   * tables: `attempts.account_id` and `verdicts.account_id` are the uuid,
   * `products.submitted_by_email` is the address Dodo verified, and
   * `products_source_submitter` requires the address on any row marked `paid`.
   */
  paid?: PaidPlacement;
  /** Injected so a snapshot's `generated_at` is deterministic in a test. */
  now?: () => Date;
}

/** The customer behind one paid placement. */
export interface PaidPlacement {
  /** `accounts.id`, resolved by the webhook from the address Dodo verified. */
  readonly accountId: string;
  /** That same address. `products.submitted_by_email`, lowercased upstream. */
  readonly email: string;
  /** The engine id of the product being placed — `Product.id` for this submission. */
  readonly engineId: number;
  /**
   * Which pitch this is, 1-based. `brief §2.4`: shown publicly as "3rd pitch".
   *
   * Computed by `checkSubmissionLocal` before the money moved and carried on the
   * `submissions` row, so it counts PITCHES and not runs: a free retry re-enters
   * the pipeline with the same submission and the same ordinal.
   */
  readonly attemptNumber: number;
}

/**
 * What a delivered run hands to whatever consumes an attempt.
 *
 * This shape crosses a queue — it is the body of `pit/run.delivered` — so every
 * field is JSON, and it carries everything the settling side needs to write a
 * verdict without re-deriving anything from a board that has since moved
 * (`brief §1.2`).
 */
export interface DeliveryRecord {
  slug: string;
  category: string;
  /** The population version the board was computed over (`brief §1.3`). */
  category_version: string;
  /** ISO-8601, the same stamp the published snapshot carries. */
  delivered_at: string;
  product_count: number;
  /** The CDN keys the board was republished under, absent if no sink was configured. */
  published?: { board: string; dated: string };
  /**
   * `jobs.id` — the row this run persisted its phases into.
   *
   * Absent when the store is not durable (the filesystem and memory stores have
   * no run identity), which is also every environment in which there is nothing
   * to settle.
   */
  run_id?: string;
  /** Present exactly when a customer paid for this delivery. */
  paid?: PaidDelivery;
}

/** The payer, the decision, and the document — everything a settle needs. */
export interface PaidDelivery extends PaidPlacement {
  /**
   * `decideAttempt`'s answer, made where the run's own report is.
   *
   * Carried rather than re-derived at the settling end, because the input it
   * reads — `RunResults.meta.phases` — is the run's, and the settling end has
   * only an event. `AttemptsLedger.deliver` refuses anything that is not the
   * `consume` arm, so an arm that ever appears here stops the money rather than
   * being interpreted.
   */
  readonly decision: AttemptDecision;
  /**
   * The verdict document, frozen at this instant by `verdictPayload`.
   *
   * Frozen HERE and not at the settling end because this is where the ranking is:
   * `brief §1.2` moves every z-score on the next placement, so a payload built a
   * moment later off "the current board" would be a permanent public page about a
   * board the customer never saw.
   */
  readonly payload: unknown;
}
