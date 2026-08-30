/**
 * The projection the public boards render.
 *
 * A port of `packages/engine/src/board/page.ts`'s companion, `board/model.ts` —
 * the working renderer this repo already had over the same seeded data. The
 * engine does not export it (`packages/engine/src/index.ts` re-exports config,
 * ingest, model, panels, rank, report, run and types, and not `board/`), and
 * `packages/engine/src/` is another agent's file right now, so the shape is
 * restated here rather than reached into. The *decisions* are the engine's and
 * are kept identical on purpose: a board and a preview board that disagreed about
 * what "cuts" means would be two answers to the integrity question.
 *
 * ## What is derived here, and why only these
 *
 * Nothing in this file ranks, re-weights or re-derives a score. `01 §2` and the
 * plan's Global Constraint 1 put the arithmetic in `packages/engine/src/rank/`
 * and it stays there; `brief §1.2` moves every z-score on every placement, and a
 * second place that computed board numbers would be a second thing to keep in
 * step. Two numbers are derived, and both are presentation claims about data the
 * ranking already holds:
 *
 * 1. **`cuts`** — `100 - mean(metric score)`. `brief` Part 5 fixes the connective
 *    word: everyone walks in at 100, and this is what came off. It is **not** the
 *    sum of the ledger's points. Those are per-juror deductions off each juror's
 *    own 100, so six jurors each cutting 20 for the same omission is one 20-point
 *    cut on the merged scorecard, not 120. The board says so in its legend, in
 *    words, because the arithmetic is not guessable from the page.
 *
 *    **`health`** is the same number said the other way round — `100 - cuts`,
 *    i.e. `mean(metric score)` — and it is what the surfaces now lead with. Not a
 *    second derivation: one subtraction, stated once here rather than inline in
 *    four components that were each already doing it to caption the meter. See
 *    `copy.ts`'s `HEALTH_NOTE` for the one thing this number must never be
 *    allowed to imply.
 * 2. **`headline`** — the single largest deduction anywhere on the scorecard,
 *    with the juror who took it. `brief` Part 6: "Lead with deductions and
 *    reasons, not composites." So one real sentence from one named juror rides on
 *    the collapsed row and the composites are small mono numbers beside it.
 *
 * ## Ordering is a claim too
 *
 * Ledger metrics are sorted heaviest-loss-first, and deductions within a metric
 * heaviest-first, so a reader who opens a row meets the most expensive thing
 * first. Rows themselves are left in the ranking's own order and are never
 * re-sorted — the board's order is the engine's answer, not the page's.
 */

import type { FlaggedInjection, Ranking, RankedProduct } from '@the-pit/engine';

import { SOLO_NOTE } from './copy';
import type { BoardDocument } from './source';

/** One juror's deduction, as the board shows it: points, reason, and who took it. */
export interface DeductionView {
  points: number;
  reason: string;
  /** The juror. `01 §6.6` tags every merged deduction with its role, and the board never drops it. */
  role: string;
  /** The metric it came off, carried so a headline cut can name where it landed. */
  metric: string;
}

/** One metric row of the expanded ledger. */
export interface MetricView {
  metric: string;
  /** Cross-juror mean, 0-100. */
  score: number;
  /** Cross-juror population std — how far apart the six were. */
  spread: number;
  /** `100 - score`; the lost half of the bar. */
  cuts: number;
  jurors: number;
  /** Jurors who returned nothing and were substituted a 50 (`01 §6.6`). Named, never hidden. */
  substituted: string[];
  deductions: DeductionView[];
}

/** One persona's forced choice inside the cluster (`01 §6.2`). */
export interface PickView {
  persona: string;
  pick: 'first' | 'second';
  strength?: number;
  reason: string;
}

/** The Floor's arithmetic, when the Floor convened at all. */
export interface DemandView {
  demand: number;
  breadth: number;
  intensity: number;
  capture: number;
  share: number;
  picks: PickView[];
}

/** One row of a board. */
export interface RowView {
  rank: number;
  name: string;
  url: string;
  /**
   * This row's own verdict page, as a path that RESOLVES to one rather than a
   * path that is one.
   *
   * `verdicts.public_slug` is a hash of a deterministic uuid, held in
   * `@the-pit/db`. A board view cannot look it up and must not re-derive it:
   * `test/boards-read-path.test.ts` keeps the database package off the graph of
   * every public board route — a board is a CDN snapshot and loading a driver to
   * render one is the thing that rule exists to prevent — and a second
   * implementation of a permanent public URL would be worse than no link at all.
   *
   * So the board names the two things it legitimately knows, its category and the
   * engine's product id, and `app/v/of/[category]/[product]` turns that into the
   * verdict's own URL with a redirect. The resolver is also where
   * `DECISIONS.md` S8 will land when it settles what a re-pitch does to an older
   * verdict URL: the board keeps pointing at the product, and the redirect
   * decides which of its verdicts that means.
   */
  verdictHref?: string;
  /** Only `http(s)` survives; anything else is printed as text and never as an href. */
  href?: string;
  /** `100 - mean(metric score)`. See the module comment. */
  cuts: number;
  /**
   * `100 - cuts` — what the card walked out with, out of the hundred it walked
   * in with. The number the boards lead with; `cuts` is the same fact inverted
   * and stays on every surface as the connective word (`brief` Part 5).
   */
  health: number;
  /** Pure merit composite, before the blend. Secondary, by `brief` Part 6. */
  composite: number;
  /** The blended score the row is ranked by. */
  core: number;
  demand?: number;
  /**
   * The Floor never convened, because the cluster holds one product.
   * `brief §1.6`: a stated property of the board, not an error state.
   */
  soloCluster: boolean;
  /** Demand or scarcity moved this row off its pure-merit position. */
  tiebroken: boolean;
  /** The heaviest single cut on the card, or `null` when nothing came off. */
  headline: DeductionView | null;
  /** How many cuts the ledger holds in total, across every metric. */
  deductionCount: number;
  metrics: MetricView[];
  cluster: { id: string; label: string; size: number; uniqueness: number; reason: string };
  demandDetail?: DemandView;
  /** Injection-alarm hits on this product's own reasons (`01 §8`): logged, never dropped. */
  flagged: { source: string; reason: string; matched: string }[];
  /** The sentence a solo row carries, so the mark always arrives with its explanation. */
  soloNote?: string;
}

/** One whole category board, ready to render. */
export interface BoardView {
  slug: string;
  category: string;
  type: string;
  rows: RowView[];
  productCount: number;
  soloCount: number;
  tiebrokenCount: number;
  flaggedCount: number;
  clusterCount: number;
  metricNames: string[];
  personas: string[];
  promptVersion: string;
  demandVersion: string;
  uniquenessVersion: string;
  categoryVersion: string;
  engineVersion?: string;
  weights: { merit: number; demand: number; uniqueness_lambda: number };
  health: {
    discrimination: number;
    demand_discrimination: number;
    avg_metric_spread: number;
    tiebreak_count: number;
  };
  /** ISO-8601. `brief` Part 5: the surface is timestamped because the board moves. */
  generatedAt: string;
  origin: BoardDocument['origin'];
  caveat?: string;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Only `http(s)` becomes a link.
 *
 * Product URLs are user-submitted (`brief §2.5` normalizes them, and evasion is
 * flagged rather than blocked), so `javascript:` and `data:` must never reach an
 * `href`. A rejected URL is still shown — as text, so a reader can see what was
 * submitted.
 */
function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function projectRow(
  row: RankedProduct,
  flagsById: Map<number, FlaggedInjection[]>,
  categorySlug: string,
): RowView {
  const metrics: MetricView[] = row.scorecard.map((entry) => ({
    metric: entry.metric,
    score: entry.score,
    spread: entry.spread,
    cuts: 100 - entry.score,
    jurors: entry.juror_count,
    substituted: [...entry.substituted_roles],
    deductions: [...entry.deductions]
      .map((deduction) => ({
        points: deduction.points,
        reason: deduction.reason,
        role: deduction.role,
        metric: entry.metric,
      }))
      // Heaviest first: the reason that cost the most is the one worth reading.
      .sort((a, b) => b.points - a.points),
  }));

  const allDeductions = metrics.flatMap((entry) => entry.deductions);
  // The heaviest cut anywhere on the card, chosen before the ledger is re-sorted.
  const headline = [...allDeductions].sort((a, b) => b.points - a.points).at(0) ?? null;
  const soloCluster = row.demand_status === 'solo_cluster';
  const href = safeHref(row.url);
  const cuts = 100 - mean(row.scorecard.map((entry) => entry.score));

  return {
    rank: row.rank,
    name: row.name,
    url: row.url,
    ...(categorySlug === ''
      ? {}
      : { verdictHref: `/v/of/${encodeURIComponent(categorySlug)}/${encodeURIComponent(String(row.id))}` }),
    ...(href === undefined ? {} : { href }),
    cuts,
    health: 100 - cuts,
    composite: row.composite,
    core: row.core,
    ...(row.demand === undefined ? {} : { demand: row.demand }),
    soloCluster,
    tiebroken: row.tiebroken,
    headline,
    deductionCount: allDeductions.length,
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
    // The mark and the explanation are one field, so no surface can render the
    // solo mark without the sentence that says what it means.
    ...(soloCluster ? { soloNote: `${row.cluster.label} is a cluster of one — ${SOLO_NOTE}.` } : {}),
  };
}

/** Project one stored board document into the shape the surfaces render. */
export function toBoardView(document_: BoardDocument): BoardView {
  const ranking: Ranking = document_.ranking;

  const flagsById = new Map<number, FlaggedInjection[]>();
  for (const flag of ranking.flaggedInjections) {
    if (flag.product_id === undefined) continue;
    const bucket = flagsById.get(flag.product_id);
    if (bucket === undefined) flagsById.set(flag.product_id, [flag]);
    else bucket.push(flag);
  }

  const rows = ranking.ranking.map((row) => projectRow(row, flagsById, document_.slug));

  return {
    slug: document_.slug,
    category: ranking.category,
    type: ranking.type,
    rows,
    productCount: rows.length,
    soloCount: rows.filter((row) => row.soloCluster).length,
    tiebrokenCount: rows.filter((row) => row.tiebroken).length,
    flaggedCount: ranking.flaggedInjections.length,
    clusterCount: ranking.clusters.length,
    metricNames: ranking.metrics.map((metric) => metric.name),
    personas: ranking.personas.map((persona) => persona.name),
    promptVersion: ranking.prompt_version,
    demandVersion: ranking.demand_version,
    uniquenessVersion: ranking.uniqueness_version,
    categoryVersion: document_.categoryVersion,
    ...(document_.engineVersion === undefined ? {} : { engineVersion: document_.engineVersion }),
    weights: ranking.weights,
    health: {
      discrimination: ranking.health.discrimination,
      demand_discrimination: ranking.health.demand_discrimination,
      avg_metric_spread: ranking.health.avg_metric_spread,
      tiebreak_count: ranking.health.tiebreak_count,
    },
    generatedAt: document_.generatedAt,
    origin: document_.origin,
    ...(document_.caveat === undefined ? {} : { caveat: document_.caveat }),
  };
}

/**
 * A metric name, made readable.
 *
 * Names come from the installed jury and are not written for a reader: Developer
 * Tools has "Problem Sharpness", another category may have `claim_backing`. This
 * is a display transform only — the raw name stays in a `title` attribute and
 * nothing downstream ever sees the prettified form.
 */
export function metricLabel(name: string): string {
  const text = name.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Fixed-width helpers. Boards are read in columns; ragged decimals are unreadable. */
export function n2(value: number): string {
  return value.toFixed(2);
}

export function n1(value: number): string {
  return value.toFixed(1);
}

export function rank2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A UTC stamp, formatted without `Intl`.
 *
 * The board is prerendered on the server and hydrated in a browser in another
 * timezone; a locale-formatted date would differ between the two and React would
 * report a hydration mismatch on every board. UTC, spelled out, is also what the
 * verdict card carries, so the two surfaces agree.
 */
export function stampUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * How dark a row sits.
 *
 * `brief` Part 6: "Rows darken as they descend (the pit is literal)." 0 at the
 * surface, 1 at the bottom. The value is a CSS custom property on the row and the
 * overlay is what daylight is left.
 */
export function depthOf(index: number, total: number): string {
  if (total <= 1) return '0';
  return (index / (total - 1)).toFixed(3);
}
