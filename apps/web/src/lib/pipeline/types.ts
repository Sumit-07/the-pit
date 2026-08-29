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
  /** Injected so a snapshot's `generated_at` is deterministic in a test. */
  now?: () => Date;
}

/** What a delivered run hands to whatever consumes an attempt. */
export interface DeliveryRecord {
  slug: string;
  category: string;
  /** ISO-8601, the same stamp the published snapshot carries. */
  delivered_at: string;
  product_count: number;
  /** The CDN keys the board was republished under, absent if no sink was configured. */
  published?: { board: string; dated: string };
}
