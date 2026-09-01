/**
 * The two radials, and the rules that make a radial honest here.
 *
 * A previous pass refused a radial on this page and was right at the time: a
 * polygon with nothing overlaid is a worse bar chart, and the payload carried
 * nothing to overlay. Three things had to become true before it was not, and each
 * one is a test below.
 *
 * 1. **The axis order is fixed and shared.** Otherwise the shape a reader
 *    remembers is an artefact of drawing order and two shapes are not comparable.
 * 2. **No magnitude is read off the polygon.** Area grows as the square of the
 *    value and always will, so every figure is printed on its axis and repeated
 *    in a table twin — which is also the accessible answer to identity-by-shape.
 * 3. **The overlay is frozen, and absent when it was not frozen.** A verdict
 *    delivered before the comparison existed draws no overlay and does not
 *    fabricate one; a solo cluster compares against the category and says so.
 *
 * Plus the rule the founder's anonymity decision adds: a peer's shape may appear
 * on this page, but a peer's NAME may not unless that peer chose to be named.
 */

import { describe, expect, it } from 'vitest';

import { buyerRadial, juryRadial, jurorHealth, jurorMeanCut, lossChart } from '@/lib/verdict/charts';
import { parseComparison, parseVerdict, type Verdict } from '@/lib/verdict/model';
import { renderVerdictPage, wrapAxisLabel } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdictNamed, seededVerdicts } from './helpers/verdict.js';

/** A seeded verdict whose cluster has peers. */
async function withPeers(slug: string): Promise<Verdict> {
  for (const row of await seededVerdicts(slug)) {
    const verdict = parseVerdict(row);
    if ((verdict.comparison?.peers.length ?? 0) > 0) return verdict;
  }
  throw new Error(`no seeded verdict in ${slug} has cluster peers`);
}

/**
 * A seeded verdict by the DESIGNATION printed on it.
 *
 * `seededVerdictNamed` resolves against the raw board, which carries the real
 * submitted name; every seeded listing is anonymous, so the frozen payload
 * carries a call sign instead. When a test is about the shape a particular
 * product draws, the call sign is the only stable handle it has.
 */
async function seededVerdictDesignated(slug: string, designation: string): Promise<Verdict> {
  for (const row of await seededVerdicts(slug)) {
    const parsed = parseVerdict(row);
    if (parsed.name === designation) return parsed;
  }
  throw new Error(`no seeded verdict in ${slug} designated ${designation}`);
}

/** The real product names on a board, for proving none of them leaked. */
async function boardNames(slug: string): Promise<string[]> {
  return (await seededVerdicts(slug)).map((row) => {
    const payload = row.payload as { verdict: { name: string } };
    return payload.verdict.name;
  });
}

describe('the axes are the installed panel, and every shape shares them', () => {
  it('draws the jury axes in the frozen roster order', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');

    expect(radial.axes).toEqual(verdict.comparison?.jurors);
    expect(radial.axes.length).toBe(6);
    // Every series is the same length as the axis list, which is what makes
    // position on the chart mean the same thing for all of them.
    for (const series of [radial.self, ...radial.context]) {
      expect(series.values.length, series.label).toBe(radial.axes.length);
    }
  });

  it('draws the buyer axes in the run’s own persona order', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = buyerRadial(verdict);
    if (radial === null) throw new Error('no buyer radial');

    expect(radial.axes).toEqual(verdict.comparison?.personas);
    for (const series of [radial.self, ...radial.context]) {
      expect(series.values.length, series.label).toBe(radial.axes.length);
    }
  });
});

describe('every plotted value derives from the payload', () => {
  it('plots the health each juror LEFT, over the metrics they answered', async () => {
    // The rule this has always protected — the plotted number is that juror's
    // own arithmetic over the metrics they actually scored — is unchanged. What
    // changed is the direction: the axis is the health left standing, not the
    // points taken, so `100 - cuts` is what has to come out.
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');

    radial.axes.forEach((role, index) => {
      // Recomputed here from the parsed ledger by a different route than the
      // chart takes, so a broken derivation cannot agree with itself.
      let points = 0;
      let answered = 0;
      for (const metric of verdict.metrics) {
        if (metric.substituted.includes(role)) continue;
        answered += 1;
        for (const deduction of metric.deductions) if (deduction.role === role) points += deduction.points;
      }
      expect(radial.self.values[index], role).toBe(answered === 0 ? null : 100 - points / answered);
    });

    // And it is a live quantity: at least one juror took something off this card,
    // so at least one axis sits short of a full 100.
    expect(radial.self.values.some((value) => value !== null && value < 100)).toBe(true);
  });

  it('points the health axis so that fewer cuts draws a BIGGER polygon', async () => {
    // The bug this replaces, stated as arithmetic. The chart used to plot points
    // taken, so the best card on the board drew the smallest shape and a reader's
    // instinct that bigger is better was exactly backwards. Two real products,
    // one gently handled and one taken apart: the gently handled one must now be
    // the larger shape on every axis it wins, and by area.
    const kind = await seededVerdictDesignated('developer-tools', 'Unit Lima-249');
    const brutal = await seededVerdictDesignated('developer-tools', 'Unit Papa-354');

    const kindRadial = juryRadial(kind);
    const brutalRadial = juryRadial(brutal);
    if (kindRadial === null || brutalRadial === null) throw new Error('no jury radial');
    expect(kindRadial.axes).toEqual(brutalRadial.axes);

    // The one that was cut LESS took fewer points, so under the old cuts axis it
    // was the smaller shape. Assert that fact first, so this test is anchored to
    // the real data rather than to a fixture that happens to agree.
    const cuts = (verdict: Verdict): number =>
      (juryRadial(verdict) as NonNullable<ReturnType<typeof juryRadial>>).axes.reduce(
        (sum, role) => sum + (jurorMeanCut(verdict, role) ?? 0),
        0,
      );
    expect(cuts(kind)).toBeLessThan(cuts(brutal));

    // Radar area is proportional to the sum of adjacent-radius products, so a
    // shape that is further out on every axis is strictly larger. Both hold.
    const area = (values: readonly (number | null)[]): number =>
      values.reduce<number>(
        (sum, value, index) => sum + (value ?? 0) * (values[(index + 1) % values.length] ?? 0),
        0,
      );
    kindRadial.axes.forEach((role, index) => {
      expect(kindRadial.self.values[index], role).toBeGreaterThan(brutalRadial.self.values[index] as number);
    });
    expect(area(kindRadial.self.values)).toBeGreaterThan(area(brutalRadial.self.values));
  });

  it('keeps the axis at 0–100 with zero at the centre, and never rebases it', async () => {
    // The tempting "fix" once the chart plots health: most shapes crowd the outer
    // band, so start the axis at 50 or 60 and the differences look bigger. It is
    // a lie twice over — radar area already goes as the square of the radius, and
    // there is no axis line on a radar for a reader to catch the baseline on.
    // This test fails the moment a baseline is introduced.
    const verdict = await withPeers('developer-tools');
    const html = renderVerdictPage(verdict);

    // The geometry is stated in the SVG itself: a value of 0 lands exactly on the
    // centre point of the plot, and the outer ring is 100. Both radials share it.
    const box = /viewBox="0 0 (\d+) (\d+)"[^>]*role="img"/.exec(html);
    expect(box, 'the radial declares its own viewBox').not.toBeNull();

    const rings = [...html.matchAll(/<polygon class="rring(?: rout)?" points="([^"]+)"/g)].map((match) =>
      (match[1] as string).split(' ').map((pair) => pair.split(',').map(Number) as [number, number]),
    );
    expect(rings.length, 'four rings on each of the two charts').toBe(8);

    // Every chart's rings are concentric about one centre, and the radii step in
    // equal quarters from it: 25/50/75/100 of a scale whose zero IS that centre.
    // A baseline at 50 would make the innermost ring a radius of 0 or the rings
    // unevenly spaced; either way this arithmetic breaks.
    for (let chart = 0; chart < 2; chart += 1) {
      const four = rings.slice(chart * 4, chart * 4 + 4);
      const outer = four[3] as [number, number][];
      const cx = outer.reduce((sum, [x]) => sum + x, 0) / outer.length;
      const cy = outer.reduce((sum, [, y]) => sum + y, 0) / outer.length;
      const radii = four.map((ring) => Math.hypot((ring[0] as [number, number])[0] - cx, (ring[0] as [number, number])[1] - cy));
      const unit = (radii[3] as number) / 100;
      expect(radii[0] as number).toBeCloseTo(unit * 25, 1);
      expect(radii[1] as number).toBeCloseTo(unit * 50, 1);
      expect(radii[2] as number).toBeCloseTo(unit * 75, 1);
    }

    // And it is said out loud, so a reader never has to infer it.
    expect(html).toContain('The centre is 0 and the outer ring is 100');
  });

  it('paints the health polygon --held, the hue that means survived', () => {
    // The page's own CSS, asserted as a fact. `theme-drift.test.ts` fixes the two
    // meanings — --cut for what was taken, --held for what survived — and a chart
    // of the health a juror LEFT drawn in the colour for what they TOOK says the
    // opposite of its caption. It is also the error this page has already shipped
    // once.
    const css = renderVerdictPage(parseVerdict(handBuiltVerdict({ demandStatus: 'scored' })));
    for (const selector of ['.rj .rself', '.rj .rdot', '.rb .rself', '.rb .rdot']) {
      const rule = new RegExp(`${selector.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      expect(rule, `${selector} must be painted`).not.toBe('');
      expect(rule, `${selector} must wear --held`).toContain('--held');
      expect(rule, `${selector} must never wear --cut`).not.toContain('--cut');
    }
    // The legend swatch is the same mark at 14px and has to agree with it.
    const swatch = /\.rj \.rkey i\.rself[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(swatch).toContain('--held');
    expect(swatch).not.toContain('--cut');
  });

  it('plots conviction only where a buyer made it their first choice', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = buyerRadial(verdict);
    if (radial === null || verdict.floor.kind !== 'convened') throw new Error('no convened floor');

    radial.axes.forEach((persona, index) => {
      const pick = verdict.floor.kind === 'convened'
        ? verdict.floor.picks.find((candidate) => candidate.persona === persona)
        : undefined;
      const expected = pick?.pick === 'first' ? (pick.strength ?? 0) : 0;
      expect(radial.self.values[index], persona).toBe(expected);
      // A runner-up is a zero WITH a mark. `01 §6.2` records a strength on a
      // first pick and on nothing else, so a number here would be invented — and
      // an unmarked zero would read as a buyer who never named it.
      expect(radial.marks[index], persona).toBe(pick?.pick === 'second' ? '2nd choice' : null);
    });
  });

  it('carries the peer’s own frozen figures onto the peer’s own shape', async () => {
    const verdict = await withPeers('health-fitness-wellness');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');

    const peers = radial.context.filter((series) => series.role === 'peer');
    expect(peers.length).toBe(verdict.comparison?.peers.length);

    // The payload freezes what each juror TOOK from that peer, and `verdicts`
    // refuses UPDATE, so the inversion happens on the read. The rule the test
    // protects is unchanged — the peer's own frozen figures, on the peer's own
    // shape, on the same scale as the subject — but the scale is now health, and
    // a peer left on the cuts scale would be a shape pointing the other way.
    const frozen = [...(verdict.comparison?.peers ?? [])].sort((a, b) => a.rank - b.rank);
    peers.forEach((series, index) => {
      expect(series.values).toEqual((frozen[index]?.jurors ?? []).map((cut) => (cut === null ? null : 100 - cut)));
    });
    // And it really is an inversion of a live quantity, not a row of nulls.
    expect(peers.some((series) => series.values.some((value) => value !== null && value < 100))).toBe(true);
  });

  it('puts the frozen category median on the loss bars, on the bar’s own axis', async () => {
    const verdict = await withPeers('developer-tools');
    const { bars } = lossChart(verdict);
    const medians = new Map(
      (verdict.comparison?.median.metrics ?? []).map((entry) => [entry.metric, entry.cuts]),
    );

    expect(medians.size).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.categoryCuts, bar.metric).toBe(medians.get(bar.metric));
      // The bar's own axis is now what SURVIVED, so the tick has to be inverted
      // with it or the reference sits on the mirror image of the axis it
      // qualifies.
      expect(bar.categoryHeld, bar.metric).toBe(100 - (medians.get(bar.metric) as number));
    }
  });

  it('exposes the same arithmetic the freezer used, so self and peers share a scale', async () => {
    const verdict = await withPeers('developer-tools');
    const role = verdict.comparison?.jurors[0];
    if (role === undefined) throw new Error('no roster');
    // If these ever diverge the two shapes are drawn on different scales and the
    // comparison silently stops meaning anything. The freezer's arithmetic is
    // still `jurorMeanCut`; the chart is its complement, and `jurorHealth` is the
    // single place that complement is taken.
    expect(juryRadial(verdict)?.self.values[0]).toBe(jurorHealth(verdict, role));
    expect(jurorHealth(verdict, role)).toBe(100 - (jurorMeanCut(verdict, role) as number));
  });
});

describe('the table twin lists the numbers the shapes encode', () => {
  it('repeats every series on every axis, as text', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');
    const html = renderVerdictPage(verdict, { origin: 'https://thepit.show' });

    const table = /<table><caption>The Panel — who hurt you[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(table, 'the jury radial has a table twin').not.toBe('');

    for (const axis of radial.axes) expect(table).toContain(axis);
    for (const series of [radial.self, ...radial.context]) {
      for (const value of series.values) {
        if (value === null) continue;
        expect(table, `${series.label} ${value}`).toContain(`<td>${value.toFixed(1)}</td>`);
      }
    }
  });

  it('draws a polygon whose vertices decode back to the table’s own numbers', async () => {
    // The table twin is only a twin if the shape and the numbers say the same
    // thing. This walks the rendered path back to a value per axis — radius over
    // the outer ring's radius, times 100 — and checks it against the figure the
    // table prints. It fails if the plot is ever rebased, rescaled, or inverted
    // away from the numbers beside it.
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');
    const html = renderVerdictPage(verdict);

    const outer = /<polygon class="rring rout" points="([^"]+)"/.exec(html)?.[1] ?? '';
    const ring = outer.split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);
    expect(ring.length).toBe(radial.axes.length);
    const cx = ring.reduce((sum, [x]) => sum + x, 0) / ring.length;
    const cy = ring.reduce((sum, [, y]) => sum + y, 0) / ring.length;
    const unit = Math.hypot((ring[0] as [number, number])[0] - cx, (ring[0] as [number, number])[1] - cy) / 100;

    const path = /<path class="rp rself" d="([^"]+)"/.exec(html)?.[1] ?? '';
    const vertices = [...path.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(
      (match) => [Number(match[1]), Number(match[2])] as [number, number],
    );
    // Every axis with a value is a vertex; a `no answer` axis is skipped rather
    // than plotted at the centre, which on a health axis would draw a total
    // collapse out of a juror's silence.
    const plotted = radial.self.values.filter((value) => value !== null) as number[];
    expect(vertices.length).toBe(plotted.length);

    vertices.forEach(([x, y], index) => {
      expect(Math.hypot(x - cx, y - cy) / unit, radial.axes[index]).toBeCloseTo(plotted[index] as number, 1);
    });

    const table = /<table><caption>The Panel — who hurt you[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    for (const value of plotted) expect(table).toContain(`<td>${value.toFixed(1)}</td>`);
  });

  it('bridges an axis nobody answered instead of plotting it at the centre', () => {
    // Under the old cuts axis a silent juror at the centre drew nothing and cost
    // nothing. On a health axis the centre means "left you with zero", so the
    // absence of a finding would render as the worst finding on the chart. The
    // outline steps over the axis, no vertex dot is drawn, and the label and the
    // table both still say so.
    const base = parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
    const radial = juryRadial(base);
    if (radial === null) throw new Error('no jury radial');

    const mute = radial.axes[0] as string;
    const silenced: Verdict = {
      ...base,
      metrics: base.metrics.map((metric) => ({
        ...metric,
        substituted: [...metric.substituted, mute],
        deductions: metric.deductions.filter((deduction) => deduction.role !== mute),
      })),
    };
    const quiet = juryRadial(silenced);
    if (quiet === null) throw new Error('no jury radial');
    // The fallback roster reorders when a juror stops appearing in a deduction
    // list, so the silenced axis is found by name and not by position.
    const at = quiet.axes.indexOf(mute);
    expect(at).toBeGreaterThan(-1);
    expect(quiet.self.values[at]).toBeNull();
    expect(quiet.marks[at]).toBe('no answer');

    const html = renderVerdictPage(silenced);
    const path = /<path class="rp rself" d="([^"]+)"/.exec(html)?.[1] ?? '';
    const vertices = [...path.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)];
    // One fewer vertex than there are axes, and the polygon still closes.
    expect(vertices.length).toBe(quiet.axes.length - 1);
    expect(path.endsWith(' Z')).toBe(true);
    expect(html).toContain('>no answer</tspan>');
    // The table says the same thing, as an em dash rather than a zero.
    expect(html).toContain('(no answer)</th><td>&mdash;</td>');
  });

  it('gives every axis a visible figure on the chart, so no value is colour-only', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');
    const html = renderVerdictPage(verdict);

    for (const value of radial.self.values) {
      if (value === null) continue;
      expect(html).toContain(`class="rv" x=`);
      expect(html).toContain(`>${value.toFixed(1)}</tspan>`);
    }
  });

  it('names the axis in full even when the drawn label had to wrap', () => {
    // The wrap is for the plot, not for the record. A silently chopped juror
    // role on the chart with no full form anywhere would be a name this page
    // invented.
    expect(wrapAxisLabel('The Terminal Minimalist').join(' ')).toBe('The Terminal Minimalist');
    // A hyphen is a break opportunity, so the wrap happens after it rather than
    // chopping the word in half.
    expect(wrapAxisLabel('The Self-Experimenter')).toEqual(['The Self-', 'Experimenter']);
    // An over-long single word is broken, never dropped, and an over-long label
    // ends in a visible ellipsis rather than looking complete.
    // A single word too long for one line is broken across lines and every
    // character survives the break.
    const long = 'Supercalifragilisticexpialidocious';
    expect(wrapAxisLabel(long).join('')).toBe(long);
    // A label too long even for three lines ends in a visible ellipsis, so it
    // never reads as a complete name that happens to be short.
    const overlong = wrapAxisLabel('A'.repeat(60));
    expect(overlong).toHaveLength(3);
    expect(overlong.join('')).toContain('…');
  });
});

describe('a verdict with no frozen comparison draws no overlay', () => {
  it('renders the shape alone and fabricates nothing', () => {
    // `handBuiltVerdict` is the shape `seed/build.ts` froze BEFORE comparisons
    // existed. `verdicts` refuses UPDATE and is never backfilled, so this is a
    // permanent class of page and not a migration step.
    const verdict = parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
    expect(verdict.comparison).toBeNull();

    const jury = juryRadial(verdict);
    const buyers = buyerRadial(verdict);
    expect(jury?.context).toEqual([]);
    expect(jury?.baseline).toBe('none');
    expect(buyers?.context).toEqual([]);

    const html = renderVerdictPage(verdict);
    expect(html).toContain('issued before comparisons were frozen');
    // Nothing on the page claims a peer or a category middle.
    expect(html).not.toContain('Category median');
    expect(html).not.toContain('Peer 1');
    expect(html).not.toContain('Which outline is which');
    // And the loss bars carry no median tick rather than one at an invented place.
    expect(lossChart(verdict).bars.every((bar) => bar.categoryCuts === null && bar.categoryHeld === null)).toBe(
      true,
    );
    expect(html).not.toContain('lbmed" style');
  });

  it('still draws the product’s own shape, on the axes the card supplies', () => {
    const verdict = parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
    const jury = juryRadial(verdict);
    if (jury === null) throw new Error('no jury radial');

    // Fallback roster: the jurors who appear on this card, in the order the
    // engine emitted them.
    expect(jury.axes).toContain('The Release Engineer');
    expect(jury.self.values.some((value) => (value ?? 0) > 0)).toBe(true);
  });

  it('drops a comparison it cannot read rather than taking the page down', () => {
    // A malformed comparison is a bug in the freezer. The response is no overlay,
    // not a 500 on a permanent public page somebody paid for.
    expect(parseComparison(undefined)).toBeNull();
    expect(parseComparison({ jurors: ['A'], personas: [] })).toBeNull();
    // A peer row of the wrong length would plot one juror's number on another
    // juror's axis, which is worse than plotting nothing.
    expect(
      parseComparison({
        jurors: ['A', 'B'],
        personas: ['P'],
        median: { jurors: [1, 2], personas: [3], metrics: [] },
        peers: [{ label: 'x', anonymous: true, slug: null, avatarSeed: 's', rank: 1, jurors: [1], personas: [2] }],
        boardSize: 4,
        votedSize: 2,
      }),
    ).toBeNull();
  });
});

describe('a solo cluster compares against the category, and says so', () => {
  it('overlays the category median and names it as the category, not a rival', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon'));
    expect(verdict.floor.kind).toBe('solo');
    expect(verdict.comparison?.peers).toEqual([]);

    const jury = juryRadial(verdict);
    if (jury === null) throw new Error('no jury radial');
    expect(jury.baseline).toBe('category');
    expect(jury.context.map((series) => series.role)).toEqual(['median']);
    // Inverted onto the health axis with the subject, or the only baseline on
    // the page would point the opposite way from the shape it is a baseline for.
    expect(jury.context[0]?.values).toEqual(
      (verdict.comparison?.median.jurors ?? []).map((cut) => (cut === null ? null : 100 - cut)),
    );

    const html = renderVerdictPage(verdict);
    expect(html).toContain('Nothing else was in this cluster');
    expect(html).toContain('the middle of the category');
    expect(html).toContain('not a rival');
    expect(html).toContain(`${verdict.comparison?.boardSize} products`);
    // No peer is invented to fill the chart.
    expect(html).not.toContain('Peer 1');
  });

  it('draws no buyer radial at all, because no buyer was ever shown it', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon'));
    // A chart of zeros would say "six buyers looked at you and none wanted you".
    // `DECISIONS.md` S3 is that nobody was shown it. The Floor section states it.
    expect(buyerRadial(verdict)).toBeNull();

    const html = renderVerdictPage(verdict);
    // No buyer figure at all, and the heading does not promise one.
    expect(html).not.toContain('class="rfig rb"');
    expect(html).toContain('<h2>Who hurt you</h2>');
    expect(html).toContain('No buyers were shown this product');
  });

  it('gives its one chart the whole row instead of an empty second column', async () => {
    // 32 of 48 Developer Tools rows and 26 of 44 Health rows are a cluster of
    // one, so this is the MAJORITY layout. A two-column grid with one figure in
    // it prints a hole where the buyers chart would be, and a solo verdict is
    // exactly the page with the fewest other things to look at.
    const solo = parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon'));
    const soloHtml = renderVerdictPage(solo);

    expect(soloHtml).toContain('<div class="rgrid rsolo">');
    expect(soloHtml).not.toContain('<div class="rgrid rpair">');
    // Exactly one figure in the grid, and no placeholder standing in for the
    // other: an empty slot is what this test exists to catch.
    expect((soloHtml.match(/<figure class="rfig /g) ?? []).length).toBe(1);
    expect(soloHtml).not.toContain('<figure class="rfig rb"');

    // A verdict that HAS both charts still gets both, and the class still says
    // which page this is.
    const paired = await withPeers('developer-tools');
    const pairedHtml = renderVerdictPage(paired);
    expect(pairedHtml).toContain('<div class="rgrid rpair">');
    expect((pairedHtml.match(/<figure class="rfig /g) ?? []).length).toBe(2);
  });

  it('lays every radial out the same way, on the page’s own rails', async () => {
    // The layout used to fork: a solo verdict put its chart in one column and
    // its words in the other, and a PAIR put two charts side by side in a band
    // that broke 120px out of the 820px column on either side. That band was the
    // only element on the page not aligned to its own heading — and a founder
    // reading it said so. One rule now, for one figure or two, and it is the
    // rule the majority case already used.
    const paired = await withPeers('developer-tools');
    const solo = parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon'));

    for (const html of [renderVerdictPage(paired), renderVerdictPage(solo)]) {
      // Chart in the wide column, the words that explain it in the narrow one.
      expect(html).toContain('.rfig{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(228px,1fr)');
      expect(html).toContain('grid-template-areas:"t t" "chart side"');
      // The grid itself stacks its figures and never columns them, so two charts
      // are two rows rather than a wider band.
      expect(html).toContain('.rgrid{display:grid;gap:22px;margin-top:16px;grid-template-columns:minmax(0,1fr)}');
      expect(html).not.toMatch(/\.rgrid[^{]*\{[^}]*minmax\(0,1fr\) minmax\(0,1fr\)/);
      // And nothing in the radial CSS reaches outside the measure any more.
      expect(html).not.toContain('.rgrid{margin-inline:-');
      expect(html).not.toMatch(/margin-inline:-\d+px/);
    }
  });

  it('keeps the polygon the size the enlargement made it', async () => {
    // The founder's first complaint was that the radials read as small, and R
    // went 86 -> 112 to answer it. The second complaint — that the pair takes
    // too much room — must not be answered by taking that back. So the plot is
    // still 112 of its own frame's radius, and the frame spends MORE of itself
    // on the plot than it did: 224 of 360 where it was 224 of 372.
    const html = renderVerdictPage(await withPeers('developer-tools'));
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(html);
    expect(box).not.toBeNull();

    const width = Number(box?.[1]);
    const rings = [...html.matchAll(/<polygon class="rring rout" points="([^"]+)"/g)].map((match) =>
      (match[1] as string).split(' ').map((pair) => pair.split(',').map(Number) as [number, number]),
    );
    expect(rings.length, 'one outer ring per chart').toBe(2);

    const outer = rings[0] as [number, number][];
    const cx = outer.reduce((sum, [x]) => sum + x, 0) / outer.length;
    const cy = outer.reduce((sum, [, y]) => sum + y, 0) / outer.length;
    const radius = Math.hypot((outer[0] as [number, number])[0] - cx, (outer[0] as [number, number])[1] - cy);

    expect(radius).toBeCloseTo(112, 1);
    // The share of the frame the plot occupies, which is the number that went up.
    expect((2 * radius) / width).toBeGreaterThan(0.62);
  });
});

describe('a peer’s shape may be shown; a peer’s name may not', () => {
  it('labels the outlines positionally and never with a withheld name', async () => {
    const verdict = await withPeers('health-fitness-wellness');
    const html = renderVerdictPage(verdict, { origin: 'https://thepit.show' });
    const names = await boardNames('health-fitness-wellness');

    expect(html).toContain('Peer 1');
    expect(html).toContain('Which outline is which');

    for (const peer of verdict.comparison?.peers ?? []) {
      expect(peer.anonymous, 'the seeded boards are anonymous by default').toBe(true);
      expect(peer.slug).toBeNull();
      expect(html).toContain(peer.label);
      // The pseudonym is what appears; the real name is not on the page in any
      // form, and there is no link that would resolve to it.
      expect(html).not.toContain(`/v/${String(peer.slug)}`);
    }

    for (const name of names) {
      if (name === verdict.name) continue;
      expect(html, `${name} leaked onto another product's verdict`).not.toContain(name);
    }
  });

  it('reserves the avatar slot without drawing one', async () => {
    const verdict = await withPeers('health-fitness-wellness');
    const html = renderVerdictPage(verdict);

    // The deterministic robot belongs to the identity module. This page supplies
    // the stable seed it is drawn from and stops there — and the seed is never
    // the product name.
    for (const peer of verdict.comparison?.peers ?? []) {
      expect(html).toContain(`data-avatar-seed="${peer.avatarSeed}"`);
      expect(peer.avatarSeed).not.toContain(peer.label);
    }
    // Still no image on a downloadable, offline-safe page.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('links a named peer to its own page, and an anonymous one nowhere', async () => {
    const verdict = await withPeers('health-fitness-wellness');
    const named: Verdict = {
      ...verdict,
      comparison: {
        ...(verdict.comparison as NonNullable<Verdict['comparison']>),
        peers: (verdict.comparison?.peers ?? []).map((peer, index) =>
          index === 0
            ? { ...peer, anonymous: false, label: 'Openly Named Co', slug: 'abc123' }
            : peer,
        ),
      },
    };

    const html = renderVerdictPage(named, { origin: 'https://thepit.show' });
    expect(html).toContain('<a href="https://thepit.show/v/abc123">Openly Named Co</a>');
    // The anonymous ones still get no anchor.
    for (const peer of named.comparison?.peers ?? []) {
      if (!peer.anonymous) continue;
      expect(html).not.toContain(`>${peer.label}</a>`);
    }
  });

  it('escapes a hostile pseudonym', async () => {
    const verdict = await withPeers('health-fitness-wellness');
    const hostile: Verdict = {
      ...verdict,
      comparison: {
        ...(verdict.comparison as NonNullable<Verdict['comparison']>),
        peers: (verdict.comparison?.peers ?? []).map((peer) => ({
          ...peer,
          label: '<script>alert(1)</script>',
        })),
      },
    };

    const html = renderVerdictPage(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('the charts lead and the reasons follow', () => {
  it('puts both radials above the ledger, and keeps every reason on the page', async () => {
    const verdict = await withPeers('developer-tools');
    const html = renderVerdictPage(verdict);

    const radials = html.indexOf('Who hurt you, who wanted you');
    const heatmap = html.indexOf('Who cut you, and where');
    const ledger = html.indexOf("Every cut, in the juror's own words");
    expect(radials).toBeGreaterThan(-1);
    expect(radials).toBeLessThan(heatmap);
    expect(heatmap).toBeLessThan(ledger);

    // `brief` Part 6 still binds: moving the prose below the figures is not
    // deleting it. Every deduction is still on the page with its juror.
    const blocks = [...html.matchAll(/<div class="ded">(.*?)<\/div>/gs)];
    expect(blocks.length).toBe(verdict.metrics.flatMap((metric) => metric.deductions).length);
  });
});
