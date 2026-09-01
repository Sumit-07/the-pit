/**
 * The facts `/how-it-works` states, folded out of the boards that are on disk.
 *
 * ## Why this is a fold and not a page of constants
 *
 * The page's whole claim is that the method is checkable. A page that explained
 * the method and then printed hand-typed numbers beside it would be asking to be
 * taken on trust in the one place it is arguing not to be — and hand-typed numbers
 * go stale silently, which is worse than absent ones. So every figure the page
 * prints comes from `BoardView`, which came from the stored `ranking.json`, which
 * the engine wrote. `test/how-it-works.test.ts` recomputes each one straight off
 * `cjr/runs/<category>/ranking.json` and fails if the page and the boards disagree.
 *
 * `lib/boards/home.ts`'s `boardStats` is the same idea for the homepage's stats
 * row, and its rule is repeated here: **a stat that cannot be computed is a stat
 * that is not shown.** There is nothing in this file that is not a fold over rows.
 *
 * ## The numbers that could differ per category, and what happens when they do
 *
 * The jury size, the metric list and the buyer roster are properties of an
 * INSTALLED PANEL, and `brief` Part 4 lets a category carry its own. So they are
 * held per board and the page says "six" only where the boards agree on six. The
 * weights are the engine's constants (`01 §6.3`) rather than a panel's, but they
 * are still read off the boards rather than restated here: if a board were ever
 * ranked under a different blend, a page that printed the constant would be
 * describing a run that did not happen. `shared` returns `null` where the boards
 * disagree, and the page states the figure only when it is not null.
 */

import type { BoardView } from './view';

/** What one category's installed panel is, as its own board records it. */
export interface PanelFacts {
  readonly slug: string;
  readonly category: string;
  /** Products on the board when it was last written. */
  readonly productCount: number;
  /**
   * Products whose cluster holds only them, so no forced choice was ever run.
   *
   * The majority case on both seeded boards, and the reason the page says so
   * plainly rather than in a footnote: a reader whose product lands here is being
   * ranked on merit alone and should not have to discover that from a verdict.
   */
  readonly soloCount: number;
  /**
   * How many jurors scored a metric on this board.
   *
   * Taken as the largest `juror_count` on any scorecard rather than as the number
   * of distinct roles that appear in a deduction: a juror who took nothing off
   * anything would leave no deduction and would vanish from a count of roles,
   * while still having scored every product. `01 §6.6` writes `juror_count` per
   * metric for exactly this reason.
   */
  readonly jurors: number;
  /** Metrics in this category's rubric. */
  readonly metrics: number;
  /** Simulated buyers on this category's panel — the roster, not the ones who picked. */
  readonly buyers: number;
}

/** Everything `/how-it-works` states with a number in it. */
export interface Mechanics {
  readonly boards: readonly PanelFacts[];
  /** Products across every board. */
  readonly products: number;
  /** Deductions across every ledger — the count of reasons a named juror wrote. */
  readonly cuts: number;
  /** Jurors, where every board agrees. `null` when they do not. */
  readonly jurors: number | null;
  /** Buyers, where every board agrees. `null` when they do not. */
  readonly buyers: number | null;
  /** `0.65`, where every board agrees. */
  readonly merit: number | null;
  /** `0.35`, where every board agrees. */
  readonly demand: number | null;
  /** `0.075`, the bounded scarcity tilt, where every board agrees. */
  readonly scarcityTilt: number | null;
  /** Products with no cluster peers, across every board. */
  readonly solo: number;
}

/**
 * One value, or `null` because the boards do not agree on one.
 *
 * The page reads `null` as "do not print a figure here", never as a zero and never
 * as an excuse to fall back on a constant. A sentence with a missing number is a
 * sentence a reader can still act on; a sentence with the wrong number is not.
 */
function shared<T>(values: readonly T[]): T | null {
  const distinct = new Set(values);
  return distinct.size === 1 ? (values[0] ?? null) : null;
}

/** The largest number of jurors any metric on this board was scored by. */
function jurorsOn(board: BoardView): number {
  let most = 0;
  for (const row of board.rows) {
    for (const metric of row.metrics) most = Math.max(most, metric.jurors);
  }
  return most;
}

/** Fold the boards into the page's facts. Nothing here re-ranks or re-derives a score. */
export function mechanicsOf(boards: readonly BoardView[]): Mechanics {
  const panels: PanelFacts[] = boards.map((board) => ({
    slug: board.slug,
    category: board.category,
    productCount: board.productCount,
    soloCount: board.soloCount,
    jurors: jurorsOn(board),
    metrics: board.metricNames.length,
    buyers: board.personas.length,
  }));

  const rows = boards.flatMap((board) => board.rows);

  return {
    boards: panels,
    products: rows.length,
    cuts: rows.reduce((total, row) => total + row.deductionCount, 0),
    jurors: shared(panels.map((panel) => panel.jurors)),
    buyers: shared(panels.map((panel) => panel.buyers)),
    merit: shared(boards.map((board) => board.weights.merit)),
    demand: shared(boards.map((board) => board.weights.demand)),
    scarcityTilt: shared(boards.map((board) => board.weights.uniqueness_lambda)),
    solo: panels.reduce((total, panel) => total + panel.soloCount, 0),
  };
}

/** `0.65` -> `65%`. Percentages are how the weights are read, not how they are stored. */
export function asPercent(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

/** A count written as a word up to ten, because prose reads better than a numeral in a sentence. */
export function inWords(count: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[count] ?? String(count);
}
