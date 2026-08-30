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

import { buyerRadial, juryRadial, jurorMeanCut, lossBars } from '@/lib/verdict/charts';
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
  it('plots a juror’s points over the metrics they answered, and fails if that changes', async () => {
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
      expect(radial.self.values[index], role).toBe(answered === 0 ? null : points / answered);
    });

    // And it is a live quantity: at least one juror took something off this card.
    expect(radial.self.values.some((value) => (value ?? 0) > 0)).toBe(true);
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

    const frozen = [...(verdict.comparison?.peers ?? [])].sort((a, b) => a.rank - b.rank);
    peers.forEach((series, index) => {
      expect(series.values).toEqual(frozen[index]?.jurors);
    });
  });

  it('puts the frozen category median on the loss bars, on the bar’s own axis', async () => {
    const verdict = await withPeers('developer-tools');
    const bars = lossBars(verdict);
    const medians = new Map(
      (verdict.comparison?.median.metrics ?? []).map((entry) => [entry.metric, entry.cuts]),
    );

    expect(medians.size).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.categoryCuts, bar.metric).toBe(medians.get(bar.metric));
  });

  it('exposes the same arithmetic the freezer used, so self and peers share a scale', async () => {
    const verdict = await withPeers('developer-tools');
    const role = verdict.comparison?.jurors[0];
    if (role === undefined) throw new Error('no roster');
    // If these ever diverge the two shapes are drawn on different scales and the
    // comparison silently stops meaning anything.
    expect(juryRadial(verdict)?.self.values[0]).toBe(jurorMeanCut(verdict, role));
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
    expect(lossBars(verdict).every((bar) => bar.categoryCuts === null)).toBe(true);
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
    expect(jury.context[0]?.values).toEqual(verdict.comparison?.median.jurors);

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
