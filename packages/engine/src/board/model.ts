/**
 * The projection the preview board renders.
 *
 * `ranking.json` (`01 §6.6`) is the integrity record: it carries every juror's
 * deduction, every persona's pick, the whole cluster roster. The board reads a
 * subset of that, and this module is the one place that says which subset — so
 * the page template below never reaches into a `RankedProduct` directly and the
 * embedded payload stays a deliberate list of fields rather than "the whole run,
 * whatever that happens to contain today".
 *
 * Two derived numbers live here rather than in the template, because both are
 * claims about the data and need to be stated once, next to their definition:
 *
 * 1. **`cuts`** — `100 - mean(metric score)`. `brief` Part 5 fixes the connective
 *    word: everyone walks in at 100, and this is what came off. It is NOT the sum
 *    of the ledger's points: those are per-juror deductions off each juror's own
 *    100, and six jurors cutting 20 each for the same omission is one 20-point
 *    cut on the merged scorecard, not 120. The page says so in its legend.
 * 2. **`headline`** — the single largest deduction anywhere on the scorecard.
 *    `brief` Part 6 wants the collapsed row to read as a reason rather than a
 *    leaderboard entry, so one real sentence from one named juror rides on the
 *    row itself and the numbers stay small beside it.
 *
 * Nothing here re-ranks, re-weights or re-derives a score. Global Constraint 1
 * and `01 §2` put the arithmetic in `src/rank/`; this file only reads it back.
 */

import type { CategoryType, FlaggedInjection, Ranking, RankedProduct } from '../types.js';

/** One juror's deduction as the board shows it. */
export interface BoardDeduction {
  points: number;
  reason: string;
  /** The juror who took it. `01 §6.6` tags every merged deduction with its role. */
  role: string;
  /** The metric it came off, carried so the headline cut can name it. */
  metric: string;
}

/** One metric row of the expanded ledger. */
export interface BoardMetric {
  metric: string;
  /** Cross-juror mean, 0-100. */
  score: number;
  /** Cross-juror population std — how much the six disagreed. */
  spread: number;
  /** `100 - score`; the width of the lost half of the bar. */
  cuts: number;
  jurors: number;
  /** Jurors who returned nothing and were substituted a 50 (`01 §6.6`). */
  substituted: string[];
  deductions: BoardDeduction[];
}

/** One persona's forced choice, from `demand_detail.picks` (`01 §6.2`). */
export interface BoardPick {
  persona: string;
  pick: 'first' | 'second';
  strength?: number;
  reason: string;
}

/** The Floor's arithmetic for one product, when the Floor convened at all. */
export interface BoardDemand {
  demand: number;
  breadth: number;
  intensity: number;
  capture: number;
  share: number;
  picks: BoardPick[];
}

/** One row of the board. */
export interface BoardRow {
  rank: number;
  name: string;
  url: string;
  /** `100 - mean(metric score)`. See the module comment. */
  cuts: number;
  /** Pure merit composite, before the blend. */
  composite: number;
  /** The blended score the row is ranked by. */
  core: number;
  demand?: number;
  /** `solo_cluster` means the Floor never convened for this product. */
  soloCluster: boolean;
  /** Demand or scarcity moved this row off its pure-merit position. */
  tiebroken: boolean;
  /** The largest single deduction on the scorecard, or `null` if nothing was cut. */
  headline: BoardDeduction | null;
  /** Ledger rows, heaviest loss first. */
  metrics: BoardMetric[];
  cluster: { id: string; label: string; size: number; uniqueness: number; reason: string };
  demandDetail?: BoardDemand;
  /** Injection-alarm hits on this product's own reasons (`01 §8`, logged not dropped). */
  flagged: { source: string; reason: string; matched: string }[];
}

/** One category's whole board. */
export interface Board {
  slug: string;
  category: string;
  type: CategoryType;
  rows: BoardRow[];
  productCount: number;
  soloCount: number;
  tiebrokenCount: number;
  flaggedCount: number;
  promptVersion: string;
  demandVersion: string;
  uniquenessVersion: string;
  weights: { merit: number; demand: number; uniqueness_lambda: number };
  metrics: { name: string; description: string }[];
  personas: string[];
  clusters: { label: string; size: number }[];
  health: {
    discrimination: number;
    demand_discrimination: number;
    avg_metric_spread: number;
    tiebreak_count: number;
  };
  /** ISO mtime of `ranking.json` — when this board was last rebuilt. */
  rankedAt: string;
  /**
   * `results.json` `meta.seeding.caveat`. Absent only if the run predates the
   * field; the page says so loudly rather than rendering a clean footer.
   */
  caveat?: string;
}

/** The whole payload the page embeds. */
export interface BoardPayload {
  boards: Board[];
  /** When the server read the files — not when the ranking was produced. */
  readAt: string;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function projectRow(row: RankedProduct, flagsById: Map<number, FlaggedInjection[]>): BoardRow {
  const metrics: BoardMetric[] = row.scorecard.map((entry) => ({
    metric: entry.metric,
    score: entry.score,
    spread: entry.spread,
    cuts: 100 - entry.score,
    jurors: entry.juror_count,
    substituted: entry.substituted_roles,
    deductions: [...entry.deductions]
      .map((deduction) => ({
        points: deduction.points,
        reason: deduction.reason,
        role: deduction.role,
        metric: entry.metric,
      }))
      .sort((a, b) => b.points - a.points),
  }));

  // The heaviest cut anywhere on the card, before the ledger is re-sorted.
  const headline =
    metrics
      .flatMap((entry) => entry.deductions)
      .sort((a, b) => b.points - a.points)
      .at(0) ?? null;

  return {
    rank: row.rank,
    name: row.name,
    url: row.url,
    cuts: 100 - mean(row.scorecard.map((entry) => entry.score)),
    composite: row.composite,
    core: row.core,
    ...(row.demand === undefined ? {} : { demand: row.demand }),
    soloCluster: row.demand_status === 'solo_cluster',
    tiebroken: row.tiebroken,
    headline,
    // Heaviest loss first: the ledger opens on the metric that cost the most.
    metrics: metrics.sort((a, b) => b.cuts - a.cuts),
    cluster: {
      id: row.cluster.id,
      label: row.cluster.label,
      size: row.cluster.size,
      uniqueness: row.cluster.uniqueness,
      reason: row.cluster.reason,
    },
    ...(row.demand_detail === undefined
      ? {}
      : {
          demandDetail: {
            demand: row.demand_detail.demand,
            breadth: row.demand_detail.breadth,
            intensity: row.demand_detail.intensity,
            capture: row.demand_detail.capture,
            share: row.demand_detail.share,
            picks: row.demand_detail.picks.map((pick) => ({
              persona: pick.persona,
              pick: pick.pick,
              ...(pick.strength === undefined ? {} : { strength: pick.strength }),
              reason: pick.reason,
            })),
          },
        }),
    flagged: (flagsById.get(row.id) ?? []).map((flag) => ({
      source: flag.source,
      reason: flag.reason,
      matched: flag.matched,
    })),
  };
}

/** Project one stored `ranking.json` into the shape the page renders. */
export function toBoard(slug: string, ranking: Ranking, extra: { rankedAt: string; caveat?: string }): Board {
  const flagsById = new Map<number, FlaggedInjection[]>();
  for (const flag of ranking.flaggedInjections) {
    if (flag.product_id === undefined) continue;
    const bucket = flagsById.get(flag.product_id);
    if (bucket === undefined) flagsById.set(flag.product_id, [flag]);
    else bucket.push(flag);
  }

  const rows = ranking.ranking.map((row) => projectRow(row, flagsById));

  return {
    slug,
    category: ranking.category,
    type: ranking.type,
    rows,
    productCount: rows.length,
    soloCount: rows.filter((row) => row.soloCluster).length,
    tiebrokenCount: rows.filter((row) => row.tiebroken).length,
    flaggedCount: ranking.flaggedInjections.length,
    promptVersion: ranking.prompt_version,
    demandVersion: ranking.demand_version,
    uniquenessVersion: ranking.uniqueness_version,
    weights: ranking.weights,
    metrics: ranking.metrics.map((metric) => ({ name: metric.name, description: metric.description })),
    personas: ranking.personas.map((persona) => persona.name),
    clusters: ranking.clusters.map((cluster) => ({ label: cluster.label, size: cluster.size })),
    health: {
      discrimination: ranking.health.discrimination,
      demand_discrimination: ranking.health.demand_discrimination,
      avg_metric_spread: ranking.health.avg_metric_spread,
      tiebreak_count: ranking.health.tiebreak_count,
    },
    rankedAt: extra.rankedAt,
    ...(extra.caveat === undefined ? {} : { caveat: extra.caveat }),
  };
}
