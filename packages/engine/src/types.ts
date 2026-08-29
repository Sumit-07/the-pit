/**
 * Data shapes for the ranking engine.
 *
 * Sources: `01-skill-reference.md` §5 (panel output schemas), §4 Step 1
 * (products), §4 Steps 2-3 (metrics, personas), §6.2 (demand detail),
 * §6.5 (health), §6.6 (`ranking.json`), §8 (flagged injections).
 *
 * These are the shapes only. All arithmetic lives in `src/rank/` (Task 3);
 * no ranking value is ever produced by a model (Global Constraint 1).
 */

/** Category archetype from the jury generation pass. Source: `01 §4` Step 2 (`validate_jury`). */
export type CategoryType = 'b2b' | 'consumer' | 'prosumer';

/** Persona price sensitivity. Source: `01 §4` Step 3 (`validate_personas`). */
export type PriceSensitivity = 'low' | 'medium' | 'high';

/**
 * Cluster identifier as returned by the uniqueness pass.
 * `01` does not pin the primitive type; the prompt and schema (Task 5) emit strings.
 */
export type ClusterId = string;

// --- Ingest -------------------------------------------------------------------

/**
 * One usable product in a category. Source: `01 §4` Step 1.
 * `id` is a 0-based index into the usable rows; `orig_rank` is the sheet's
 * `Rank` column parsed as an integer.
 */
export interface Product {
  id: number;
  name: string;
  description: string;
  /** The sheet's `Website URL`, trimmed but otherwise verbatim. */
  url: string;
  /**
   * `url` reduced to its identity by `normalizeUrl` (`brief §2.5`): the key the
   * per-product submission cap is meant to hang off. Shortener resolution, the
   * one §2.5 rule not applied here, is out of scope for Phase 1
   * (`docs/plans/phase-1-engine.md` Task 2) and deferred to Phase 3.
   */
  normalized_url: string;
  orig_rank: number;
}

/**
 * Every usable product in one category — the `products.json` artifact of
 * `01 §4` Step 1, and the input Task 7's pipeline is handed.
 */
export interface ProductSet {
  category: string;
  products: Product[];
}

// --- Merit jury output (`SCORE_SCHEMA`, `01 §5.1`) -----------------------------

/**
 * One deduction taken off a metric's starting 100.
 * Deductions for a metric must sum to exactly `100 - score`. Source: `01 §5.1`.
 */
export interface Deduction {
  points: number;
  reason: string;
}

/** One juror's 0-100 score for one product on one metric. Source: `01 §5.1`. */
export interface MetricScore {
  name: string;
  score: number;
  deductions: Deduction[];
}

/**
 * One juror's scores for one product, i.e. an element of `SCORE_SCHEMA.scores`.
 * Source: `01 §5.1`. Juror attribution lives on the enclosing score-log entry.
 */
export interface ScoreRow {
  id: number;
  note?: string;
  metrics: MetricScore[];
}

// --- Uniqueness / clustering output (`UNIQ_SCHEMA`, `01 §5.2`) -----------------

/** A group of products whose core idea is essentially the same. Source: `01 §5.2`. */
export interface Cluster {
  cluster_id: ClusterId;
  label: string;
  member_ids: number[];
}

/**
 * Per-product scarcity verdict. `uniqueness_score` is 0-100 scarcity, not quality
 * (100 = rare/novel, 50 = familiar with a few peers, 0 = crowded commodity).
 * Source: `01 §5.2`.
 */
export interface UniquenessProduct {
  id: number;
  uniqueness_score: number;
  cluster_id: ClusterId;
  reason: string;
}

/** The whole uniqueness pass result. Source: `01 §5.2` (`UNIQ_SCHEMA`). */
export interface UniquenessResult {
  clusters: Cluster[];
  products: UniquenessProduct[];
}

// --- Customer-demand output (`CHOICE_SCHEMA`, `01 §5.3`) -----------------------

/**
 * One persona's forced choice within one cluster. `cluster_id` and `reason` are
 * required; `none: true` means nothing in the set was worth adopting.
 * Source: `01 §5.3`.
 */
export interface DemandChoice {
  cluster_id: ClusterId;
  first_pick?: number;
  second_pick?: number;
  strength?: number;
  reason: string;
  none?: boolean;
}

// --- Panels -------------------------------------------------------------------

/**
 * A rubric metric as carried in `ranking.json`. Source: `01 §6.6`.
 * The installed jury rubric additionally carries the four anchors (`01 §4` Step 2);
 * that shape belongs to jury generation (Task 6).
 */
export interface Metric {
  name: string;
  description: string;
}

/** A synthetic buyer on the customer-demand panel. Source: `01 §4` Step 3. */
export interface Persona {
  name: string;
  description: string;
  needs: string[];
  price_sensitivity: PriceSensitivity;
}

// --- Ranking output (`01 §6.2`, §6.5, §6.6) ------------------------------------

/** One persona's contribution to a product's demand. Source: `01 §6.2` (`detail.picks`). */
export interface DemandPick {
  persona: string;
  /** Whether this persona ranked the product first or runner-up. */
  pick: 'first' | 'second';
  /** Conviction behind the persona's first pick; absent on a runner-up entry. */
  strength?: number;
  reason: string;
}

/** The per-product demand breakdown. Source: `01 §6.2` (`reduce_demand` detail). */
export interface DemandDetail {
  demand: number;
  breadth: number;
  intensity: number;
  capture: number;
  share: number;
  picks: DemandPick[];
}

/** A deduction on the merged scorecard, tagged with the juror role that took it. Source: `01 §6.6`. */
export interface ScorecardDeduction extends Deduction {
  role: string;
}

/** One metric row of a product's merged scorecard. Source: `01 §6.6`. */
export interface ScorecardEntry {
  metric: string;
  /** Cross-juror mean of the raw 0-100 scores. */
  score: number;
  /** Cross-juror population std of the raw 0-100 scores. */
  spread: number;
  deductions: ScorecardDeduction[];
}

/** The cluster a ranked product sits in, as embedded in its row. Source: `01 §6.6`. */
export interface RankedProductCluster {
  id: ClusterId;
  label: string;
  size: number;
  uniqueness: number;
  reason: string;
}

/**
 * One row of `ranking.ranking`. Source: `01 §6.6`.
 * `demand` and `demand_detail` are absent for a product with no demand entry
 * (solo cluster, or a cluster the panel skipped) — see `01 §6.2`.
 */
export interface RankedProduct {
  id: number;
  name: string;
  url: string;
  rank: number;
  /** Pure merit composite. */
  composite: number;
  /** Reduced `demand_raw`. */
  demand?: number;
  /** The blended score the row is ranked by. */
  core: number;
  /** True when demand + uniqueness moved the row off its pure-merit position. */
  tiebroken: boolean;
  scorecard: ScorecardEntry[];
  cluster: RankedProductCluster;
  demand_detail?: DemandDetail;
}

/** Cluster summary in `ranking.clusters`, sorted by size. Source: `01 §6.6`. */
export interface ClusterSummary {
  cluster_id: ClusterId;
  label: string;
  size: number;
}

/** Panel-quality statistics. Source: `01 §6.5`. */
export interface Health {
  /** Mean over (product, metric) of the cross-juror population std of raw scores. */
  avg_metric_spread: number;
  /** Population std of the merit composites; the board flags `< 0.5`. */
  discrimination: number;
  /** Population std of `demand_raw`. */
  demand_discrimination: number;
  /** Count of products whose final rank differs from their pure-merit rank. */
  tiebreak_count: number;
}

/**
 * A reason that matched the output injection alarm. Source: `01 §8`.
 * The alarm logs only and never gates delivery (`DECISIONS.md S9`).
 */
export interface FlaggedInjection {
  /** Juror `role`, or `"uniqueness"`, or `"demand"`. */
  source: string;
  /** The reason text that matched. */
  reason: string;
  /** The substring the regex matched. */
  matched: string;
  product_id?: number;
}

/** The blend weights echoed into `ranking.json`. Source: `01 §6.6`. */
export interface RankingWeights {
  merit: number;
  demand: number;
  uniqueness_lambda: number;
}

/** The whole `ranking.json` document the board reads. Source: `01 §6.6`. */
export interface Ranking {
  category: string;
  prompt_version: string;
  uniqueness_version: string;
  demand_version: string;
  type: CategoryType;
  weights: RankingWeights;
  personas: Persona[];
  metrics: Metric[];
  clusters: ClusterSummary[];
  ranking: RankedProduct[];
  health: Health;
  flaggedInjections: FlaggedInjection[];
}
