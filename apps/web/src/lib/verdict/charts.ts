/**
 * The figures on a verdict page, derived from the frozen payload.
 *
 * ## Why the derivations live here and not in the template
 *
 * `page.ts` is a string builder. Everything it interpolates has to be a number
 * somebody can check, and a number computed inline inside a template literal is a
 * number nobody can test without parsing HTML. So every value that ends up as a
 * width, a colour step or a table cell is produced by a function in this file,
 * over the `Verdict` that `model.ts` parsed, and `test/verdict-charts.test.ts`
 * checks each one against the seeded boards.
 *
 * Nothing here reads a live ranking, a board, a category median or a clock. The
 * input is one frozen verdict and the output is only what can be arithmetic on
 * it. That is the same rule `model.ts` states and it is why there is no
 * "compared with the category" figure on this page: `DECISIONS.md §1.2` moves
 * every z-score on every placement, so a baseline drawn from the current
 * population would make a shared link show a different chart next week. The
 * payload carries this product's numbers and no one else's, and that is the
 * whole set of things a frozen page may draw.
 *
 * ## Three figures, three jobs
 *
 * 1. `cutMatrix` — **who cut you, and where.** Magnitude across two categorical
 *    dimensions (juror × metric), which is a heatmap and takes a sequential ramp.
 * 2. `lossBars` — **how deep, and did the panel agree.** Magnitude on one
 *    dimension with an interval, which is a sorted horizontal bar with a spread
 *    whisker.
 * 3. `demandView` — **did any buyer want it.** A count against a roster, plus a
 *    per-persona strength, which is a labelled bar per persona and an explicit
 *    row for the buyers who were shown it and reached for something else.
 *
 * The founder asked for a radar. `references/anti-patterns.md` is against it on
 * two counts that both apply here — radar area grows as the square of the value,
 * so a 20-point difference near the rim looks several times a 20-point difference
 * near the centre, and the axis order is arbitrary, so the SHAPE is an artefact of
 * which metric was drawn first. A third count is specific to this page: a radar's
 * one real justification is an overlaid baseline ring, and the frozen payload
 * carries no category median to draw one from. A radar here would be five numbers
 * in a polygon with no comparison and a misleading area. `lossBars` plots the same
 * five numbers on one shared linear axis, sorted by loss, with the cross-juror
 * spread on the same scale — strictly more readable, and it plots the LOSS rather
 * than the score, which is what the rest of the page is about.
 */

import type { Verdict, VerdictDeduction, VerdictMetric } from './model';

// --- the sequential ramp -------------------------------------------------------

/**
 * Five steps on the theme accent's own hue, for the dark ground.
 *
 * A heatmap cell encodes magnitude, so `references/color-formula.md` requires ONE
 * hue, light to dark, never a rainbow and never a second accent. The Pit has
 * exactly one hue — `--cut`, `#F45C33`, and `lib/theme.ts` states the rule the
 * whole palette rests on: *if it is coloured, it was taken*. A juror's deduction
 * is the most literal instance of that there is, so the ramp is that hue and no
 * other, stepped in OKLCH at constant hue with lightness and chroma rising
 * together.
 *
 * The steps are not eyeballed. They were produced by walking OKLCH lightness at
 * the accent's hue (35.7°) and checked with the skill's own validator:
 *
 *     node scripts/validate_palette.js \
 *       "#763c2d,#974631,#b95035,#dc5a38,#ff653c" --ordinal --mode dark --surface "#1a1610"
 *     → ALL CHECKS PASS  (monotone L, adjacent ΔL >= 0.06, light end 2.10:1, hue spread 0°)
 *
 * `#1a1610` is `--pit`, the real ground this page is drawn on. The bottom step
 * clears the 2:1 floor against it, so the smallest cut is still visible as a cut
 * rather than sinking into the page; the top step is a shade above `--cut` itself
 * because five steps could not clear the ΔL gate inside the accent's own
 * lightness. Colour is never the only channel: every cell prints its number and
 * every number is repeated in the table view below the grid.
 */
export const CUT_RAMP = ['#763c2d', '#974631', '#b95035', '#dc5a38', '#ff653c'] as const;

/**
 * The upper bound of each ramp step, in points off one juror's own 100.
 *
 * Five bins over the 1-100 a single juror can take, chosen so the two seeded
 * boards spread across all five rather than piling into one: over their 92
 * products the bins hold 214 / 525 / 770 / 695 / 497 cells. `0` is not a bin —
 * a juror who took nothing is a different fact from a juror who took a little,
 * and it gets its own unpainted cell.
 */
export const CUT_BREAKS = [10, 25, 50, 75] as const;

/** `0` for no cut, else `1..5` — the index into `CUT_RAMP`, one-based. */
export function rampStep(points: number): number {
  if (points <= 0) return 0;
  let step = 1;
  for (const upper of CUT_BREAKS) {
    if (points <= upper) return step;
    step += 1;
  }
  return CUT_RAMP.length;
}

/** `1..5` -> `"1-10"`, `"76-100"`. The scale legend, written from the same breaks. */
export function rampLabel(step: number): string {
  const lower = step === 1 ? 1 : (CUT_BREAKS[step - 2] ?? 0) + 1;
  const upper = CUT_BREAKS[step - 1];
  return upper === undefined ? `${lower}+` : `${lower}–${upper}`;
}

// --- the juror x metric matrix -------------------------------------------------

/** One cell: what one juror took off one metric. */
export interface MatrixCell {
  readonly role: string;
  readonly metric: string;
  /** Summed points, because a juror may take several cuts on one metric. */
  readonly points: number;
  /** Every cut behind the number, heaviest first. The cell's tooltip is this list. */
  readonly deductions: readonly VerdictDeduction[];
  /** This juror returned nothing on this metric and was substituted a 50. */
  readonly substituted: boolean;
  /** `0` (nothing taken, or no answer) or `1..5`. */
  readonly step: number;
}

/** One juror's row. */
export interface MatrixRow {
  readonly role: string;
  readonly cells: readonly MatrixCell[];
  /** Points this juror took across every metric. */
  readonly total: number;
  /** Metrics this juror actually answered. */
  readonly answered: number;
  /**
   * The mean score this juror gave, `100 - total / answered`.
   *
   * Well-defined because `01 §5.1` starts every metric at 100 and the deductions
   * for it sum to exactly `100 - score` — so a juror's score on a metric is 100
   * minus their own points on it, and the mean over the metrics they answered is
   * this. `null` when they answered none, which is the only case where there is
   * no denominator.
   */
  readonly meanScore: number | null;
}

/** The whole grid. */
export interface CutMatrix {
  /** Column order: the ledger's, heaviest loss first. */
  readonly metrics: readonly string[];
  /** Row order: harshest juror first. */
  readonly rows: readonly MatrixRow[];
  /** The largest single cell, for the caption. */
  readonly heaviest: MatrixCell | null;
  /** Points taken per metric column, summed across jurors. */
  readonly columnTotals: readonly number[];
}

/**
 * The matrix: six jurors down, the metrics across, points in the cells.
 *
 * The rows are the jurors who appear anywhere on this card — in a deduction or in
 * a metric's `substituted_roles`. There is no juror roster in the frozen payload
 * (`verdict-payload.ts` freezes the ranked row and the board's metric list, not
 * the panel), so a juror who took nothing at all on any metric cannot be named
 * and does not get a row. On both seeded boards every product has all six: the
 * minimum across 92 products is 6 distinct roles.
 *
 * Sorted by total points descending, so the top row is the juror who took the
 * most. That is an ordering of rows, not of colour — the ramp encodes the cell's
 * own value and nothing about its position, so `anti-patterns.md`'s
 * recolor-on-filter rule is not in play.
 */
export function cutMatrix(verdict: Verdict): CutMatrix {
  const metrics = verdict.metrics.map((metric) => metric.metric);

  const roles: string[] = [];
  const seen = new Set<string>();
  const note = (role: string): void => {
    if (seen.has(role)) return;
    seen.add(role);
    roles.push(role);
  };
  for (const metric of verdict.metrics) {
    for (const deduction of metric.deductions) note(deduction.role);
    for (const role of metric.substituted) note(role);
  }

  const byMetric = new Map<string, VerdictMetric>(verdict.metrics.map((metric) => [metric.metric, metric]));

  const rows: MatrixRow[] = roles.map((role) => {
    const cells: MatrixCell[] = metrics.map((name) => {
      const metric = byMetric.get(name);
      const deductions = (metric?.deductions ?? []).filter((deduction) => deduction.role === role);
      const points = deductions.reduce((sum, deduction) => sum + deduction.points, 0);
      const substituted = metric?.substituted.includes(role) === true;
      return {
        role,
        metric: name,
        points,
        deductions,
        substituted,
        // A substituted juror did not score this metric; the board wrote a 50 in
        // their place. Painting that as a cut would attribute an opinion to
        // someone who returned none — `seed/build.ts` refuses to store one for
        // the same reason — so the cell is left unpainted and says "no answer".
        step: substituted ? 0 : rampStep(points),
      };
    });

    const answered = cells.filter((cell) => !cell.substituted).length;
    const total = cells.reduce((sum, cell) => sum + cell.points, 0);
    return {
      role,
      cells,
      total,
      answered,
      meanScore: answered === 0 ? null : 100 - total / answered,
    };
  });

  rows.sort((a, b) => b.total - a.total || a.role.localeCompare(b.role));

  const heaviest =
    rows
      .flatMap((row) => row.cells)
      .filter((cell) => cell.points > 0)
      .sort((a, b) => b.points - a.points)[0] ?? null;

  return {
    metrics,
    rows,
    heaviest,
    columnTotals: metrics.map((_, index) =>
      rows.reduce((sum, row) => sum + (row.cells[index]?.points ?? 0), 0),
    ),
  };
}

// --- per-metric loss, with the cross-juror spread ------------------------------

/** One metric's bar. All four numbers are on the same 0-100 axis. */
export interface LossBar {
  readonly metric: string;
  /** `100 - score`, the merged loss. */
  readonly cuts: number;
  readonly score: number;
  /** Cross-juror population std of the six scores, as frozen. */
  readonly spread: number;
  /** `cuts - spread`, clamped to the axis. */
  readonly low: number;
  /** `cuts + spread`, clamped to the axis. */
  readonly high: number;
  readonly jurors: number;
  /** How many jurors took anything here. */
  readonly cutters: number;
  /** The widest spread on this card — the one metric the panel split hardest on. */
  readonly widest: boolean;
}

/**
 * Loss per metric with the panel's disagreement drawn on the same axis.
 *
 * `spread` is the population standard deviation of the six jurors' scores, and
 * `cuts` is `100 - mean(score)`, so the interval `cuts ± spread` is the same
 * interval as `score ∓ spread` reflected — one axis, no second scale, which is
 * what `anti-patterns.md`'s first entry demands.
 *
 * The widest-spread metric is marked rather than every bar being annotated. It is
 * the most actionable line on the page: a deep cut the six agreed on is a fact
 * about the product, and a deep cut they split over is a fact about how it reads.
 */
export function lossBars(verdict: Verdict): readonly LossBar[] {
  const widest = Math.max(0, ...verdict.metrics.map((metric) => metric.spread));

  return verdict.metrics.map((metric) => {
    const cuts = clamp(metric.cuts);
    const cutters = new Set(metric.deductions.map((deduction) => deduction.role)).size;
    return {
      metric: metric.metric,
      cuts,
      score: metric.score,
      spread: metric.spread,
      low: clamp(cuts - metric.spread),
      high: clamp(cuts + metric.spread),
      jurors: metric.jurors,
      cutters,
      // Ties would mark two bars, which is correct: they are equally split.
      // `> 0` keeps a card where nobody disagreed from marking every bar.
      widest: widest > 0 && metric.spread === widest,
    };
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// --- the Floor ------------------------------------------------------------------

/** One buyer who named this product. */
export interface DemandRow {
  readonly persona: string;
  readonly pick: 'first' | 'second';
  /**
   * `0-100`, the conviction behind the choice. `null` on every runner-up by
   * design — `01 §6.2` appends a strength only to a persona's FIRST pick, so
   * intensity stays a measure of what a buyer actually chose — and `null` on a
   * first pick whose run recorded none. A row with no strength draws no bar
   * rather than a bar of zero.
   */
  readonly strength: number | null;
  readonly reason: string;
}

/** One component of the demand arithmetic, as a 0-1 meter. */
export interface DemandPart {
  readonly label: string;
  readonly value: number;
  readonly note: string;
}

/** What the Floor did, ready to draw. Only ever built for a Floor that convened. */
export interface DemandChart {
  readonly rows: readonly DemandRow[];
  /** Buyers who named it, first or second. */
  readonly named: number;
  /** Buyers who returned choices for this run — `01 §6.2`'s `P`. */
  readonly roster: number;
  /** Buyers who were shown it and reached for something else. Never rendered as a zero bar. */
  readonly silent: number;
  readonly demand: number;
  readonly parts: readonly DemandPart[];
}

/**
 * The demand figure, or `null` when there is nothing to draw.
 *
 * `null` for a solo cluster, and that is the majority case: 32 of 48 Developer
 * Tools products and 26 of 44 Health & Fitness products have no cluster peers, so
 * the Floor never convened for them. `DECISIONS.md` S3 renormalises those rows to
 * merit at weight 1.0 and S11 calls the empty Floor a DELIVERY. A chart of zeros
 * would state the opposite of the truth — "six buyers looked at you and none
 * wanted you" instead of "no buyer was ever shown this, because there was nothing
 * to show it beside" — so the caller renders the explanation and no figure at all.
 *
 * The silent buyers are a count, not a set of rows: the payload carries the
 * personas who PICKED (`demand_detail.picks`) and the size of the roster
 * (`demand_roster_size`), never the names of the ones who did not. Naming them
 * would be inventing data; the count is exact.
 */
export function demandChart(verdict: Verdict): DemandChart | null {
  const { floor } = verdict;
  if (floor.kind === 'solo') return null;

  const rows: DemandRow[] = floor.picks
    .map((pick) => ({
      persona: pick.persona,
      pick: pick.pick,
      strength: pick.strength ?? null,
      reason: pick.reason,
    }))
    // First choices above runners-up, then by how hard they said it. A pick with
    // no recorded strength sorts below one with a number rather than above it.
    .sort(
      (a, b) =>
        (a.pick === b.pick ? 0 : a.pick === 'first' ? -1 : 1) || (b.strength ?? -1) - (a.strength ?? -1),
    );

  const named = floor.firstPicks + floor.secondPicks;

  return {
    rows,
    named,
    roster: floor.rosterSize,
    silent: Math.max(0, floor.rosterSize - named),
    demand: floor.demand,
    // The four numbers `01 §6.2` reduces the forced choices through, in the order
    // it composes them: share and capture multiply into breadth, and breadth and
    // intensity blend 0.4/0.6 into demand. The notes are that spec in English —
    // `capture` in particular is a fact about the CLUSTER, identical for every
    // product in it, and a page that read it as "your share of the roster" would
    // be crediting this product with its rivals' pull.
    parts: [
      { label: 'Share', value: floor.share, note: 'your slice of the cluster’s votes — a first choice counts double a runner-up' },
      { label: 'Capture', value: floor.capture, note: 'buyers who named anyone in this cluster, out of the roster' },
      { label: 'Breadth', value: floor.breadth, note: 'share × capture' },
      { label: 'Intensity', value: floor.intensity, note: 'the mean of the top two convictions behind your first choices' },
    ],
  };
}
