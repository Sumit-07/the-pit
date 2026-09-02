/**
 * "The panel you'll face" — the column the design canvas puts beside the submit
 * form, and the one rule that makes it worth having.
 *
 * The rule is that **it is the installed panel, not a description of one.** A
 * hand-written paragraph about six jurors would look identical on the page and
 * would rot the first time a category's jury changed, which is the failure this
 * file exists to make loud. So the tests read the same reference files the
 * pipeline scores against and assert that the strings on the page came out of
 * them:
 *
 * 1. Against the REAL `cjr/references/` on disk — the six mandates a visitor
 *    picking Developer Tools is actually shown, and the six they are shown for
 *    Health, Fitness & Wellness, with the register switching between them.
 * 2. Against a scratch workdir, where the fixture is written by the test, so
 *    "these strings came from the file" is proved rather than coincidence.
 *
 * And the negative half, which matters more: a category with no installed panel
 * renders nothing at all. `/submit` is the last surface before a charge, and a
 * plausible-looking jury that nobody installed would be the worst thing on it.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EMPTY_FORM, renderSubmitPage } from '@/lib/checkout/page';
import { firstSentence, readCategoryPanel, readCategoryPanels } from '@/lib/checkout/panel';
import { resolveWorkdir } from '@/lib/boards/source';

const TIERS = [{ id: 'single', label: 'One attempt', amountCents: 500, attempts: 1, includesFitReport: false }] as never;

/** Strip tags, so an assertion is about what a reader sees. */
function textOf(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&middot;', '·')
    .replaceAll('&rsquo;', '’')
    .replaceAll('&amp;', '&')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

async function scratchWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pit-panel-'));
  await mkdir(join(dir, 'references', 'jurors'), { recursive: true });
  await mkdir(join(dir, 'references', 'personas'), { recursive: true });
  return dir;
}

describe('the panel is read off the installed files, never written', () => {
  it('returns the exact roles, mandates and weights the file declares', async () => {
    const workdir = await scratchWorkdir();
    await writeFile(
      join(workdir, 'references', 'jurors', 'made-up.json'),
      JSON.stringify({
        type: 'b2b',
        metrics: [{ name: 'Problem Sharpness' }, { name: 'claim_backing' }],
        jurors: [
          {
            role: 'The Night Porter',
            cares_most: 'Whether it holds at 3am. Everything else is decoration.',
            weights: { 'Problem Sharpness': 4, claim_backing: 9 },
          },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(workdir, 'references', 'personas', 'made-up.json'),
      JSON.stringify({
        personas: [
          {
            name: 'Alma Ferreira',
            description: 'Runs the loading bay on nights. She has never once read a changelog.',
            price_sensitivity: 'high',
          },
        ],
      }),
      'utf8',
    );

    const panel = await readCategoryPanel('made-up', { workdir });
    expect(panel).toEqual({
      slug: 'made-up',
      type: 'b2b',
      metrics: ['Problem Sharpness', 'claim_backing'],
      jurors: [
        {
          role: 'The Night Porter',
          // The first sentence, verbatim, with nothing appended.
          mandate: 'Whether it holds at 3am.',
          // The metric this juror weights highest, which is a fact about the
          // configuration — not a claim about how hard they cut, which nothing
          // on this branch could yet know.
          heaviest: { metric: 'claim_backing', weight: 9 },
        },
      ],
      personas: [{ name: 'Alma Ferreira', who: 'Runs the loading bay on nights.', priceSensitivity: 'high' }],
    });
  });

  it('renders those strings, and only those, into the column', async () => {
    const workdir = await scratchWorkdir();
    await writeFile(
      join(workdir, 'references', 'jurors', 'made-up.json'),
      JSON.stringify({
        type: 'b2b',
        metrics: [{ name: 'claim_backing' }],
        jurors: [{ role: 'The Night Porter', cares_most: 'Whether it holds at 3am.', weights: { claim_backing: 9 } }],
      }),
      'utf8',
    );
    await writeFile(
      join(workdir, 'references', 'personas', 'made-up.json'),
      JSON.stringify({ personas: [{ name: 'Alma Ferreira', description: 'Runs the loading bay.', price_sensitivity: 'high' }] }),
      'utf8',
    );

    const panels = await readCategoryPanels(['made-up'], { workdir });
    const html = renderSubmitPage({
      categories: ['made-up'],
      panels,
      tiers: TIERS,
      values: { ...EMPTY_FORM, categorySlug: 'made-up' },
      descriptionLimit: 300,
      signedIn: false,
    });
    const text = textOf(html);

    expect(text).toContain('The panel you’ll face');
    expect(text).toContain('The Night Porter');
    expect(text).toContain('Whether it holds at 3am.');
    // The weight, as a weight. Never as a severity.
    expect(text).toContain('weighs Claim backing most · 9/10');
    expect(text.toLowerCase()).not.toContain('cuts hardest');
    expect(text.toLowerCase()).not.toContain('median cut');
    expect(text).toContain('Alma Ferreira');
    expect(text).toContain('price sensitivity high');
    expect(text).toContain('Scored on Claim backing.');
  });

  it('shows no column at all when nothing is installed, rather than a plausible one', async () => {
    const workdir = await scratchWorkdir();
    expect(await readCategoryPanel('made-up', { workdir })).toBeUndefined();
    expect(await readCategoryPanels(['made-up'], { workdir })).toEqual([]);

    const html = renderSubmitPage({
      categories: ['made-up'],
      panels: [],
      tiers: TIERS,
      values: { ...EMPTY_FORM, categorySlug: 'made-up' },
      descriptionLimit: 300,
      signedIn: false,
    });
    expect(html).not.toContain('<aside class="panelcol"');
    expect(html).not.toContain('data-panel="');
    // The grid collapses to one column and the switcher script is not shipped,
    // because there is nothing for it to switch between.
    expect(html).toContain('class="pitchgrid alone"');
    expect(html).not.toContain('getElementsByTagName');
    expect(html).not.toContain("select[name=\\\"category\\\"]");
    // And the form is still whole: the panel is an addition, never a gate.
    expect(html).toContain('action="/api/checkout"');
    expect(html).toContain('Take my $5');
  });

  it('refuses a slug that is not a slug, so a path cannot be walked out of the workdir', async () => {
    const workdir = await scratchWorkdir();
    for (const hostile of ['../../etc', 'a/b', '..', 'Dev-Tools']) {
      expect(await readCategoryPanel(hostile, { workdir })).toBeUndefined();
    }
  });

  it('escapes a hostile role, because a reference file is still a file on disk', async () => {
    const workdir = await scratchWorkdir();
    await writeFile(
      join(workdir, 'references', 'jurors', 'made-up.json'),
      JSON.stringify({
        type: 'b2b',
        metrics: [],
        jurors: [{ role: '<script>alert(1)</script>', cares_most: 'Nothing. And "quotes".', weights: {} }],
      }),
      'utf8',
    );
    const html = renderSubmitPage({
      categories: ['made-up'],
      panels: await readCategoryPanels(['made-up'], { workdir }),
      tiers: TIERS,
      values: { ...EMPTY_FORM, categorySlug: 'made-up' },
      descriptionLimit: 300,
      signedIn: false,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('firstSentence trims and never rewrites', () => {
  it('cuts at the first sentence end and keeps the stop', () => {
    expect(firstSentence('One. Two. Three.')).toBe('One.');
  });

  it('does not break on a decimal or an abbreviation mid-sentence', () => {
    expect(firstSentence('Wants a 99.9% SLA with credits. Then more.')).toBe('Wants a 99.9% SLA with credits.');
  });

  it('returns the whole string when there is nothing to cut', () => {
    expect(firstSentence('  no full stop here  ')).toBe('no full stop here');
  });

  it('never appends an ellipsis or any character the file did not have', () => {
    const out = firstSentence('A sentence. And another.');
    expect(out.endsWith('…')).toBe(false);
    expect('A sentence. And another.').toContain(out);
  });
});

describe('the real seeded panels, as a visitor meets them', () => {
  const workdir = resolveWorkdir();

  it('shows the six Developer Tools mandates that will actually score the pitch', async () => {
    const panel = await readCategoryPanel('developer-tools', { workdir });
    expect(panel?.jurors).toHaveLength(6);
    expect(panel?.personas).toHaveLength(6);
    expect(panel?.type).toBe('b2b');
    // The roles that appear beside every cut on `/boards/developer-tools`. The
    // panel on the form and the bylines on the board are the same six names.
    expect(panel?.jurors.map((juror) => juror.role)).toContain('The Release Engineer');
    expect(panel?.jurors.map((juror) => juror.role)).toContain('The Seed Investor');
    expect(panel?.metrics).toContain('Problem Sharpness');
    for (const juror of panel?.jurors ?? []) {
      expect(juror.mandate.length, `${juror.role} has an empty mandate`).toBeGreaterThan(10);
      expect(juror.heaviest?.metric, `${juror.role} has no weights`).toBeDefined();
      // A weight is only meaningful if it names a metric this jury actually scores.
      expect(panel?.metrics).toContain(juror.heaviest?.metric);
    }
  });

  it('switches the register with the category, from the file’s own type', async () => {
    const [b2b, consumer] = await Promise.all([
      readCategoryPanel('developer-tools', { workdir }),
      readCategoryPanel('health-fitness-wellness', { workdir }),
    ]);
    expect(b2b?.type).toBe('b2b');
    expect(consumer?.type).not.toBe('b2b');

    const html = renderSubmitPage({
      categories: ['developer-tools', 'health-fitness-wellness'],
      panels: await readCategoryPanels(['developer-tools', 'health-fitness-wellness'], { workdir }),
      tiers: TIERS,
      values: { ...EMPTY_FORM, categorySlug: 'developer-tools' },
      descriptionLimit: 300,
      signedIn: false,
    });
    const text = textOf(html);
    // `brief` Part 4: same data, register that fits the room.
    expect(text).toContain('The Panel · 6 mandates');
    expect(text).toContain('The Buyers · 6');
    expect(text).toContain('The Six · 6 mandates');
    expect(text).toContain('The Floor · 6');

    // Both panels are in the document; the selected one is the visible one, so a
    // visitor with scripting off sees the jury for the category that is chosen.
    expect(html).toContain('data-panel="developer-tools"><div class="phead">');
    expect(html).toContain('data-panel="health-fitness-wellness" hidden>');
  });

  it('quotes the installed mandate rather than a paraphrase of it', async () => {
    // The assertion that makes this column worth having: the sentence on the page
    // is a substring of the sentence in the file the pipeline reads.
    const panel = await readCategoryPanel('developer-tools', { workdir });
    const raw = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        join(workdir, 'references', 'jurors', 'developer-tools.json'),
        'utf8',
      ),
    ) as { jurors: { role: string; cares_most: string }[] };

    for (const juror of panel?.jurors ?? []) {
      const source = raw.jurors.find((entry) => entry.role === juror.role);
      expect(source, `${juror.role} is not in the file`).toBeDefined();
      expect(source?.cares_most.startsWith(juror.mandate), `${juror.role} was paraphrased`).toBe(true);
    }
  });
});
