/**
 * The shapes the orchestrator moves through: phase results, the cost ledger, and
 * the `results.json` document `01 §4` Step 5 describes.
 *
 * ## The one shape that decides whether a customer is charged
 *
 * `PhaseResult` is a three-armed discriminated union — `ok`, `skipped`, `failed`
 * — and that shape IS the delivery decision. `brief §2.3` says partial success is
 * a failure that must be retried free and never delivered, while `DECISIONS.md`
 * S11 says an empty Floor is a successful delivery. Those two are one line apart
 * in the pipeline and worlds apart on the money path, so they are different arms
 * of a union rather than different values of one status field.
 *
 * Crucially, the arm is set by the PHASE ITSELF, from whether its calls returned
 * and validated. It is never inferred from the ranking output — not from a
 * `cluster.id === 'unclustered'` fallback, not from `demand_status`. Both of
 * those are legitimate states of a perfectly good run (a genuine solo cluster
 * produces exactly the same `demand_status: 'solo_cluster'` as a clustering pass
 * that never ran), so reading them backwards to decide deliver-vs-retry would
 * charge for a broken run and refund a good one. `isDeliverable` in
 * `run-category.ts` reads only these unions.
 */

import type { TokenUsage } from '../model/types.js';
import type {
  DemandLogEntry,
  FlaggedInjection,
  Persona,
  Ranking,
  ScoreLogEntry,
  UniquenessResult,
} from '../types.js';

// --- Phases -------------------------------------------------------------------

/** The three phases of `01 §2`'s graph. Score and Uniqueness are Round 1; Customer is Round 2. */
export type PhaseName = 'score' | 'uniqueness' | 'customer';

/**
 * Why a phase legitimately did not run. A terminal, successful status — the run
 * is delivered and the attempt is consumed (`DECISIONS.md` S11).
 *
 * - `no_sets` — the uniqueness pass found no cluster with >= 2 members, so there
 *   is no forced choice to put to anybody (`01 §5.3`).
 * - `no_personas` — the installed panel is empty. `01 §5.3` gates on
 *   `personas.length > 0 && sets.length > 0`; this is the other half of that gate.
 */
export type SkipReason = 'no_sets' | 'no_personas';

/**
 * Why a phase failed, in a form a retry policy can act on without reading prose.
 *
 * `retryable` is the `brief §2.3` classification: a retryable failure is a FREE
 * retry that must not consume an attempt and must not be delivered; a terminal
 * one will fail identically forever and belongs in the support queue rather than
 * in a retry loop.
 */
export interface PhaseFailure {
  code: FailureCode;
  retryable: boolean;
  message: string;
  /** Failing calls, one entry per juror / persona / pass that did not come back. */
  causes: readonly string[];
  /**
   * Present on every Score-phase failure. The audit is run whether the phase
   * succeeded or not, precisely so a FAILED run still says which jurors are
   * missing and which scorecard cells would have been published as substituted
   * defaults. A failure report that named a network error but not the resulting
   * hole in the panel would answer the wrong question — `brief §2.3` cares about
   * the hole.
   */
  coverage?: ScoreCoverage;
}

/**
 * - `model_call` — the provider failed (timeout, rate limit, 5xx). Retryable.
 * - `schema` — a response did not satisfy `01 §5`'s rules. Retryable: a resample
 *   plausibly comes back well-formed.
 * - `truncated` — a response hit `max_tokens`. NOT retryable; see
 *   `ModelCallErrorCode`.
 * - `incomplete_panel` — the phase's calls came back, but the panel did not cover
 *   every product/metric/juror. `brief §2.3`'s partial success.
 * - `internal` — a bug in the engine. Never retried; retrying a bug spends money
 *   to reproduce it.
 */
export type FailureCode = 'model_call' | 'schema' | 'truncated' | 'incomplete_panel' | 'internal';

/** What one phase cost, whatever its outcome. Failed calls still spent tokens. */
export interface PhaseCost {
  /** Model calls actually made. Zero on a skipped phase — that is the point of skipping. */
  calls: number;
  /**
   * Calls that threw before reporting a `usage` figure, counted inside `calls`.
   *
   * A failed call was still billed for its input, and it reports NO model id — so
   * it leaves no trace in `unpriced_models` and `cost_usd` absorbs it as a
   * silent zero. Without this field a ledger of nothing but failures reads as
   * "every call reported a priced model id" (`measuredCost`'s test for
   * `measured`), and the report would print `MEASURED — $0.00` over a run that
   * spent real money and returned nothing. That is precisely the understatement
   * `PhaseLedger`'s header refuses to allow, and `unpriced_models` alone cannot
   * catch it.
   */
  failed_calls: number;
  usage: TokenUsage;
  cost_usd: number;
  /**
   * Model ids seen in this phase that carry no entry in `MODEL_PRICES`, so
   * `cost_usd` is an UNDERSTATEMENT rather than a total.
   *
   * `callCost` returns 0 for an unknown id instead of throwing, because a call
   * has already been paid for by the time it reaches the ledger and throwing
   * would lose the result of a paid run. This field is the other half of that
   * bargain: without it, a repointed alias or a dated snapshot would book
   * `$0.0000` and a report would print it as fact. `assembleResults` turns a
   * non-empty list into a `meta.warnings` line.
   *
   * Task 9's handoff adapter cannot report a priced model id at all, so every
   * locally-seeded run lands here by construction.
   */
  unpriced_models: string[];
}

interface PhaseResultBase {
  phase: PhaseName;
  cost: PhaseCost;
  /** Non-fatal observations. Surfaced, never swallowed — e.g. a cold prompt cache. */
  warnings: readonly string[];
}

/** The phase ran and every call came back and validated. */
export interface PhaseOk<T> extends PhaseResultBase {
  status: 'ok';
  value: T;
}

/** The phase legitimately did not run. Terminal and SUCCESSFUL (`DECISIONS.md` S11). */
export interface PhaseSkipped extends PhaseResultBase {
  status: 'skipped';
  skipped: SkipReason;
}

/** The phase ran and did not produce a usable result. Never delivered (`brief §2.3`). */
export interface PhaseFailed extends PhaseResultBase {
  status: 'failed';
  failure: PhaseFailure;
}

export type PhaseResult<T> = PhaseOk<T> | PhaseSkipped | PhaseFailed;

// --- Phase payloads -----------------------------------------------------------

/**
 * What the Score phase produces. `coverage` is part of the RESULT, not a private
 * check: `brief §2.3` calls a missing juror row a partial failure, and the only
 * way a consumer can tell a complete panel from a patched one is to be shown the
 * substitutions.
 */
export interface ScorePhaseValue {
  scoreLog: ScoreLogEntry[];
  flaggedInjections: FlaggedInjection[];
  coverage: ScoreCoverage;
  /** How many chunks the products were split into, for the ledger and the report. */
  chunks: number;
}

/**
 * Whether the merit panel actually covered the category.
 *
 * `substituted` mirrors `ScorecardEntry.substituted_roles` (Task 3) exactly,
 * because it is computed with `buildScorecards` over the same score log the board
 * would publish. A non-empty list means the board would print a fabricated
 * `SCORE_CLAMP_DEFAULT` where a juror's opinion should be — which is precisely
 * the degraded verdict `brief §2.3` forbids delivering.
 */
export interface ScoreCoverage {
  complete: boolean;
  /** Jurors on the installed panel that returned nothing at all. */
  missing_roles: string[];
  /** Every (product, metric) cell that would be filled in with a substituted score. */
  substituted: SubstitutedCell[];
  /** Jurors that answered, out of the installed panel's size. */
  jurors_answered: number;
  jurors_expected: number;
}

/** One cell the board would have to publish as a substitution. */
export interface SubstitutedCell {
  product_id: number;
  metric: string;
  roles: string[];
}

/** What the Customer phase produces when it convenes. */
export interface CustomerPhaseValue {
  demandLog: DemandLogEntry[];
  flaggedInjections: FlaggedInjection[];
  /** Clusters with >= 2 members that were put to the panel (`01 §5.3`). */
  sets: number;
}

/** What the Uniqueness phase produces. */
export interface UniquenessPhaseValue {
  uniqueness: UniquenessResult;
  flaggedInjections: FlaggedInjection[];
}

// --- Cost ledger --------------------------------------------------------------

/**
 * The per-phase cost ledger written to `results.json.meta`. `01 §7.3` gives the
 * cost model as a call count only; the dollar figures come from the price table
 * in `src/config/constants.ts`.
 */
export interface CostLedger {
  phases: Record<PhaseName, PhaseCost>;
  total: PhaseCost;
}

/**
 * The versions a persisted phase result was produced under.
 *
 * Every one of these changes what a phase would return, so a stored result that
 * does not match the current run is not a saving — it is a stale answer about to
 * be delivered as fresh:
 *
 * - `category_version` seeds the render order AND the chunk composition
 *   (`src/panels/ordering.ts`), so resuming across a bump silently delivers
 *   chunks the current version would never have produced — breaking the
 *   `orderedChunks` guarantee for that run.
 * - `prompt_version` is the rubric and the mandates (`01 §4` Step 2 says to bump
 *   it on any edit, and `01 §4` Step 2 / `brief §1.3` both exist so a bump
 *   invalidates caches). Resuming across one delivers a board stamped with a
 *   rubric that never produced its scores.
 * - `persona_version` is the customer panel (`01 §4` Step 3, same rule).
 * - `engine_version` is the code that rendered the prompts.
 *
 * `resumePhase` refuses a mismatch and names the version that moved.
 */
export interface PhaseVersions {
  category_version: string;
  prompt_version: string;
  persona_version: string;
  engine_version: string;
}

/**
 * A phase result as it sits on disk: the result, plus the versions it was
 * produced under. The envelope is the file format for
 * `cjr/runs/<slug>/phases/<phase>.json`, whose PATH carries only the slug.
 */
export interface PersistedPhase<T> {
  versions: PhaseVersions;
  result: PhaseResult<T>;
}

/** A dry-run projection. Spends nothing; every number in it is an estimate. */
export interface DryRunProjection {
  category: string;
  products: number;
  chunks: number;
  jurors: number;
  personas: number;
  /** `JUROR_COUNT x chunks + 1 + personas` (`01 §7.3`, with `DECISIONS.md` S1's 6). */
  calls: number;
  phases: DryRunPhase[];
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  /** Assumptions the estimate rests on, printed alongside it. */
  caveats: string[];
}

/** One phase's slice of a projection. */
export interface DryRunPhase {
  phase: PhaseName;
  calls: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
}

// --- Run artifacts ------------------------------------------------------------

/**
 * `cjr/runs/<slug>/results.json` — the Workflow return value of `01 §4` Step 5,
 * `{scoreLog, uniqueness, demand, flaggedInjections, meta}`.
 */
export interface RunResults {
  scoreLog: ScoreLogEntry[];
  uniqueness: (UniquenessResult & { uniqueness_version: string }) | null;
  demand: RunDemand | null;
  flaggedInjections: FlaggedInjection[];
  meta: RunMeta;
}

/** `results.demand` per `01 §4` Step 5. */
export interface RunDemand {
  personas: Persona[];
  demandLog: DemandLogEntry[];
  demand_version: string;
}

/**
 * How a run's raw votes were actually produced.
 *
 * A stored run is an integrity record (`brief` Part 7), and the record is
 * incomplete if it cannot say what answered the panels. Two paths exist and they
 * are not interchangeable: `messages_api` is the priced, `effort`-controlled
 * production path, and `local_subagent` is `01 §1`'s keyless path, where Claude
 * Code subagents answer through `HandoffClient`. The pipeline, the clusters and
 * the discrimination and correlation figures are valid on either; absolute score
 * levels and per-run cost are not comparable across them. The fix-1.1 A/B is
 * valid on neither list: `engine ab` requires an API key, so a `local_subagent`
 * run cannot produce one at all and that gate stays MISSING. `caveat` is the
 * sentence that says so, carried with the run rather than left in a document
 * beside it.
 */
export interface RunSeeding {
  path: 'messages_api' | 'local_subagent';
  caveat: string;
}

/** Everything about the run that is not a vote. */
export interface RunMeta {
  category: string;
  slug: string;
  category_version: string;
  prompt_version: string;
  persona_version: string;
  uniqueness_version: string;
  /** `ok` on a delivered run; `failed` on one that must be retried and not shown. */
  outcome: 'delivered' | 'failed';
  phases: Record<PhaseName, PhaseSummary>;
  ledger: CostLedger;
  coverage: ScoreCoverage;
  warnings: string[];
  /** The engine's own build identity, so a stored run says what produced it. */
  engine_version: string;
  /**
   * How the votes were produced. Absent on runs written before Task 9, which
   * were all `messages_api` by construction — there was no other path.
   */
  seeding?: RunSeeding;
}

/** A phase's outcome as recorded in `meta`, with the payload stripped. */
export interface PhaseSummary {
  status: 'ok' | 'skipped' | 'failed';
  skipped?: SkipReason;
  failure?: PhaseFailure;
  cost: PhaseCost;
  warnings: readonly string[];
}

/**
 * What `runCategory` returns.
 *
 * `delivered` carries a `Ranking`; `failed` deliberately does not. A caller
 * cannot accidentally render a degraded verdict, because on the failure arm there
 * is no verdict to render — `brief §2.3`'s "never deliver a degraded verdict" is
 * enforced by the type rather than by a rule someone has to remember.
 */
export type RunOutcome =
  | {
      status: 'delivered';
      results: RunResults;
      ranking: Ranking;
    }
  | {
      status: 'failed';
      /** True when every failure is retryable, i.e. the retry is FREE (`brief §2.3`). */
      retryable: boolean;
      failures: PhaseFailure[];
      /** Persisted so far. A retry re-runs only the failed phases.  */
      results: RunResults;
    };
