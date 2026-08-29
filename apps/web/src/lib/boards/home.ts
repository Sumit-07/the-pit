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

import type { BoardView, MetricView, RowView } from './view';

/** How many rows the homepage board shows. `the-pit-home.html` shows eight. */
export const HOME_ROWS = 8;

/** A homepage row: the fields `RowLead`, `CutMeter` and `RowNumbers` read, and no others. */
export type HomeRow = Pick<
  RowView,
  'rank' | 'name' | 'cuts' | 'composite' | 'core' | 'demand' | 'soloCluster' | 'tiebroken' | 'headline' | 'soloNote'
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
}

function toHomeRow(row: RowView): HomeRow {
  return {
    rank: row.rank,
    name: row.name,
    cuts: row.cuts,
    composite: row.composite,
    core: row.core,
    ...(row.demand === undefined ? {} : { demand: row.demand }),
    soloCluster: row.soloCluster,
    tiebroken: row.tiebroken,
    headline: row.headline,
    ...(row.soloNote === undefined ? {} : { soloNote: row.soloNote }),
    url: row.url,
    deductionCount: row.deductionCount,
    metrics: row.metrics.map(toMeterMetric),
    cluster: row.cluster,
    flagged: [],
  };
}

/** Slice one board down to the homepage's eight rows. */
export function toHomeBoard(board: BoardView, limit: number = HOME_ROWS): HomeBoard {
  return {
    slug: board.slug,
    category: board.category,
    type: board.type,
    productCount: board.productCount,
    soloCount: board.soloCount,
    tiebrokenCount: board.tiebrokenCount,
    generatedAt: board.generatedAt,
    rows: board.rows.slice(0, limit).map(toHomeRow),
  };
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
