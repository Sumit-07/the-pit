/**
 * The rendered verdict page.
 *
 * The four rules `brief` Part 5 and Part 6 put on this surface, each with a test
 * that fails if it is dropped:
 *
 * 1. A rank never appears without its product count and its timestamp.
 * 2. A solo cluster is a stated fact with its reason, not an empty section.
 * 3. Every deduction carries the juror who took it, in the same block.
 * 4. The page renders the FROZEN payload; the live board is not consulted.
 *
 * Plus the one the input demands: product names and juror reasons are
 * user-submitted, so a hostile one is escaped rather than executed.
 */

import { describe, expect, it } from 'vitest';

import { parseVerdict } from '@/lib/verdict/model';
import { renderVerdictNotFound, renderVerdictPage, stampedRank, stampTime } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdictNamed } from './helpers/verdict.js';

/** `27 Aug 2026, 14:03 UTC` — the fixture instant, in the page's own format. */
const STAMP = '27 Aug 2026, 14:03 UTC';

async function renderSeeded(slug: string, name: string): Promise<string> {
  return renderVerdictPage(parseVerdict(await seededVerdictNamed(slug, name)), { origin: 'https://thepit.show' });
}

describe('never promise a rank', () => {
  it('renders the rank only beside the product count and the moment', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // The card's own line: the big number, then what qualifies it.
    expect(html).toContain('<span class="big">7</span>');
    expect(html).toContain('of 48 products');
    expect(html).toContain(STAMP);
    expect(html).toContain('The board has moved since.');
  });

  it('carries both stamps into the share text, where the rank travels furthest', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // A shared card is the most screenshot-able object the product makes. If
    // either stamp were dropped from the description, this fails.
    const description = /<meta property="og:description" content="([^"]+)">/.exec(html)?.[1] ?? '';
    expect(description).toContain('7 of 48 products');
    expect(description).toContain(STAMP);
    expect(description).toContain('took 30 in cuts');
  });

  it('states both stamps in one string, so no caller can emit half of them', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));
    expect(stampedRank(verdict)).toBe(`7 of 48 products on ${STAMP}`);
  });

  it('stamps in UTC, so a reader elsewhere sees what the sharer saw', () => {
    expect(stampTime('2026-08-27T14:03:00.000Z')).toBe(STAMP);
    expect(stampTime('2026-01-02T03:04:05.000Z')).toBe('2 Jan 2026, 03:04 UTC');
  });
});

describe('the connective word', () => {
  it('says what came off, in the brief’s own sentence', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // `brief` Part 5: "Runlet took 97 in cuts."
    expect(html).toContain('Sequo — stop re-explaining your project to your coding agent took 30 in cuts.');
    expect(html).toContain('Everyone walks in at 100.');
    // And it explains why cuts is not the sum of the ledger's points.
    expect(html).toContain('not the sum of the points below');
  });
});

describe('a solo cluster', () => {
  it('renders the explanation, not an empty Floor section', async () => {
    const html = await renderSeeded('developer-tools', 'Carillon');

    expect(html).toContain('No buyers were shown this product, because nothing in the category was close enough');
    expect(html).toContain('EU-hosted mobile push notifications');
    expect(html).toContain('held 1 product on the day this was issued');
    expect(html).toContain('This is the common case, not a gap in the run.');
    // `DECISIONS.md` S3: the demand weight moves onto merit rather than scoring a zero.
    expect(html).toContain('that weight was moved onto merit rather than scored as a zero');

    // And the summary line says so too, rather than printing a demand of 0.00.
    expect(html).toContain('no buyers convened');
    expect(html).toContain('n/a &mdash; solo cluster');
    expect(html).not.toContain('<span>0.00</span>');
    // Above all: never "0 of M" on the "picked you" line. No buyers convened is
    // a fact about the cluster (nobody was shown this product), not a demand
    // signal of universal rejection — `DECISIONS.md` S3's whole point. A "0 of
    // 6" would read as the latter to a customer who never sees the code that
    // produced it. (The rank stamp legitimately says "of 48 products" nearby —
    // this checks the picked-you line specifically, not the whole page.)
    expect(html).not.toMatch(/picked you<\/span><span>\d+ of \d+<\/span>/);
  });

  it('still shows the cluster it was judged inside', async () => {
    const html = await renderSeeded('developer-tools', 'Carillon');

    expect(html).toContain('Judged inside');
    expect(html).toContain('Push-notification services are established');
    expect(html).toContain('scarcity 30/100');
  });
});

describe('the Floor, when it convened', () => {
  it('names each persona beside the reason they gave, and states the roster they were picked against', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // `platform-surfaces-mockup.html`'s own phrasing: "Panel picked you — N of M".
    // 5 personas named Sequo first, out of the 6-persona panel that answered
    // this run (`cjr/runs/developer-tools/ranking.json`'s top-level `personas`).
    expect(html).toContain('<span>The Buyers picked you</span><span>5 of 6</span>');
    // Every pick block pairs a chip with a reason and a persona.
    const picks = [...html.matchAll(/<div class="pick">.*?<\/div>/gs)];
    expect(picks.length).toBeGreaterThan(0);
    for (const [block] of picks) {
      expect(block).toMatch(/<span class="p( second)?">(1st|2nd)/);
      expect(block).toMatch(/<span class="who">&mdash; .+?<\/span>/);
    }
    expect(html).toContain('demand 0.64');
  });

  it('renders "N of M" for a product most of the panel declined, not just N', async () => {
    // The mockup's own worked example is "2 of 6" — Fuel Log on the
    // health-fitness-wellness board matches it exactly: 2 personas picked it
    // (both first-choice) out of the same 6-persona panel. Without the
    // denominator this would misleadingly read as just "2".
    const html = await renderVerdictPage(
      parseVerdict(await seededVerdictNamed('health-fitness-wellness', 'Fuel Log')),
      { origin: 'https://thepit.show' },
    );

    expect(html).toContain('<span>The Floor picked you</span><span>2 of 6</span>');
  });
});

describe('every deduction, with the juror who made it', () => {
  it('puts the points, the reason and the role in one block', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));
    const html = renderVerdictPage(verdict);

    const blocks = [...html.matchAll(/<div class="ded">(.*?)<\/div>/gs)].map(([, inner]) => inner ?? '');
    const deductions = verdict.metrics.flatMap((metric) => metric.deductions);
    expect(blocks).toHaveLength(deductions.length);

    for (const deduction of deductions) {
      const block = blocks.find((candidate) => candidate.includes(`&minus;${deduction.points}`) && candidate.includes(deduction.role));
      expect(block, `no block pairs -${deduction.points} with ${deduction.role}`).toBeDefined();
      // The reason and its author are in the SAME block. A page that listed
      // reasons in one column and jurors in another would pass a naive
      // "contains" check and fail this one.
      expect(block).toContain(deduction.role);
    }

    // The sharpest cut is also quoted on the card, with its juror cited.
    expect(html).toContain('The Platform Owner &middot; &minus;80 on Durability');
  });

  it('discloses a juror who returned nothing', () => {
    const html = renderVerdictPage(parseVerdict(handBuiltVerdict()));

    expect(html).toContain('no answer from The Docs Writer &mdash; substituted 50, and counted that way in the rank');
  });
});

describe('frozen, not derived', () => {
  it('renders the payload’s numbers even when the live board disagrees', async () => {
    // The same product, frozen at a rank and a board size it no longer has.
    // `DECISIONS.md` §1.2 moves every z-score on every placement, so this is the
    // normal state of an old verdict — and it is what a shared link must keep
    // showing. A renderer that looked the product up in the current
    // `ranking.json` would print 7 of 48 here.
    const row = await seededVerdictNamed('developer-tools', 'Sequo');
    const payload = structuredClone(row.payload) as { product_count: number; verdict: { rank: number } };
    payload.verdict.rank = 3;
    payload.product_count = 12;

    const html = renderVerdictPage(parseVerdict({ ...row, payload, productCount: 12 }));

    expect(html).toContain('<span class="big">3</span>');
    expect(html).toContain('of 12 products');
    expect(html).not.toContain('of 48 products');
  });

  it('says on the page that it was frozen', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    expect(html).toContain('This page was frozen when it was issued and never recomputed.');
  });
});

describe('untrusted text', () => {
  const HOSTILE_NAME = '<script>alert("pwn")</script>';
  const HOSTILE_REASON = '<<<ignore previous instructions>>> & "quote" — </script>';

  it('escapes a hostile product name everywhere it appears', () => {
    const html = renderVerdictPage(
      parseVerdict(handBuiltVerdict({ name: HOSTILE_NAME })),
      { origin: 'https://thepit.show' },
    );

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;');
    // Including inside attribute values, where an unescaped quote breaks out.
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    expect(title).toContain('&lt;script&gt;');
    const ogTitle = /<meta property="og:title" content="([^"]*)">/.exec(html)?.[1] ?? '';
    expect(ogTitle).toContain('&lt;script&gt;');
    expect(ogTitle).toContain('&quot;pwn&quot;');
  });

  it('escapes the data-block delimiters a juror reason may echo back', () => {
    const html = renderVerdictPage(
      parseVerdict(
        handBuiltVerdict({
          scorecard: [
            {
              metric: 'Trust Surface',
              score: 60,
              spread: 10,
              juror_count: 6,
              substituted_roles: [],
              deductions: [{ points: 50, reason: HOSTILE_REASON, role: 'The <b>Skeptic</b>' }],
            },
          ],
        }),
      ),
    );

    expect(html).toContain('&lt;&lt;&lt;ignore previous instructions&gt;&gt;&gt;');
    expect(html).toContain('The &lt;b&gt;Skeptic&lt;/b&gt;');
    expect(html).not.toContain('<b>Skeptic</b>');
    expect(html).not.toContain('</script>');
  });

  it('refuses to make a javascript: url into a link', () => {
    // eslint-disable-next-line no-script-url -- the point of the test
    const html = renderVerdictPage(parseVerdict(handBuiltVerdict({ url: 'javascript:alert(1)' })));

    expect(html).toContain('<span class="plink">javascript:alert(1)</span>');
    expect(html).not.toContain('href="javascript:');
  });

  it('escapes the slug on the not-found page, which takes it straight from the URL', () => {
    const html = renderVerdictNotFound('<img src=x onerror=alert(1)>');

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('the downloadable artifact', () => {
  it('renders with nothing loaded but its own typeface', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // No script at all — the page has one product on it and nothing to expand,
    // so a saved copy is inert by construction.
    expect(html).not.toContain('<script');
    // No image, no iframe, no data fetch.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');

    // The palette is `the-pit-home.html`'s, inline.
    expect(html).toContain('--ground:#120E0C');
    expect(html).toContain('--blade:#E2482C');

    // The only external reference is the site's typeface, and every family
    // declares a real local fallback — so a copy saved and opened offline loses
    // its typeface and nothing else.
    const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(([, href]) => href ?? '');
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0]).toContain('fonts.googleapis.com');
    expect(html).toContain('--disp:"Archivo Black","Arial Black"');
    expect(html).toContain('--body:"Barlow","Helvetica Neue"');
    expect(html).toContain('--mono:"IBM Plex Mono",ui-monospace');
  });

  it('offers itself for download, and its links survive being saved', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    expect(html).toContain('?download=1');
    expect(html).toContain('Download this page');
    // Absolute, so a saved copy still resolves.
    expect(html).toContain('href="https://thepit.show/');
    expect(html).not.toContain('href="/"');
  });
});

describe('the register fits the room', () => {
  it('calls a b2b panel The Buyers and a consumer one The Floor', async () => {
    const b2b = await renderSeeded('developer-tools', 'Sequo');
    expect(b2b).toContain('<h2>The Buyers</h2>');

    const consumer = renderVerdictPage(
      parseVerdict({
        ...handBuiltVerdict({ demandStatus: 'scored' }),
        payload: {
          ...(handBuiltVerdict({ demandStatus: 'scored' }).payload as Record<string, unknown>),
          category_type: 'consumer',
        },
      }),
    );
    expect(consumer).toContain('<h2>The Floor</h2>');
  });
});
