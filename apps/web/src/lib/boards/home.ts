/**
 * What the homepage actually needs, which is much less than a board.
 *
 * The homepage rotates every category on a 7-second timer, so every board it can
 * show has to be in the browser before the first switch — a fetch on rotation
 * would make the surface depend on a network round trip that `brief` Part 3 says
 * a board read must not have. Two seeded categories are 48 and 44 products with
 * their full ledgers; serialising all of that into the client payload to display
 * eight rows of it would be several hundred kilobytes of deduction text nobody on
 * the homepage will read.
 *
 * So this module cuts the boards down to the eight rows each that the homepage
 * shows, keeping exactly the fields the row renders: the rank, the name, the
 * marks, the heaviest cut with its juror, the small numbers, and the five
 * per-metric losses the cut meter is drawn from. The full ledger lives one click
 * away at `/boards/<slug>`, where it is rendered whole.
 *
 * The meter's slice is deliberately narrow. It needs each metric's loss — that is
 * the segment width, and the widths have to be exact or the bar is a lie — plus
 * the single heaviest reason on that metric for the segment's `title`. Every other
 * deduction is dropped, which is the difference between a few kilobytes and a few
 * hundred: a row on this page averages thirty reasons and shows one.
 *
 * Nothing here re-ranks or re-derives. It slices `BoardView`, which sliced the
 * stored ranking, which the engine computed.
 */

import { pickFaviconCss } from './favicon';
import type { BoardView, MetricView, RowView } from './view';

/** How many rows the homepage board shows. `the-pit-home.html` shows eight. */
export const HOME_ROWS = 8;

/** A homepage row: the fields `RowLead`, `CutMeter` and `RowNumbers` read, and no others. */
export type HomeRow = Pick<
  RowView,
  | 'rank'
  | 'name'
  | 'iconClass'
  // The identity slot. `RowLead` draws the mark from these, and the homepage
  // shows the same eight rows the category board does — an anonymous listing
  // that arrived named on the front page would be the leak in its most public
  // place.
  | 'anonymous'
  | 'robotSeed'
  | 'mark'
  | 'cuts'
  | 'health'
  | 'composite'
  | 'core'
  | 'demand'
  | 'soloCluster'
  | 'tiebroken'
  | 'headline'
  | 'soloNote'
  // The row's own verdict. Every row on the homepage board is a link to it —
  // the board's whole job is to make a reader want one, and until this field
  // came down with the slice the eight most visible rows on the site were the
  // only ones with no way into the thing they are advertising.
  | 'verdictHref'
> & {
  /** `RowView` fields the homepage never renders, present so the shared row components typecheck. */
  url: string;
  deductionCount: number;
  /** Trimmed to what the meter draws: each metric's loss, and its worst reason for the tooltip. */
  metrics: MetricView[];
  cluster: RowView['cluster'];
  flagged: never[];
};

/**
 * A metric, cut down to the meter.
 *
 * `cuts` is load-bearing — it is the segment's width, and `view.ts` has already
 * sorted the metrics heaviest-first, so the order is the order the meter draws in.
 * `deductions` keeps one entry, the heaviest, because that is the only one the
 * segment's `title` quotes. `deductionCount` on the row still counts all of them,
 * so the caption under the bar does not shrink with the payload.
 */
function toMeterMetric(metric: MetricView): MetricView {
  const worst = metric.deductions.at(0);
  return {
    metric: metric.metric,
    score: metric.score,
    spread: metric.spread,
    cuts: metric.cuts,
    jurors: metric.jurors,
    substituted: [],
    deductions: worst === undefined ? [] : [worst],
  };
}

/** One category as the homepage rail holds it. */
export interface HomeBoard {
  slug: string;
  category: string;
  type: string;
  productCount: number;
  soloCount: number;
  tiebrokenCount: number;
  generatedAt: string;
  rows: HomeRow[];
  /**
   * The icons these eight rows wear, as CSS. Sliced with the rows, so the
   * homepage carries at most sixteen icons and not ninety-two.
   */
  iconCss: string;
}

/**
 * One line of the strip under the board.
 *
 * `brief` Part 6: "Motion comes from *rotating categories and arriving verdicts*,
 * never from rank churn." Nothing has arrived yet — checkout is a later phase, and
 * there is no placement feed to read — so the strip carries **real cuts already on
 * the record** rather than a fabricated stream of arrivals. Every line is a
 * deduction a named juror actually took on a product actually on the board. When
 * placements start landing, this is the strip they land in, and until then it does
 * not claim they have.
 */
export interface TickerLine {
  product: string;
  category: string;
  slug: string;
  points: number;
  reason: string;
  role: string;
  /** The metric the cut came off, so the line can say where it landed. */
  metric: string;
}

/**
 * The four numbers under the hero, and where every one of them comes from.
 *
 * The design canvas puts a stats row on the homepage — PITCHES BLED, VERDICTS PER
 * RUN, MEDIAN HEALTH LEFT, CATEGORIES — with `12,481` under the first of them.
 * We have ninety-two products, not twelve thousand, and the whole argument of the
 * page is that the board cannot be bought. **A stat that cannot be computed is a
 * stat that is not shown.** So every field here is a fold over the boards that
 * are actually on disk, computed from the same `BoardView`s the rows are drawn
 * from, and there is no fifth field holding a number nobody can derive:
 *
 * - `products` — rows, summed across boards. The canvas's "pitches bled", except
 *   it is called what it is: every one of them was judged, none of them arrived.
 * - `medianHealth` — the median of `100 − cuts` over every row. The canvas's
 *   headline stat, and the reason the whole surface now leads with health.
 * - `cuts` — every deduction in every ledger on every board. Not the sum of the
 *   `cuts` column (that is a mean of means); the *count* of reasons a named juror
 *   wrote down. It is the number that says what $5 buys.
 * - `deepest` — the largest single deduction anywhere, which is the canvas's
 *   "deepest wound so far" and the line the cut feed opens on.
 * - `categories` — boards.
 *
 * `verdicts per run` is deliberately absent. It would be `metrics × jurors`, both
 * of which vary by category, so there is no single honest number to print under
 * that label.
 */
export interface BoardStats {
  products: number;
  categories: number;
  /** Median of `100 − cuts` across every row on every board, one decimal. */
  medianHealth: number;
  /** Every deduction on every ledger. */
  cuts: number;
  /** The largest single deduction anywhere, in points off one juror's own 100. */
  deepest: number;
}

/** The median of a list. Even lengths take the mean of the middle pair. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Fold the boards into the stats row.
 *
 * Runs over the FULL boards, before `toHomeBoard` slices them to eight rows —
 * "48 products" has to mean forty-eight products and not the eight the homepage
 * happens to draw.
 */
export function boardStats(boards: readonly BoardView[]): BoardStats {
  const rows = boards.flatMap((board) => board.rows);
  const points = rows.flatMap((row) => row.metrics.flatMap((metric) => metric.deductions.map((d) => d.points)));
  return {
    products: rows.length,
    categories: boards.length,
    medianHealth: median(rows.map((row) => row.health)),
    cuts: rows.reduce((total, row) => total + row.deductionCount, 0),
    deepest: points.reduce((most, value) => Math.max(most, value), 0),
  };
}

function toHomeRow(row: RowView): HomeRow {
  return {
    rank: row.rank,
    name: row.name,
    // A class name, not the icon's bytes. The homepage board is a CLIENT
    // component, so everything on this row is serialized into the page's
    // hydration payload as well as rendered into its HTML — which would put
    // every icon in the document twice over. The bytes stay in the board's one
    // `iconCss` block, emitted by the server page, and the row carries six
    // characters.
    ...(row.iconClass === undefined ? {} : { iconClass: row.iconClass }),
    anonymous: row.anonymous,
    ...(row.robotSeed === undefined ? {} : { robotSeed: row.robotSeed }),
    mark: row.mark,
    cuts: row.cuts,
    health: row.health,
    composite: row.composite,
    core: row.core,
    ...(row.demand === undefined ? {} : { demand: row.demand }),
    soloCluster: row.soloCluster,
    tiebroken: row.tiebroken,
    headline: row.headline,
    ...(row.soloNote === undefined ? {} : { soloNote: row.soloNote }),
    ...(row.verdictHref === undefined ? {} : { verdictHref: row.verdictHref }),
    url: row.url,
    deductionCount: row.deductionCount,
    metrics: row.metrics.map(toMeterMetric),
    cluster: row.cluster,
    flagged: [],
  };
}

/** Slice one board down to the homepage's eight rows. */
export function toHomeBoard(board: BoardView, limit: number = HOME_ROWS): HomeBoard {
  const rows = board.rows.slice(0, limit).map(toHomeRow);
  // The icons the KEPT rows wear, and no others. The whole board's icon bytes
  // are the single heaviest thing on a `BoardView`, and shipping forty of them
  // to draw eight would undo this module's reason to exist.
  const worn = new Set(rows.map((row) => row.iconClass).filter((name): name is string => name !== undefined));
  return {
    slug: board.slug,
    category: board.category,
    type: board.type,
    productCount: board.productCount,
    soloCount: board.soloCount,
    tiebrokenCount: board.tiebrokenCount,
    generatedAt: board.generatedAt,
    rows,
    iconCss: pickFaviconCss(board.iconCss, worn),
  };
}

/**
 * The card in the right half of the hero: whoever is currently #1.
 *
 * The hero was a headline, a sub and a CTA in its left half and four hundred
 * pixels of nothing in its right. What belongs in that space is not an
 * illustration of the product — it is the product: the board's current leader,
 * with the same health bar every row on the page wears, and the sharpest thing a
 * juror said about the best thing here. A page whose claim is "you can't outbid
 * the pit" opens by showing what the top of it actually looks like, including
 * what it lost.
 *
 * It is its own type rather than a `HomeRow`, and deliberately: the rank-1 row is
 * ALREADY in the client payload as `board.rows[0]`, so handing the hero a second
 * copy of it would serialize the same thirty fields twice into every document.
 * This is the dozen the card draws.
 *
 * `metrics` keeps only each metric's loss, because the hero's bar is the same
 * exact decomposition the row's is (`CutMeter`'s header says why the widths have
 * to be exact) and the hero has no room to quote a reason per segment.
 */
export interface HeroCard {
  slug: string;
  category: string;
  /** "#1 / 48" — the size of the field this row is first in. */
  productCount: number;
  name: string;
  /** The row's own verdict, when one has been issued. Absent falls back to the board. */
  verdictHref?: string;
  anonymous: boolean;
  robotSeed?: string;
  iconClass?: string;
  mark: string;
  /** `100 − cuts`, the teal head of the bar and the figure beside it. */
  health: number;
  cuts: number;
  /** Heaviest-first, matching the row: `{ metric, cuts }` and nothing else. */
  metrics: { metric: string; cuts: number }[];
  headline: HomeRow['headline'];
}

/**
 * The #1 of every board the rail can rotate to, in the rail's own order.
 *
 * One per board, so the hero card can follow the rotation without a fetch — the
 * same reason `toHomeBoard` ships all of them. A board with no rows contributes
 * nothing rather than an empty card.
 */
export function heroCards(boards: readonly HomeBoard[]): HeroCard[] {
  const cards: HeroCard[] = [];
  for (const board of boards) {
    const row = board.rows.at(0);
    if (row === undefined) continue;
    cards.push({
      slug: board.slug,
      category: board.category,
      productCount: board.productCount,
      name: row.name,
      ...(row.verdictHref === undefined ? {} : { verdictHref: row.verdictHref }),
      anonymous: row.anonymous,
      ...(row.robotSeed === undefined ? {} : { robotSeed: row.robotSeed }),
      ...(row.iconClass === undefined ? {} : { iconClass: row.iconClass }),
      mark: row.mark,
      health: row.health,
      cuts: row.cuts,
      metrics: row.metrics.map((metric) => ({ metric: metric.metric, cuts: metric.cuts })),
      headline: row.headline,
    });
  }
  return cards;
}

/**
 * The heaviest cuts across every board, interleaved by category.
 *
 * Interleaved rather than concatenated so the strip does not spend its first
 * eight lines inside one category. Sorted by weight within a category, so the
 * lines that scroll past are the ones that cost the most. Deterministic: the
 * server and the browser build the same list from the same boards, which is what
 * keeps the first render hydratable.
 */
export function tickerLines(boards: readonly BoardView[], perBoard: number = 6): TickerLine[] {
  const perCategory = boards.map((board) =>
    board.rows
      .filter((row): row is RowView & { headline: NonNullable<RowView['headline']> } => row.headline !== null)
      .sort((a, b) => b.headline.points - a.headline.points || a.rank - b.rank)
      .slice(0, perBoard)
      .map((row) => ({
        product: row.name,
        category: board.category,
        slug: board.slug,
        points: row.headline.points,
        reason: row.headline.reason,
        role: row.headline.role,
        metric: row.headline.metric,
      })),
  );

  const lines: TickerLine[] = [];
  for (let index = 0; index < perBoard; index += 1) {
    for (const category of perCategory) {
      const line = category[index];
      if (line !== undefined) lines.push(line);
    }
  }
  return lines;
}
