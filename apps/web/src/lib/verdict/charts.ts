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
 * it. That rule has not moved. What has moved is what the frozen verdict CONTAINS:
 * `packages/db/src/verdict-comparison.ts` now freezes this product's cluster peers
 * and the category's own middle into the payload at delivery, so a comparison is
 * arithmetic on the frozen document rather than a read of the live population.
 * `DECISIONS.md §1.2` forbids fetching a baseline, because a fetched one would
 * make a shared link change under its reader. A frozen one cannot.
 *
 * ## Four figures, four jobs
 *
 * 1. `juryRadial` — **who hurt me.** Six jurors, fixed axes, this product's shape
 *    against its cluster peers and the category median. It plots the HEALTH each
 *    juror left standing, not the points they took — see `jurorHealth`.
 * 2. `buyerRadial` — **who wanted me.** Six buyers, the same treatment, already
 *    pointing the same way: conviction, where further out is more of it.
 * 3. `cutMatrix` — **where exactly.** Magnitude across two categorical dimensions
 *    (juror × metric), which is a heatmap and takes a sequential ramp.
 * 4. `lossChart` — **what was left, and did the panel agree.** Magnitude on one
 *    dimension with an interval, which is a sorted horizontal bar with a spread
 *    whisker; the category median rides on the same axis as a tick.
 *
 * ## The radar objections, and which of them this satisfies
 *
 * A previous pass on this page refused a radial and was right at the time. Three
 * objections were recorded. Two still bind and are answered by construction; one
 * no longer applies.
 *
 * 1. **Area grows as the square of the value.** True, and unfixable. It is
 *    answered by never asking the reader to read a magnitude off the polygon:
 *    radius is linear in the value, every axis prints its own number beside its
 *    label, and `radialTable` repeats every series on every axis. The polygon's
 *    job is SHAPE COMPARISON — is my dent in the same place as theirs — which is
 *    the one thing a radial does better than six bars, and the only thing the
 *    founder asked it for.
 * 2. **Axis order is arbitrary.** Not here. The axes are the six jurors and the
 *    six buyers in the order the panel was installed in, frozen in the payload as
 *    `comparison.jurors` and `comparison.personas`. Every series on a chart is
 *    plotted against the same frozen order, so a shape is comparable to another
 *    shape by construction rather than by coincidence.
 * 3. **No baseline could be drawn.** This is the one that changed. Cluster peers
 *    and the category median are both known at delivery and are now frozen, so the
 *    chart has the overlay that is a radial's only real justification.
 *
 * `lossChart` stays. It is the better form for "how much, on one linear axis with
 * an interval", and the radial does not answer that question.
 *
 * ## Who is on each axis, and why that is frozen too
 *
 * A spoke names a juror or a buyer and used to say nothing more. `Radial.mandates`
 * carries the person behind each axis — who they are, what they weigh heaviest,
 * what they punish — so a reader meeting "The Seed Investor" can learn that he is
 * scoring the POSITION rather than the product, which is the whole reason his
 * number is what it is.
 *
 * It comes off `verdict.panel`, the frozen document, and never off
 * `cjr/references/jurors/<slug>.json`. That is the same rule as the rest of this
 * module for a slightly different reason: a jury is VERSIONED and a mandate can be
 * revised (`01 §4` Step 2), so a permanent public URL that read the installed
 * panel at render time would eventually describe jurors who are not the ones who
 * cut this product. The mandate that judged you is part of your verdict.
 * `packages/db/src/verdict-panel.ts` freezes it; `null` on every axis of a verdict
 * frozen before that key existed, and the page draws those spokes with no
 * biography rather than inventing one.
 *
 * ## One direction for the whole page, and the one figure exempt from it
 *
 * A reader scrolls this page from top to bottom and should not have to re-learn
 * which way a bigger mark points on the way down. So **every figure with a linear
 * axis plots what SURVIVED**: the radials plot the health each juror left and the
 * conviction each buyer gave, and `lossChart` plots the merged score each metric
 * kept, with the cut drawn as the remainder of the same hundred. Bigger is better,
 * three sections running, and the paint follows from that — `lib/theme.ts` spends
 * `--held` on what survived and `--cut` on what was taken, so the plotted half is
 * `--held` and the remainder is `--cut`.
 *
 * **`cutMatrix` is the deliberate exception and must stay as it is.** It is a
 * damage matrix, not an axis: each cell is what one juror took off one metric, and
 * a heatmap's ramp encodes magnitude by darkness. Inverting it to plot health
 * would make the heaviest damage the palest cell — damage would read as absence,
 * which is the opposite of what a reader of a damage matrix is looking for — and
 * it would put the surviving quantity on the `--cut` ramp or force a second
 * five-step ramp in the other hue. The grid has no direction to be inconsistent
 * with: its two dimensions are both categorical, so nothing about it "points" the
 * way a bar or a spoke does. It is registered below as `more-is-worse`, which is
 * the honest declaration, and the paint test holds it to `--cut`. Do not "fix" it.
 *
 * `FIGURE_PAINT` writes that down as data rather than as prose, so a third chart
 * cannot be plotted backwards and painted `--held` with nothing noticing.
 *
 * ## Which way the radials point, and why it is health and not cuts
 *
 * Both radials plot a quantity where **further out is better**, and that is a
 * correction rather than a preference. The jury radial used to plot points TAKEN,
 * which failed twice over: a good product has few cuts, so the product a reader
 * most wants to look at drew the smallest polygon; and a larger shape read as a
 * worse card, against every instinct a reader brings to a chart. So the axis is
 * `100 - cuts` — the health that juror left standing — which is also the framing
 * the rest of the app already carries (`HEALTH_NOTE`, the meter's kept head,
 * "health on entry is 100"). The buyers radial already pointed this way and is
 * unchanged in direction, so the two now read as a pair.
 *
 * **The axis is 0–100 and starts at zero.** It is not truncated to the band the
 * data happens to occupy, and that is the one thing about this chart that must
 * not be "improved". Radar area already grows as the square of the radius; a
 * baseline at 50 would compound a second exaggeration on top of that one, and a
 * reader has no way to see either. The seeded boards do not need the help in any
 * case: per-juror health across both categories runs 10.6 to 93.0 with a median
 * of 53.0, and a product's mean health runs 15.4 to 90.6. The full axis has more
 * than enough room for that. `test/verdict-radial.test.ts` pins the zero.
 */

import type { Verdict, VerdictComparison, VerdictDeduction, VerdictMetric, VerdictPanel } from './model';

// --- polarity: which way a figure points, and what that obliges it to wear ------

/**
 * Which way a figure's marks grow.
 *
 * `more-is-better` — a longer bar, a wider polygon, a bigger number is a BETTER
 * card. `more-is-worse` — the mark grows with the damage.
 *
 * This is a property of the figure and not of its caption. A caption can say
 * anything; the polygon and the bar are what a reader actually reads, and the two
 * have already disagreed on this page once.
 */
export type Polarity = 'more-is-better' | 'more-is-worse';

/**
 * The hue a polarity obliges, which is not a preference either.
 *
 * `lib/theme.ts` spends exactly two colours and each names one half of the same
 * hundred: `--held` is what survived, `--cut` is what was taken. So a mark that
 * grows as the product does better is drawing the surviving half and must wear
 * `--held`; a mark that grows with the damage is drawing the taken half and must
 * wear `--cut`. `test/verdict-polarity.test.ts` reads both sides — the builder's
 * declared polarity and the CSS the page actually ships — and fails when they
 * disagree.
 */
export const PAINT_FOR: Readonly<Record<Polarity, '--held' | '--cut'>> = {
  'more-is-better': '--held',
  'more-is-worse': '--cut',
};

/** The other one. A figure's complement wears the hue its measure does not. */
export function opposite(polarity: Polarity): Polarity {
  return polarity === 'more-is-better' ? 'more-is-worse' : 'more-is-better';
}

/** Every figure this module builds, by the name of the function that builds it. */
export type FigureName = 'juryRadial' | 'buyerRadial' | 'cutMatrix' | 'lossChart' | 'demandChart';

/** What one figure plots, which way, and the selectors that paint it. */
export interface FigurePaint {
  readonly figure: FigureName;
  /** The direction the figure's own quantity grows in. Its builder returns this too. */
  readonly polarity: Polarity;
  /**
   * The selectors in `verdict/page.ts` that paint the quantity the figure
   * measures. Empty for a figure that carries neither hue.
   */
  readonly measure: readonly string[];
  /**
   * The selectors that paint its complement — the other half of the same hundred,
   * which by construction wears the other hue.
   */
  readonly complement: readonly string[];
  /**
   * The selectors that carry no magnitude of either kind and must therefore wear
   * NEITHER hue: uncertainty, reference ticks, roster proportions, chrome.
   */
  readonly neither: readonly string[];
  readonly why: string;
}

/**
 * The page's figures, their direction, and the paint that follows from it.
 *
 * The list exists because the failure it guards is silent. A chart plotted the
 * wrong way round still renders, still validates, still passes every test that
 * asks whether a width was drawn — the inverted jury radial shipped exactly that
 * way. Writing the direction down beside the selectors that paint it turns "this
 * chart points the wrong way" into a failing assertion rather than something a
 * reader notices three sections later.
 *
 * A new figure that paints either hue and is not listed here fails the
 * exhaustiveness check in `test/verdict-polarity.test.ts`, so the registry cannot
 * quietly fall behind the page.
 */
export const FIGURE_PAINT: readonly FigurePaint[] = [
  {
    figure: 'juryRadial',
    polarity: 'more-is-better',
    measure: ['.rj .rself', '.rj .rdot', '.rj .rkey i.rself'],
    complement: [],
    neither: ['.rp', '.rpdot', '.rring', '.rspoke'],
    why: 'plots the health each juror left standing, so further out is a better card',
  },
  {
    figure: 'buyerRadial',
    polarity: 'more-is-better',
    measure: ['.rb .rself', '.rb .rdot', '.rb .rkey i.rself'],
    complement: [],
    neither: ['.rp', '.rpdot', '.rring', '.rspoke'],
    why: 'plots the conviction behind a first choice, which is a thing the product won',
  },
  {
    figure: 'lossChart',
    polarity: 'more-is-better',
    measure: ['.lbfill'],
    complement: ['.lbcut'],
    neither: ['.lbwhisk', '.lbmed'],
    why: 'plots the merged score each metric KEPT, with the cut as the remainder of the same hundred',
  },
  {
    figure: 'cutMatrix',
    polarity: 'more-is-worse',
    measure: ['.mxc.k1', '.mxc.k2', '.mxc.k3', '.mxc.k4', '.mxc.k5'],
    complement: [],
    neither: ['.mxc.ksub'],
    // The exception, stated where the check can see it. See the module comment.
    why: 'a damage matrix: darker is a deeper cut, because inverting it would make damage read as absence',
  },
  {
    figure: 'demandChart',
    polarity: 'more-is-better',
    measure: [],
    complement: [],
    neither: ['.dfill', '.dtrack'],
    why: 'the Floor meters are proportions of a panel roster, not shares of the hundred the two hues divide',
  },
];

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
  /**
   * `more-is-worse`, and the one figure on this page that is.
   *
   * Declared rather than implied, so the exception is a value the paint test reads
   * rather than a convention the next reader has to infer. The module comment gives
   * the argument: a heatmap of damage encodes magnitude as darkness, and inverting
   * it would make the heaviest cut the palest cell.
   */
  readonly polarity: Polarity;
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
    // Deliberate, documented, and not a drift. See the module comment.
    polarity: 'more-is-worse',
    metrics,
    rows,
    heaviest,
    columnTotals: metrics.map((_, index) =>
      rows.reduce((sum, row) => sum + (row.cells[index]?.points ?? 0), 0),
    ),
  };
}

// --- the two radials -----------------------------------------------------------

/**
 * One shape on a radial.
 *
 * `role` is the whole colour system of these charts and it is `choosing-a-form.md`'s
 * **emphasis** form, not a categorical palette: one series is the point and the
 * rest are context, so there is one hue and one de-emphasis grey rather than four
 * hues competing. `self` wears the theme hue; `peer` and `median` wear the same
 * grey and are told apart by line style, by the legend, and by the table twin.
 */
export interface RadialSeries {
  /**
   * What the chart may call this series, once the reader has asked.
   *
   * For a peer this is the frozen label: a pseudonym when the product chose
   * anonymity, its own name when it did not. There is no third option and no way
   * back to a withheld name — `model.ts` never parses one.
   */
  readonly label: string;
  /**
   * One value per axis, on a 0–100 axis that starts at zero, where FURTHER OUT
   * IS BETTER on both radials — health left on the jury chart, conviction on the
   * buyers chart. `null` where this series has no number on that axis, which is
   * not a zero and is never drawn as one.
   */
  readonly values: readonly (number | null)[];
  readonly role: 'self' | 'peer' | 'median';
  /** `true` when `label` is a pseudonym. Peers only. */
  readonly anonymous?: boolean;
  /** The peer's own verdict page. Never set for an anonymous peer. */
  readonly slug?: string | null;
  /** The seam the robot-avatar generator draws from. Never the product name. */
  readonly avatarSeed?: string;
}

/** A per-axis fact that is not a magnitude — the thing a `0` on that axis is not. */
export type RadialMark = 'no answer' | '2nd choice' | null;

/**
 * Who the person behind one axis is, from the FROZEN panel.
 *
 * A spoke names a juror or a buyer and, until this existed, said nothing about
 * either: a reader met "The Seed Investor" and had no way to know that he scores
 * the position rather than the product, which is exactly what makes his number
 * mean something. The founder's ask was "the personality behind each axis, so I
 * can have a better idea of the result".
 *
 * It comes off `verdict.panel` and nowhere else. `model.ts` and
 * `packages/db/src/verdict-panel.ts` both carry the argument: a jury is versioned
 * and a mandate can be revised, so reading the installed panel at render time
 * would make an old verdict start describing jurors who are not the ones who cut
 * it. `null` on every axis of a verdict frozen without a panel, and the page
 * draws that spoke with no biography rather than inventing one.
 */
export type AxisMandate =
  | {
      readonly kind: 'juror';
      readonly role: string;
      readonly who: string;
      readonly caresMost: string;
      readonly biasedAgainst: string;
    }
  | {
      readonly kind: 'buyer';
      readonly name: string;
      readonly description: string;
      readonly needs: readonly string[];
      readonly priceSensitivity: string;
    };

/** One radial, ready to draw. */
export interface Radial {
  /**
   * `more-is-better` on both radials, carried as a field rather than as a comment.
   *
   * The chart interface used to say nothing about which way it pointed, which is
   * how a health polygon and a cuts polygon could be the same type: a third radial
   * could be plotted backwards, painted `--held`, and pass every existing test.
   * `FIGURE_PAINT` and `test/verdict-polarity.test.ts` close that.
   */
  readonly polarity: Polarity;
  /** Juror roles or persona names, in the frozen installed order. */
  readonly axes: readonly string[];
  readonly self: RadialSeries;
  /** Peers first, then the category median. Empty when the payload carries no comparison. */
  readonly context: readonly RadialSeries[];
  readonly marks: readonly RadialMark[];
  /**
   * Who each axis is, one entry per axis, `null` where the frozen payload
   * carries no mandate for that name.
   *
   * Positional against `axes`, but JOINED BY NAME rather than by position — a
   * panel frozen in a different order than the axis order recovered from the
   * board still finds the right person, and a juror the payload has no entry for
   * gets `null` instead of somebody else's biography.
   */
  readonly mandates: readonly (AxisMandate | null)[];
  /**
   * What the reader is being compared against, for the caption.
   *
   * - `peers` — real cluster peers, the comparison the founder asked for.
   * - `category` — no peers exist (a solo cluster: 32 of 48 rows), so the only
   *   honest baseline is the category's own middle, and the caption says so.
   * - `none` — the payload predates the frozen comparison. No overlay is drawn
   *   and none is invented.
   */
  readonly baseline: 'peers' | 'category' | 'none';
  /** What the axis units are, in one phrase. Rendered verbatim. */
  readonly unit: string;
  /** How many products the median was taken over, and out of what. */
  readonly medianOver: number;
  readonly boardSize: number;
}

/** The points one juror took off one metric on THIS card, summed over their cuts. */
function pointsFrom(metric: VerdictMetric, role: string): number {
  return metric.deductions
    .filter((deduction) => deduction.role === role)
    .reduce((sum, deduction) => sum + deduction.points, 0);
}

/**
 * The mean points a juror took per metric they actually scored, 0–100.
 *
 * The same arithmetic as `packages/db/src/verdict-comparison.ts`'s `jurorCut`,
 * because the self series and the peer series have to be on one scale or the
 * shapes are not comparable. `01 §5.1` starts every juror on every metric at 100
 * and their deductions sum to `100 - their score`, so this is a real 0–100 figure
 * and not an index.
 *
 * A metric this juror was substituted a 50 on is excluded from the denominator
 * rather than counted as a zero — the board wrote that 50, the juror did not, and
 * this page refuses to draw a substitution as an opinion. `null` when they scored
 * nothing at all.
 */
export function jurorMeanCut(verdict: Verdict, role: string): number | null {
  let points = 0;
  let answered = 0;
  for (const metric of verdict.metrics) {
    if (metric.substituted.includes(role)) continue;
    answered += 1;
    points += pointsFrom(metric, role);
  }
  return answered === 0 ? null : points / answered;
}

/**
 * The health one juror left standing, 0–100. `100 - jurorMeanCut`.
 *
 * This is the number the jury radial plots, and the inversion is the whole point
 * of the chart: every juror starts this product on 100 (`01 §5.1`) and their
 * deductions sum to what they took away, so what is left is a real quantity on
 * the same 0–100 axis and not an index. A product that survived its panel fills
 * the shape; one that was taken apart draws a small one. Plotting the cuts
 * instead — which this page did — made the best cards the smallest marks.
 *
 * `null` where the juror scored nothing, propagated rather than turned into a
 * number: a juror who answered nothing left neither 0 health nor 100.
 */
export function jurorHealth(verdict: Verdict, role: string): number | null {
  const cut = jurorMeanCut(verdict, role);
  return cut === null ? null : 100 - cut;
}

/**
 * A frozen row of cuts, as the health remaining it is the complement of.
 *
 * The payload is frozen and append-only: `comparison.jurors` stores what each
 * juror TOOK from that peer, because that is what was frozen before the chart
 * changed direction and `verdicts` refuses `UPDATE`. The inversion therefore
 * happens here, on the read, and it has to happen to the peers and the median as
 * well as to the subject or the shapes are on two different scales pointing two
 * different ways.
 */
function asHealth(values: readonly (number | null)[]): readonly (number | null)[] {
  return values.map((value) => (value === null ? null : 100 - value));
}

/** Every juror who appears on this card, in the order they appear. The fallback roster. */
function rolesOnCard(verdict: Verdict): string[] {
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const metric of verdict.metrics) {
    for (const deduction of metric.deductions) {
      if (seen.has(deduction.role)) continue;
      seen.add(deduction.role);
      roles.push(deduction.role);
    }
    for (const role of metric.substituted) {
      if (seen.has(role)) continue;
      seen.add(role);
      roles.push(role);
    }
  }
  return roles;
}

/** The context shapes, shared by both radials. Peers in rank order, then the median. */
function contextSeries(
  comparison: VerdictComparison | null,
  pick: (peer: VerdictComparison['peers'][number]) => readonly (number | null)[],
  medianOf: (comparison: VerdictComparison) => readonly (number | null)[],
): RadialSeries[] {
  if (comparison === null) return [];

  const peers: RadialSeries[] = [...comparison.peers]
    .sort((a, b) => a.rank - b.rank)
    .map((peer) => ({
      label: peer.label,
      values: pick(peer),
      role: 'peer' as const,
      anonymous: peer.anonymous,
      slug: peer.slug,
      avatarSeed: peer.avatarSeed,
    }));

  const median = medianOf(comparison);
  // A median that is null on every axis is not a baseline; drawing a polygon
  // collapsed onto the centre would read as "the category scores zero" rather
  // than "there was no sample". It is left off and the table says so.
  if (median.some((value) => value !== null)) {
    peers.push({ label: 'Category median', values: median, role: 'median' });
  }
  return peers;
}

/**
 * The juror mandates for a list of roles, in axis order.
 *
 * A lookup and never a fallback: a role the frozen panel has no entry for gets
 * `null`, which is the difference between "this verdict did not freeze a
 * biography" and "here is a biography we found lying around".
 */
export function jurorMandates(panel: VerdictPanel | null, axes: readonly string[]): (AxisMandate | null)[] {
  const byRole = new Map((panel?.jurors ?? []).map((juror) => [juror.role, juror]));
  return axes.map((role) => {
    const juror = byRole.get(role);
    return juror === undefined
      ? null
      : {
          kind: 'juror' as const,
          role: juror.role,
          who: juror.who,
          caresMost: juror.caresMost,
          biasedAgainst: juror.biasedAgainst,
        };
  });
}

/** The buyer mandates for a list of persona names, in axis order. Same rule. */
export function buyerMandates(panel: VerdictPanel | null, axes: readonly string[]): (AxisMandate | null)[] {
  const byName = new Map((panel?.buyers ?? []).map((buyer) => [buyer.name, buyer]));
  return axes.map((persona) => {
    const buyer = byName.get(persona);
    return buyer === undefined
      ? null
      : {
          kind: 'buyer' as const,
          name: buyer.name,
          description: buyer.description,
          needs: buyer.needs,
          priceSensitivity: buyer.priceSensitivity,
        };
  });
}

function baselineOf(comparison: VerdictComparison | null, context: readonly RadialSeries[]): Radial['baseline'] {
  if (comparison === null || context.length === 0) return 'none';
  return context.some((series) => series.role === 'peer') ? 'peers' : 'category';
}

/**
 * **Who hurt me.** One axis per juror, in installed order; the value is the
 * HEALTH that juror left standing — `100 - what they took`.
 *
 * The direction is deliberate and is the correction this chart needed: further
 * out is a better card, so a strong product fills the polygon and a reader's
 * instinct that a bigger shape is a better shape is right rather than backwards.
 * The dent is still where the reader looks — it is now the juror who took the
 * most, which is the same finding read the way round that the rest of the page
 * reads it.
 *

 * The axis order comes from the frozen `comparison.jurors` when the payload has
 * one. When it does not — every verdict delivered before that key existed — it
 * falls back to the order the jurors appear in on this card, which is the same
 * order for the same reason (`rank/scorecard.ts` walks the merged score log, and
 * that is the order the panel was installed in). The fallback draws no overlay,
 * so nothing is being compared across two different axis orders.
 *
 * `null` when the card has no scorecard at all, which `model.ts` already refuses
 * to parse — the guard is for the type.
 */
export function juryRadial(verdict: Verdict): Radial | null {
  const { comparison } = verdict;
  const axes = comparison === null ? rolesOnCard(verdict) : [...comparison.jurors];
  if (axes.length === 0) return null;

  const values = axes.map((role) => jurorHealth(verdict, role));
  const context = contextSeries(
    comparison,
    (peer) => asHealth(peer.jurors),
    (found) => asHealth(found.median.jurors),
  );

  return {
    polarity: 'more-is-better',
    axes,
    self: { label: verdict.name, values, role: 'self' },
    context,
    marks: axes.map((role) =>
      verdict.metrics.some((metric) => metric.substituted.includes(role)) &&
      jurorMeanCut(verdict, role) === null
        ? ('no answer' as const)
        : null,
    ),
    mandates: jurorMandates(verdict.panel, axes),
    baseline: baselineOf(comparison, context),
    unit: 'health left, out of 100',
    medianOver: comparison?.boardSize ?? 0,
    boardSize: comparison?.boardSize ?? 0,
  };
}

/**
 * **Who wanted me.** One axis per buyer, in installed order; the value is the
 * conviction behind naming this product their FIRST choice.
 *
 * `null` for a solo cluster, and that is the majority of products: `demandChart`
 * documents why a chart of zeros there would state the opposite of the truth. It
 * also means this radial always has peers when it exists — a Floor only convenes
 * on a cluster with at least two members — so its overlay is never the category
 * median standing in for a comparison that could not be made.
 *
 * A runner-up scores `0` on the axis and is MARKED. `01 §6.2` appends a strength
 * to a first pick and to nothing else, so there is no conviction number to plot
 * for a runner-up; inventing one would publish a figure nobody recorded, and
 * dropping the axis would hide a buyer who did name it. `0` with a `2nd choice`
 * mark is exactly what the run knows.
 */
export function buyerRadial(verdict: Verdict): Radial | null {
  const { comparison, floor } = verdict;
  if (floor.kind === 'solo') return null;

  const axes =
    comparison === null
      ? [...new Set(floor.picks.map((pick) => pick.persona))]
      : [...comparison.personas];
  if (axes.length === 0) return null;

  const byPersona = new Map(floor.picks.map((pick) => [pick.persona, pick]));
  const values = axes.map((persona) => {
    const pick = byPersona.get(persona);
    if (pick === undefined || pick.pick !== 'first') return 0;
    return typeof pick.strength === 'number' ? pick.strength : 0;
  });

  const context = contextSeries(
    comparison,
    (peer) => peer.personas,
    (found) => found.median.personas,
  );

  return {
    polarity: 'more-is-better',
    axes,
    self: { label: verdict.name, values, role: 'self' },
    context,
    marks: axes.map((persona) => (byPersona.get(persona)?.pick === 'second' ? ('2nd choice' as const) : null)),
    mandates: buyerMandates(verdict.panel, axes),
    baseline: baselineOf(comparison, context),
    unit: 'conviction, out of 100',
    medianOver: comparison?.votedSize ?? 0,
    boardSize: comparison?.boardSize ?? 0,
  };
}

// --- per-metric survival, with the cross-juror spread --------------------------

/** One metric's bar. Every number on it is on the same 0-100 axis. */
export interface LossBar {
  readonly metric: string;
  /**
   * **What the bar plots**: the merged score this metric KEPT, 0-100.
   *
   * The same quantity the health meter's head and both radials draw, so the whole
   * page points one way — further along the track is a better card. It used to
   * plot `cuts`, which was not wrong on its own and was wrong three sections under
   * a radial that had just been turned round to plot health: a reader scrolling
   * from one to the other had to reverse their reading of the page silently.
   */
  readonly held: number;
  /**
   * `100 - held`, the merged loss, drawn as the REMAINDER of the same track.
   *
   * Not a second bar and not a second scale: the track is the hundred points the
   * product walked in with, the `--held` part is what survived it, and this is
   * exactly the rest. It stays a first-class number because `brief` Part 5 fixes
   * `cuts` as the connective word, and the readout, the tooltip and the label all
   * still state it.
   */
  readonly cuts: number;
  readonly score: number;
  /** Cross-juror population std of the six scores, as frozen. */
  readonly spread: number;
  /** `held - spread`, clamped to the axis. The low end of the whisker. */
  readonly low: number;
  /** `held + spread`, clamped to the axis. */
  readonly high: number;
  readonly jurors: number;
  /** How many jurors took anything here. */
  readonly cutters: number;
  /** The widest spread on this card — the one metric the panel split hardest on. */
  readonly widest: boolean;
  /**
   * What the middle product on this board lost on this metric, frozen at delivery.
   *
   * `null` on a verdict delivered before the comparison was frozen. Kept because
   * the readout states the loss in words; the TICK is drawn at `categoryHeld`,
   * because a reference value has to sit on the axis it qualifies.
   */
  readonly categoryCuts: number | null;
  /**
   * `100 - categoryCuts` — what the middle product KEPT here, and where the tick goes.
   *
   * It is drawn as a tick on the same axis as the bar rather than a second bar: it
   * is a reference value, not a second measure, and `anti-patterns.md`'s first entry
   * is about exactly the temptation to give it its own scale. Turning the bar round
   * without turning this round with it would put the reference on the mirror image
   * of the axis it is meant to qualify.
   */
  readonly categoryHeld: number | null;
}

/** The per-metric figure, with the direction it reads in attached to it. */
export interface LossChart {
  /** `more-is-better`: the bar is what survived. `FIGURE_PAINT` holds the paint to it. */
  readonly polarity: Polarity;
  readonly bars: readonly LossBar[];
}

/**
 * What survived per metric, with the panel's disagreement drawn on the same axis.
 *
 * `spread` is the population standard deviation of the six jurors' scores, and
 * `held` is `mean(score)`, so the interval `held ± spread` is the interval the six
 * actually landed in — one axis, no second scale, which is what
 * `anti-patterns.md`'s first entry demands. It is the mirror of the old
 * `cuts ∓ spread` and the same width, because reflecting an axis does not change a
 * standard deviation.
 *
 * `cuts` is taken as `100 - held` rather than read off the payload's own `cuts`
 * field, which is the same number: it makes the two halves of the drawn track sum
 * to exactly the width of the track, with nothing left over and nothing overlapping,
 * which is the one thing a part-to-whole bar has to get right.
 *
 * The widest-spread metric is marked rather than every bar being annotated. It is
 * the most actionable line on the page: a deep cut the six agreed on is a fact
 * about the product, and a deep cut they split over is a fact about how it reads.
 */
export function lossChart(verdict: Verdict): LossChart {
  const widest = Math.max(0, ...verdict.metrics.map((metric) => metric.spread));
  const categoryByMetric = new Map(
    (verdict.comparison?.median.metrics ?? []).map((entry) => [entry.metric, entry.cuts]),
  );

  const bars = verdict.metrics.map((metric) => {
    const held = clamp(metric.score);
    const cutters = new Set(metric.deductions.map((deduction) => deduction.role)).size;
    const category = categoryByMetric.get(metric.metric);
    const categoryCuts = category === undefined ? null : clamp(category);
    return {
      categoryCuts,
      categoryHeld: categoryCuts === null ? null : 100 - categoryCuts,
      metric: metric.metric,
      held,
      cuts: 100 - held,
      score: metric.score,
      spread: metric.spread,
      low: clamp(held - metric.spread),
      high: clamp(held + metric.spread),
      jurors: metric.jurors,
      cutters,
      // Ties would mark two bars, which is correct: they are equally split.
      // `> 0` keeps a card where nobody disagreed from marking every bar.
      widest: widest > 0 && metric.spread === widest,
    };
  });

  return { polarity: 'more-is-better', bars };
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
  /**
   * `more-is-better`, declared for the same reason the other figures declare it.
   *
   * Its meters wear neither hue: a conviction and a capture are proportions of a
   * panel roster, not shares of the hundred points `--held` and `--cut` divide
   * between them, so they are drawn in ink. `FIGURE_PAINT` records that, and the
   * paint test holds these marks to carrying no hue at all rather than leaving
   * them unchecked.
   */
  readonly polarity: Polarity;
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
    polarity: 'more-is-better',
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
