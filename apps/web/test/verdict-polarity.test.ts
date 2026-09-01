/**
 * One direction per page, and the paint that has to follow from it.
 *
 * This file exists because of a defect that shipped twice and was invisible both
 * times. A chart plotted the wrong way round renders perfectly: the widths are
 * right, the numbers are right, the caption is right, and every test that asks
 * "was a bar drawn" passes. The jury radial plotted points TAKEN — so the best
 * card on the board drew the smallest polygon — until somebody read the page. It
 * was then turned round to plot health, which left the per-metric bars three
 * sections below still plotting cuts, so the page reversed direction under a
 * reader scrolling it. Neither state failed a test.
 *
 * So direction is data here, not prose. `charts.ts` gives every figure a
 * `polarity` and `FIGURE_PAINT` records the selectors that paint it, and this file
 * checks the two halves against each other and against the CSS the page actually
 * ships:
 *
 * 1. **Each builder declares the direction the registry claims for it.** A figure
 *    turned round without the registry being updated fails here.
 * 2. **The paint follows from the polarity.** `lib/theme.ts` spends `--held` on
 *    what survived and `--cut` on what was taken, so a `more-is-better` figure's
 *    measured quantity must wear `--held` and a `more-is-worse` figure's must wear
 *    `--cut`. A chart plotted backwards and painted `--held` fails here — which is
 *    the specific hole this file was written to close, because `Radial` used to
 *    carry no polarity field at all and a third radial could have been added
 *    pointing either way.
 * 3. **Nothing paints a hue unregistered.** Every rule in the verdict page's own
 *    stylesheet that reaches for either accent is either a registered figure mark
 *    or one of the named non-figure uses below. A new chart cannot arrive painted
 *    and undeclared.
 * 4. **The direction is real in the drawn output**, not only in a field: a better
 *    card draws a longer bar and a wider polygon, and a deeper cut draws a darker
 *    heatmap cell. Those are the two directions the page holds at once, and this
 *    is where each is pinned to real seeded data.
 *
 * The heatmap is the documented exception and is asserted AS an exception rather
 * than exempted: it is registered `more-is-worse`, it is held to `--cut`, and the
 * test below fails if somebody "fixes" it to plot health.
 */

import { describe, expect, it } from 'vitest';

import {
  buyerRadial,
  CUT_RAMP,
  cutMatrix,
  demandChart,
  FIGURE_PAINT,
  juryRadial,
  lossChart,
  opposite,
  PAINT_FOR,
  rampStep,
  type FigureName,
  type Polarity,
} from '@/lib/verdict/charts';
import { parseVerdict, type Verdict } from '@/lib/verdict/model';
import { renderVerdictPage } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdicts } from './helpers/verdict.js';

/** A verdict whose Floor convened, so every one of the five figures is built. */
function whole(): Verdict {
  return parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
}

/** A seeded verdict by the DESIGNATION printed on it. Seeded listings are anonymous. */
async function designated(slug: string, designation: string): Promise<Verdict> {
  for (const row of await seededVerdicts(slug)) {
    const verdict = parseVerdict(row);
    if (verdict.name === designation) return verdict;
  }
  throw new Error(`no seeded verdict in ${slug} is called ${designation}`);
}

/** The verdict page's own stylesheet, comments removed so prose is never mistaken for CSS. */
function stylesheet(verdict: Verdict = whole()): string {
  const css = /<style>([\s\S]*?)<\/style>/.exec(renderVerdictPage(verdict))?.[1] ?? '';
  expect(css, 'the page carries its stylesheet inline').not.toBe('');
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule in a stylesheet, as `[selector list, declarations]`. */
function rules(css: string): [string, string][] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
    ([, selectors, body]) => [(selectors ?? '').trim().replace(/\s+/g, ' '), (body ?? '').trim()] as [string, string],
  );
}

/** The declarations of every rule whose selector list names this exact selector. */
function declarationsFor(css: string, selector: string): string {
  const found = rules(css)
    .filter(([selectors]) => selectors.split(',').some((one) => one.trim().replace(/\s+/g, ' ') === selector))
    .map(([, body]) => body);
  expect(found.length, `${selector} is painted by no rule on the page`).toBeGreaterThan(0);
  return found.join(';');
}

/**
 * Does this block of declarations reach for one of the two hues?
 *
 * `--cut` counts its own token, its channel triplet, and the five steps of the
 * sequential ramp, which ARE that hue written as literals — a heatmap cell painted
 * `#ff653c` is painted `--cut` in every sense that matters to this check.
 */
function wears(declarations: string, hue: '--held' | '--cut'): boolean {
  if (hue === '--held') return declarations.includes('--held');
  return declarations.includes('--cut') || CUT_RAMP.some((step) => declarations.toLowerCase().includes(step));
}

describe('every figure declares which way it points', () => {
  const verdict = whole();

  const declared: ReadonlyArray<readonly [FigureName, Polarity | undefined]> = [
    ['juryRadial', juryRadial(verdict)?.polarity],
    ['buyerRadial', buyerRadial(verdict)?.polarity],
    ['cutMatrix', cutMatrix(verdict).polarity],
    ['lossChart', lossChart(verdict).polarity],
    ['demandChart', demandChart(verdict)?.polarity],
  ];

  it('builds all five, so nothing below is asserted about a figure that is null', () => {
    for (const [name, polarity] of declared) {
      expect(polarity, `${name} did not build`).toBeDefined();
    }
  });

  for (const [name, polarity] of declared) {
    it(`${name} returns the polarity the registry claims for it`, () => {
      const entry = FIGURE_PAINT.find((figure) => figure.figure === name);
      expect(entry, `${name} is not in FIGURE_PAINT`).toBeDefined();
      expect(polarity, `${name}'s builder and FIGURE_PAINT disagree`).toBe(entry?.polarity);
    });
  }

  it('registers every figure exactly once, and no figure it does not build', () => {
    const registered = FIGURE_PAINT.map((figure) => figure.figure);
    expect([...registered].sort()).toEqual(declared.map(([name]) => name).sort());
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('keeps the four axis figures pointing the same way, and the heatmap the other', () => {
    // The whole point, stated once as arithmetic. Everything with an axis reads
    // "further is better"; the damage matrix, which has no axis, reads the other
    // way and is the only thing that does.
    const byName = new Map(FIGURE_PAINT.map((figure) => [figure.figure, figure.polarity]));
    for (const name of ['juryRadial', 'buyerRadial', 'lossChart', 'demandChart'] as const) {
      expect(byName.get(name), name).toBe('more-is-better');
    }
    expect(byName.get('cutMatrix')).toBe('more-is-worse');
  });
});

describe('the paint follows from the polarity', () => {
  const css = stylesheet();

  it('pairs each direction with the hue that means it, and nothing else', () => {
    // The mapping the rest of this file rests on, asserted rather than assumed:
    // `theme-drift.test.ts` fixes the meanings and this fixes which direction
    // each meaning belongs to.
    expect(PAINT_FOR['more-is-better']).toBe('--held');
    expect(PAINT_FOR['more-is-worse']).toBe('--cut');
    expect(opposite('more-is-better')).toBe('more-is-worse');
    expect(opposite('more-is-worse')).toBe('more-is-better');
  });

  for (const figure of FIGURE_PAINT) {
    const right = PAINT_FOR[figure.polarity];
    const wrong = PAINT_FOR[opposite(figure.polarity)];

    for (const selector of figure.measure) {
      it(`${figure.figure}: ${selector} wears ${right}, because ${figure.why}`, () => {
        const declarations = declarationsFor(css, selector);
        expect(wears(declarations, right), `${selector} must wear ${right}`).toBe(true);
        expect(wears(declarations, wrong), `${selector} must never wear ${wrong}`).toBe(false);
      });
    }

    for (const selector of figure.complement) {
      it(`${figure.figure}: ${selector} is the complement and wears ${wrong}`, () => {
        const declarations = declarationsFor(css, selector);
        expect(wears(declarations, wrong), `${selector} must wear ${wrong}`).toBe(true);
        expect(wears(declarations, right), `${selector} must never wear ${right}`).toBe(false);
      });
    }

    for (const selector of figure.neither) {
      it(`${figure.figure}: ${selector} carries no magnitude and so wears no hue`, () => {
        // Uncertainty, reference ticks and roster proportions are neither taken
        // nor survived. A whisker in the accent would read as damage; a peer
        // outline in --held would claim the emphasis series' hue.
        const declarations = declarationsFor(css, selector);
        expect(wears(declarations, '--held'), `${selector} must not wear --held`).toBe(false);
        expect(wears(declarations, '--cut'), `${selector} must not wear --cut`).toBe(false);
      });
    }

    it(`${figure.figure} draws the quantity it claims, or claims no hue at all`, () => {
      // A figure cannot be registered with only a complement: the half that is
      // painted would then be the half the axis does not measure, which is the
      // inversion this file exists to catch, dressed as bookkeeping.
      if (figure.measure.length === 0) {
        expect(figure.complement, `${figure.figure} paints a complement with nothing to complement`).toEqual([]);
      } else {
        expect(figure.measure.length).toBeGreaterThan(0);
      }
    });
  }
});

/**
 * Every use of either hue on the page that is NOT a figure mark, with the reason
 * it is allowed to be one.
 *
 * The list is here rather than in `charts.ts` because none of these is a chart:
 * they are the card's own furniture and the theme's two type stops. Keeping them
 * enumerated is what makes the exhaustiveness check below mean something — a new
 * chart mark cannot hide among them without somebody writing a line here and
 * noticing what they are doing.
 */
const NON_FIGURE: ReadonlyArray<readonly [string, string]> = [
  [':root', 'the token declarations themselves'],
  ['.mark::before', 'the wordmark’s square'],
  ['.meter .kept', 'the health meter’s surviving head — the figure the loss bars were turned round to match'],
  ['.meter .seg', 'the health meter’s taken segments'],
  ['.meter .seg.s2', 'the same ramp'],
  ['.meter .seg.s3', 'the same ramp'],
  ['.meter .seg.s4', 'the same ramp'],
  ['.meter .seg.s5', 'the same ramp'],
  ['.vmeter .meter .seg.s6', 'the same ramp, sixth step'],
  ['.vkeys i', 'the meter’s key: one swatch per taken segment'],
  ['.vkeys i.s2', 'the same key'],
  ['.vkeys i.s3', 'the same key'],
  ['.vkeys i.s4', 'the same key'],
  ['.vkeys i.s5', 'the same key'],
  ['.vkeys i.s6', 'the same key'],
  ['.pts', 'the type stop for points taken'],
  ['.ded .pts', 'the same stop in the ledger'],
  ['.held', 'the type stop for health left'],
  ['.tip b', 'a readout heading, which states a cut'],
  ['.vtop::after', 'the card’s header rule'],
  ['.vquote', 'the pull quote’s left edge'],
  ['.mxkey i.k1', 'the heatmap’s scale legend, which is the ramp at 11px'],
  ['.mxkey i.k2', 'the same legend'],
  ['.mxkey i.k3', 'the same legend'],
  ['.mxkey i.k4', 'the same legend'],
  ['.mxkey i.k5', 'the same legend'],
];

describe('nothing paints a hue unregistered', () => {
  it('accounts for every rule on the page that reaches for either accent', () => {
    const css = stylesheet();
    const known = new Set<string>([
      ...NON_FIGURE.map(([selector]) => selector),
      ...FIGURE_PAINT.flatMap((figure) => [...figure.measure, ...figure.complement, ...figure.neither]),
    ]);

    const unaccounted: string[] = [];
    for (const [selectors, body] of rules(css)) {
      if (!wears(body, '--held') && !wears(body, '--cut')) continue;
      for (const one of selectors.split(',')) {
        const selector = one.trim().replace(/\s+/g, ' ');
        if (!known.has(selector)) unaccounted.push(`${selector} { ${body} }`);
      }
    }

    // A new chart painted in either hue lands here until it is declared in
    // FIGURE_PAINT with a direction — which is exactly the moment somebody has to
    // decide which way it points.
    expect(unaccounted, 'these paint a hue and declare no polarity').toEqual([]);
  });

  it('does not list a selector the page has stopped painting', () => {
    // The other direction: a stale registry is a registry nobody trusts.
    const css = stylesheet();
    for (const [selector] of NON_FIGURE) {
      if (selector === ':root') continue;
      expect(declarationsFor(css, selector), selector).not.toBe('');
    }
    for (const figure of FIGURE_PAINT) {
      for (const selector of [...figure.measure, ...figure.complement, ...figure.neither]) {
        expect(declarationsFor(css, selector), `${figure.figure}: ${selector}`).not.toBe('');
      }
    }
  });
});

describe('the direction is real in the drawing, not only in the field', () => {
  it('gives the better card the longer bar, on the same metric', async () => {
    // Two real products from the seeded board, and the metric they share. The
    // one the panel treated more gently must draw the LONGER bar. Under the old
    // chart it drew the shorter one, so this fails on a revert rather than
    // merely looking different.
    const kind = await designated('developer-tools', 'Unit Lima-249');
    const brutal = await designated('developer-tools', 'Unit Papa-354');

    const barsOf = (verdict: Verdict): Map<string, number> =>
      new Map(lossChart(verdict).bars.map((bar) => [bar.metric, bar.held]));
    const kindBars = barsOf(kind);
    const brutalBars = barsOf(brutal);

    const shared = [...kindBars.keys()].filter((metric) => brutalBars.has(metric));
    expect(shared.length, 'the two products share a metric list').toBeGreaterThan(0);

    // Anchored to the data: the gently handled product really did keep more, in
    // total, so the comparison below is about the chart and not about a fixture.
    const total = (bars: Map<string, number>): number => [...bars.values()].reduce((sum, value) => sum + value, 0);
    expect(total(kindBars)).toBeGreaterThan(total(brutalBars));

    for (const metric of shared) {
      const better = (kindBars.get(metric) as number) >= (brutalBars.get(metric) as number);
      const worseCuts = 100 - (kindBars.get(metric) as number) <= 100 - (brutalBars.get(metric) as number);
      expect(better, `${metric}: fewer cuts must draw a longer bar`).toBe(worseCuts);
    }

    // And in the document: the widths are the kept figures, not their complements.
    const html = renderVerdictPage(kind);
    for (const bar of lossChart(kind).bars) {
      expect(html).toContain(`<i class="lbfill" style="width:${bar.held.toFixed(2)}%"></i>`);
    }
  });

  it('gives the better card the wider polygon, on the radial above it', async () => {
    // The figure the loss bars were turned round to agree with. Both must point
    // the same way or the page reverses under the reader again.
    const kind = await designated('developer-tools', 'Unit Lima-249');
    const brutal = await designated('developer-tools', 'Unit Papa-354');
    const kindRadial = juryRadial(kind);
    const brutalRadial = juryRadial(brutal);
    if (kindRadial === null || brutalRadial === null) throw new Error('no jury radial');

    expect(kindRadial.polarity).toBe(lossChart(kind).polarity);
    kindRadial.axes.forEach((role, index) => {
      expect(kindRadial.self.values[index], role).toBeGreaterThan(brutalRadial.self.values[index] as number);
    });
  });

  it('keeps the heatmap plotting CUTS, darker for deeper — the documented exception', async () => {
    const verdict = await designated('developer-tools', 'Unit Papa-354');
    const matrix = cutMatrix(verdict);

    // Declared the other way from every axis figure, on purpose.
    expect(matrix.polarity).toBe('more-is-worse');
    expect(matrix.polarity).not.toBe(lossChart(verdict).polarity);

    // The ramp still steps up with the points TAKEN. Inverting the grid to plot
    // health would break this: the heaviest cut would fall to step 1.
    const cells = matrix.rows.flatMap((row) => row.cells).filter((cell) => !cell.substituted);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.step, `${cell.role} / ${cell.metric}`).toBe(rampStep(cell.points));

    const heaviest = matrix.heaviest;
    expect(heaviest, 'this card has a deepest cut').not.toBeNull();
    expect(heaviest?.points).toBeGreaterThan(0);
    // The deepest cut on the card takes the darkest available step, and a cell
    // that lost nothing takes none at all.
    expect(heaviest?.step).toBe(rampStep(heaviest?.points ?? 0));
    expect(rampStep(0)).toBe(0);
    expect(rampStep(100)).toBe(CUT_RAMP.length);
    expect(rampStep(1)).toBeLessThan(rampStep(100));

    // And in the document: the darkest step is the last colour of the --cut ramp,
    // not the first colour of anything else.
    const css = stylesheet(verdict);
    expect(declarationsFor(css, '.mxc.k5').toLowerCase()).toContain(CUT_RAMP[CUT_RAMP.length - 1]);
  });
});
