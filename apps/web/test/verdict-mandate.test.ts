/**
 * Who the spoke belongs to.
 *
 * A radial axis names a juror or a buyer and, until this existed, said nothing
 * about either: a reader met "The Seed Investor" and had no way to know that he
 * scores the POSITION rather than the product, which is the whole reason his
 * number is what it is. The founder's ask was the personality behind each axis,
 * "so I can have a better idea of the result".
 *
 * The subtlety is where the biography comes from, and it is the point of this
 * file. `cjr/references/jurors/<slug>.json` is right there on disk and reading it
 * at render time would be free. It would also be the same mistake `DECISIONS.md
 * §1.2` forbids one level up: a jury is VERSIONED (`01 §4` Step 2 bumps
 * `prompt_version` by hand on any edit) and a mandate can be revised, so a
 * permanent public URL that read the current panel would eventually describe
 * jurors who are not the ones who cut this product. The mandate that judged you
 * is part of your verdict, so it is frozen with the rest of it.
 *
 * That makes two classes of page, permanently, because `verdicts` refuses UPDATE:
 * one that carries mandates and one that never will. Both are tested here, and
 * the second one has to render a spoke with no biography rather than a biography
 * from somewhere else.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buyerRadial, juryRadial } from '@/lib/verdict/charts';
import { parsePanel, parseVerdict, type Verdict } from '@/lib/verdict/model';
import { renderVerdictPage } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdictNamed, seededVerdicts, WORKDIR } from './helpers/verdict.js';

/** A seeded verdict whose cluster has peers, so both radials are on the page. */
async function withPeers(slug: string): Promise<Verdict> {
  for (const row of await seededVerdicts(slug)) {
    const verdict = parseVerdict(row);
    if ((verdict.comparison?.peers.length ?? 0) > 0) return verdict;
  }
  throw new Error(`no seeded verdict in ${slug} has cluster peers`);
}

/** The installed panel on disk — the thing this page must NOT be reading. */
async function installedJury(slug: string): Promise<{ jurors: { role: string; who: string; cares_most: string; biased_against: string }[] }> {
  return JSON.parse(await readFile(join(WORKDIR, 'references', 'jurors', `${slug}.json`), 'utf8')) as never;
}

describe('a payload carrying mandates renders them on the spoke', () => {
  it('puts every juror’s mandate on the axis that carries their name', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');

    // One mandate per axis, joined by ROLE rather than by position, so a panel
    // frozen in a different order than the axes were recovered in still finds
    // the right person.
    expect(radial.mandates).toHaveLength(radial.axes.length);
    radial.axes.forEach((role, index) => {
      const mandate = radial.mandates[index];
      expect(mandate, role).not.toBeNull();
      if (mandate?.kind !== 'juror') throw new Error(`${role} is not a juror mandate`);
      expect(mandate.role).toBe(role);
      expect(mandate.who).not.toBe('');
      expect(mandate.caresMost).not.toBe('');
      expect(mandate.biasedAgainst).not.toBe('');
    });

    // And it reaches the page: a hotspot per axis, carrying the three fields.
    const html = renderVerdictPage(verdict);
    for (const mandate of radial.mandates) {
      if (mandate?.kind !== 'juror') throw new Error('expected juror mandates');
      expect(html).toContain(mandate.caresMost.slice(0, 40));
      expect(html).toContain(mandate.biasedAgainst.slice(0, 40));
    }
  });

  it('puts every buyer’s mandate on their own spoke, with how they buy', async () => {
    const verdict = await withPeers('developer-tools');
    const radial = buyerRadial(verdict);
    if (radial === null) throw new Error('no buyer radial');

    radial.axes.forEach((name, index) => {
      const mandate = radial.mandates[index];
      if (mandate?.kind !== 'buyer') throw new Error(`${name} is not a buyer mandate`);
      expect(mandate.name).toBe(name);
      expect(mandate.description).not.toBe('');
      expect(mandate.needs.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(mandate.priceSensitivity);
    });

    const html = renderVerdictPage(verdict);
    // Price sensitivity is the buyer fact the number on the spoke does not carry:
    // a conviction of 90 from someone who will not pay means something else.
    expect(html).toContain('sensitivity');
    expect(html).toContain('On price');
  });

  it('names one spoke hotspot per axis, and never one for an axis with no mandate', async () => {
    const verdict = await withPeers('developer-tools');
    const html = renderVerdictPage(verdict);
    const jury = juryRadial(verdict);
    const buyers = buyerRadial(verdict);
    const axes = [...(jury?.axes ?? []), ...(buyers?.axes ?? [])];

    const spots = [...html.matchAll(/<button type="button" class="rspot"[^>]*aria-label="([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(spots).toHaveLength(axes.length);
    for (const axis of axes) expect(spots).toContain(`Who ${axis} is`);
  });
});

describe('a payload with no mandates renders the spoke and fabricates nothing', () => {
  it('draws the chart with no biography anywhere on it', () => {
    // `handBuiltVerdict` is the shape the freezer produced BEFORE the panel was
    // frozen, and `verdicts` refuses UPDATE, so this is a permanent class of
    // page rather than a migration step.
    const verdict = parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
    expect(verdict.panel).toBeNull();

    const jury = juryRadial(verdict);
    if (jury === null) throw new Error('no jury radial');
    // Every axis is still drawn; every mandate is absent.
    expect(jury.axes.length).toBeGreaterThan(0);
    expect(jury.mandates.every((mandate) => mandate === null)).toBe(true);

    const html = renderVerdictPage(verdict);
    // No hotspot, no roster list, and no invitation to hover something that
    // would reveal nothing.
    expect(html).not.toContain('class="rspot"');
    expect(html).not.toContain('rwho rbios');
    expect(html).not.toContain('Hover or tab to a spoke');
    // The chart itself is untouched: the axis is still named on the page.
    expect(html).toContain('The Release Engineer');
  });

  it('does not reach for the panel file on disk to fill the gap', async () => {
    // The failure this guards is silent and permanent: a page that fell back to
    // the installed jury would look complete and would describe, on an old
    // verdict, whichever panel is installed the day it is read.
    const verdict = parseVerdict(handBuiltVerdict({ demandStatus: 'scored' }));
    const html = renderVerdictPage(verdict);
    const jury = await installedJury('developer-tools');

    for (const juror of jury.jurors) {
      expect(html, `${juror.role}'s mandate was read live`).not.toContain(juror.who.slice(0, 40));
      expect(html, `${juror.role}'s mandate was read live`).not.toContain(juror.cares_most.slice(0, 40));
    }
  });

  it('renders what the PAYLOAD says, not what the panel says', async () => {
    // The proof that the page reads the frozen document: rewrite the frozen
    // mandate and the page follows it, which a page reading the installed file
    // could not do.
    const verdict = await withPeers('developer-tools');
    const rewritten: Verdict = {
      ...verdict,
      panel: {
        buyers: verdict.panel?.buyers ?? [],
        jurors: (verdict.panel?.jurors ?? []).map((juror) => ({
          ...juror,
          caresMost: 'A sentence no installed panel contains.',
        })),
      },
    };

    const html = renderVerdictPage(rewritten);
    expect(html).toContain('A sentence no installed panel contains.');
    const jury = await installedJury('developer-tools');
    for (const juror of jury.jurors) {
      expect(html).not.toContain(juror.cares_most.slice(0, 40));
    }
  });

  it('drops a half-written mandate rather than printing a blank one', () => {
    // A juror described as "who: —" reads as a juror with no character, which is
    // a claim. A juror with no entry reads as a spoke this verdict froze nothing
    // for, which is the truth.
    expect(parsePanel({ jurors: [{ role: 'The Docs Writer', who: 'x' }], buyers: [] })).toBeNull();
    expect(parsePanel({ jurors: [], buyers: [] })).toBeNull();
    expect(parsePanel(undefined)).toBeNull();
    expect(
      parsePanel({
        jurors: [{ role: 'r', who: 'w', cares_most: 'c', biased_against: 'b' }],
        buyers: [{ name: 'n', description: 'd', needs: ['a'], price_sensitivity: 'low' }],
      }),
    ).toEqual({
      jurors: [{ role: 'r', who: 'w', caresMost: 'c', biasedAgainst: 'b' }],
      buyers: [{ name: 'n', description: 'd', needs: ['a'], priceSensitivity: 'low' }],
    });
  });
});

describe('the biography is not a hover', () => {
  it('is in the DOM with no pointer, and reachable by keyboard', async () => {
    const verdict = await withPeers('developer-tools');
    const html = renderVerdictPage(verdict);
    const radial = juryRadial(verdict);
    if (radial === null) throw new Error('no jury radial');

    // A button, not a span with a title: focusable by tab, activated by a tap on
    // a touch screen, and announced as something to act on.
    expect(html).toContain('<button type="button" class="rspot"');
    // And the same text sits in a plain disclosure that needs no pointer at all
    // — the discipline the table twins already follow on this page.
    expect(html).toContain('<details class="rwho rbios">');
    expect(html).toContain('The Panel: who they are (6)');

    // Every field is present OUTSIDE any readout: strip the tooltips and the
    // mandates are still there.
    const withoutTips = html.replaceAll(/<span class="tip[^"]*"[^>]*>.*?<\/span><\/button>/gs, '');
    for (const mandate of radial.mandates) {
      if (mandate?.kind !== 'juror') throw new Error('expected juror mandates');
      expect(withoutTips, mandate.role).toContain(mandate.biasedAgainst.slice(0, 40));
    }

    // Still no script and no image: the readout is CSS and native focus.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('withdraws the readout on a narrow screen and keeps the list', async () => {
    // Below 560px there is no hover to lose and an absolutely-positioned readout
    // is clipped by the scroll container it sits in. The page already answers
    // that for the heatmap by withdrawing the readout and leaning on the table;
    // the panel list is the same answer here.
    const html = renderVerdictPage(await withPeers('developer-tools'));
    const narrow = /@media \(max-width:560px\)\{(.*?)\n\}/s.exec(html)?.[1] ?? '';
    expect(narrow).toContain('.tip{display:none}');
    expect(narrow).toContain('.rspot{display:none}');
    expect(html).toContain('<details class="rwho rbios">');
  });
});

describe('a mandate is untrusted text like every other string here', () => {
  it('escapes a hostile mandate in both the readout and the list', async () => {
    const verdict = await withPeers('developer-tools');
    const hostile: Verdict = {
      ...verdict,
      panel: {
        buyers: verdict.panel?.buyers ?? [],
        jurors: (verdict.panel?.jurors ?? []).map((juror) => ({
          ...juror,
          who: '<script>alert(1)</script>',
        })),
      },
    };

    const html = renderVerdictPage(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('a peer is still a pseudonym, biographies or not', () => {
  it('names no anonymous peer anywhere on a chart that now names its jurors', async () => {
    // The panel is named because a juror is not a product. A cluster peer still
    // is, and adding six biographies to this figure must not smuggle a withheld
    // product name in beside them.
    const verdict = await withPeers('health-fitness-wellness');
    const html = renderVerdictPage(verdict, { origin: 'https://thepit.show' });

    const realNames = (await seededVerdicts('health-fitness-wellness')).map(
      (row) => (row.payload as { verdict: { name: string } }).verdict.name,
    );

    for (const peer of verdict.comparison?.peers ?? []) {
      expect(peer.anonymous).toBe(true);
      // The pseudonym is what the page shows for that outline.
      expect(html).toContain(peer.label);
    }
    for (const name of realNames) {
      if (name === verdict.name) continue;
      expect(html, `${name} leaked onto another product's verdict`).not.toContain(name);
    }
  });
});
