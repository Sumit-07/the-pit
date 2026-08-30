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

import { redactRanking } from '@/lib/anon';

import { SOLO_NOTE } from './copy';
import { emptyFaviconIndex, faviconClass, faviconCss, faviconInitial, type FaviconIndex, type StoredFavicon } from './favicon';
import { productIdentity } from './identity';
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
  /**
   * What the row is called.
   *
   * On an anonymous listing this is the DESIGNATION — `Unit Kilo-427` — and the
   * real name is not present anywhere on this object, because `source.ts`
   * redacted the document before it was projected. There is no second field
   * holding the true name that a careless surface could reach for.
   */
  name: string;
  /** The submitted address, or `''` on an anonymous listing, which withholds it. */
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
  /**
   * The class that paints this row's favicon, from the board's own `iconCss`.
   *
   * A class and not a `data:` URL, because a URL passed as a prop is written
   * into the page twice — see `faviconClass` in `favicon.ts`. Absent means one
   * of two very different things, and the row draws a different mark for each:
   * the product is anonymous (see `anonymous` below), or nothing usable was
   * found at its site, which is the ORDINARY outcome for roughly a third of any
   * board.
   *
   * **Never present on an anonymous row.** That is enforced in `projectRow`
   * rather than in a component, so no surface can leak an identity it was never
   * given. `lib/boards/identity.ts` says why a favicon is an identity.
   */
  iconClass?: string;
  /**
   * This product withheld its name, its URL and its face at submission.
   *
   * Carried on the row so a surface renders the robot rather than inferring
   * anonymity from a missing icon — those are different states and only one of
   * them is a choice the product made.
   *
   * **This is the flag that decides the identity slot**, and by the time a
   * surface sees it the decision has already been enforced in the data: `name`
   * is the designation, `url` and `href` are absent, and `iconClass` was never
   * attached. There is nothing left for a component to leak.
   */
  anonymous: boolean;
  /**
   * The deterministic input to the robot generator. Present only when `anonymous`.
   *
   * The DESIGNATION — `Unit Kilo-427` — not the engine id. `lib/boards/identity.ts`
   * says why: it is what `verdicts.payload` freezes, so a shared verdict link
   * keeps the avatar it was delivered with, and it keeps the picture and the name
   * on one derivation chain so they cannot disagree about whose row this is.
   *
   * The seed and not the finished SVG, because a board carries up to forty of
   * these and the markup would otherwise be serialized into the page twice —
   * once in the HTML and again in the RSC payload. The same reasoning
   * `favicon.ts` gives for passing a class rather than a `data:` URL.
   */
  robotSeed?: string;
  /**
   * The letter a NAMED row shows when it has no icon.
   *
   * Always present. The fallback is not conditional data a surface has to go and
   * derive — it is the row's own mark, computed once here beside everything else
   * the row renders, so no component can render the gutter with nothing to put
   * in it.
   */
  mark: string;
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
  /**
   * Every distinct favicon on this board, as one block of CSS.
   *
   * Rendered into a single `<style>` element by the surface. This is the
   * board's icon "sprite": one document, no extra request, each icon's bytes
   * written exactly once however many rows wear them. `faviconClass` in
   * `favicon.ts` carries the measurement that made this the shape rather than
   * a `data:` URL on every row.
   *
   * Empty when no row on the board has an icon, which is a normal state.
   */
  iconCss: string;
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
  anonymousIds: ReadonlySet<number>,
  favicons: FaviconIndex,
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
  const identity = productIdentity(row, anonymousIds);
  const anonymous = identity.kind === 'anonymous';
  // An anonymous listing has no address to link to, and `row.url` is already `''`
  // by the time this runs — `source.ts` redacted the document. `safeHref` is
  // skipped rather than relied on: the rule is that an anonymous row NEVER
  // produces an href, and stating it here means it does not depend on the
  // redaction upstream having been thorough.
  const href = anonymous ? undefined : safeHref(row.url);
  // The one place a favicon is allowed to reach a board row. An anonymous
  // product does not get one — not a blurred one, not a generic one, none — and
  // it is decided here rather than in a component so that the icon is simply not
  // in the data a surface receives. `lib/boards/identity.ts` says why.
  //
  // Keyed by the URL the ranking spells, which is the product's identity. A
  // re-rank renumbers rows; it does not rename products. An anonymous row's
  // `url` is `''`, so even this lookup has nothing to find.
  const icon = anonymous ? undefined : favicons.icons[row.url];
  const cuts = 100 - mean(row.scorecard.map((entry) => entry.score));

  return {
    rank: row.rank,
    name: row.name,
    url: anonymous ? '' : row.url,
    ...(categorySlug === ''
      ? {}
      : { verdictHref: `/v/of/${encodeURIComponent(categorySlug)}/${encodeURIComponent(String(row.id))}` }),
    ...(href === undefined ? {} : { href }),
    ...(icon === undefined ? {} : { iconClass: faviconClass(icon) }),
    anonymous: identity.kind === 'anonymous',
    ...(identity.kind === 'anonymous' ? { robotSeed: identity.seed } : {}),
    mark: faviconInitial(row.name),
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

/**
 * Project one stored board document into the shape the surfaces render.
 *
 * ## The redaction happens here, at the projection
 *
 * Not in a component, and not left to whoever assembled the document. `RowView`
 * is the only thing every board surface sees — the category board, the homepage,
 * the ticker, and whatever is written next year — so removing an anonymous
 * listing's identity here means no surface can render one, because no surface is
 * ever handed one. That is the same rule the favicon follows one field down, for
 * the same reason: an icon or a name that is present in the data and merely not
 * drawn is a leak that renders correctly, which is the worst kind.
 *
 * `redactRanking` is idempotent, so running it over a document `source.ts` or
 * `buildSnapshot` already cleaned is a no-op that re-derives the same
 * designations. The cost of the extra pass is a clone of a document already in
 * memory; the cost of assuming it was done upstream is a name on a page that paid
 * not to have one.
 */
export function toBoardView(document_: BoardDocument): BoardView {
  const ranking: Ranking = redactRanking(document_.ranking, document_.anonymousIds, document_.slug);

  const flagsById = new Map<number, FlaggedInjection[]>();
  for (const flag of ranking.flaggedInjections) {
    if (flag.product_id === undefined) continue;
    const bucket = flagsById.get(flag.product_id);
    if (bucket === undefined) flagsById.set(flag.product_id, [flag]);
    else bucket.push(flag);
  }

  const anonymousIds = new Set(document_.anonymousIds);

  // A document with no index is a category whose backfill has not run: every row
  // draws its fallback mark, which is a state the surfaces are built for.
  const favicons = document_.favicons ?? emptyFaviconIndex(document_.slug);

  const rows = ranking.ranking.map((row) =>
    projectRow(row, flagsById, document_.slug, anonymousIds, favicons),
  );

  // One rule per DISTINCT icon actually on the board, built from the rows rather
  // than from the whole index: a stored icon whose product is anonymous, or
  // whose product has since left the category, must not put its bytes on a page
  // that will never draw them.
  const drawn = new Map<string, StoredFavicon>();
  for (const row of rows) {
    if (row.iconClass === undefined) continue;
    const icon = favicons.icons[row.url];
    if (icon !== undefined) drawn.set(row.iconClass, icon);
  }

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
    iconCss: faviconCss([...drawn.values()]),
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
