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
import { BASE, TOKENS } from '@/lib/theme';
import { cutsLine, renderVerdictNotFound, renderVerdictPage, stampedRank, stampTime } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdictNamed } from './helpers/verdict.js';

/** `27 Aug 2026, 14:03 UTC` — the fixture instant, in the page's own format. */
const STAMP = '27 Aug 2026, 14:03 UTC';

async function renderSeeded(slug: string, name: string): Promise<string> {
  return renderVerdictPage(parseVerdict(await seededVerdictNamed(slug, name)), { origin: 'https://thepit.show' });
}

/**
 * The bodies of every `<script>` element on the page.
 *
 * The share row ships one inline handler (`lib/verdict/share.ts`) so that "Copy
 * verdict line" can reach the clipboard, and this is how the tests below hold it
 * to the rule that matters. "No script anywhere" was a proxy for "no
 * user-submitted string is ever in a script context"; the handler is a constant
 * and every string it acts on rides in a `data-copy` attribute, so the property
 * is asserted directly instead — one script element, and nothing of the payload
 * inside it.
 */
function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(([, body]) => body ?? '');
}

describe('never promise a rank', () => {
  it('renders the rank only beside the product count and the moment', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // The hero number carries its denominator in the same element, the date in
    // the byline beside it, and `stampedRank` in full on its own title — so the
    // rank cannot be read, copied or hovered without both stamps.
    expect(html).toContain('<u>#</u>7<i> / 48</i>');
    expect(html).toContain('title="7 of 48 products on 27 Aug 2026, 14:03 UTC"');
    expect(html).toContain('Developer Tools &middot; judged 27 Aug 2026');
    // And the full instant is in the footer, which is the record.
    expect(html).toContain(STAMP);
    expect(html).toContain('of 48 products');
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

    // `brief` Part 5: "Runlet took 97 in cuts." The subject is the designation,
    // because a seeded listing is anonymous — the SENTENCE is what this test is
    // about, and it survives the redaction unchanged, which is the point:
    // anonymity withholds the identity and touches nothing else.
    expect(html).toMatch(/Unit [A-Za-z]+-\d{3} took 30 in cuts\./);
    expect(html).not.toContain('Sequo');
    // The same sentence is what the share row copies, so the line a founder
    // pastes is the line the page was issued with. It rides in the button's
    // `data-copy` attribute rather than in a handler, which is what keeps the
    // page's one script free of payload text.
    expect(html).toMatch(/data-copy="Unit [A-Za-z]+-\d{3} took 30 in cuts\./);
  });
});

describe('a solo cluster', () => {
  it('renders the explanation, not an empty Floor section', async () => {
    const html = await renderSeeded('developer-tools', 'Carillon');

    // The fact, in one line, twice: on the header's right-hand card where a
    // buyer quote would be, and in the cluster block that produced it.
    expect(html).toContain('<div class="ln h">Nothing close enough to compare. Ranked on merit alone.</div>');
    expect(html).toContain('<b>Nothing close enough to compare. Ranked on merit alone.</b>');
    expect(html).toContain('EU-hosted mobile push notifications');
    // `DECISIONS.md` S3: the demand weight moves onto merit rather than scoring a zero.
    expect(html).toContain('The demand weight moved onto merit rather than scoring a zero.');

    // And no demand figure is printed for a Floor that never convened.
    expect(html).not.toContain('<span>0.00</span>');
    expect(html).not.toContain('class="dparts"');
    // Above all: never "0 of M" anywhere. No buyers convened is a fact about the
    // cluster (nobody was shown this product), not a demand signal of universal
    // rejection — `DECISIONS.md` S3's whole point. A "0 of 6" would read as the
    // latter to a customer who never sees the code that produced it.
    expect(html).not.toMatch(/\b0 of \d+ buyers\b/);
  });

  it('still shows the cluster it was judged inside', async () => {
    const html = await renderSeeded('developer-tools', 'Carillon');

    expect(html).toContain('Judged inside');
    expect(html).toContain('Push-notification services are established');
    expect(html).toContain('scarcity 30/100');
  });

  it('names no buyers chart and no buyers block for a Floor that never convened', async () => {
    const html = await renderSeeded('developer-tools', 'Carillon');

    // The buyers row is absent entirely rather than present and empty: a half
    // of a grid with nothing in it reads as a page that failed to render.
    expect(html).not.toContain('class="bgrid"');
    expect(html).not.toContain('class="rfig rb"');
  });
});

describe('the Floor, when it convened', () => {
  it('names each persona beside the reason they gave, and states the roster they were picked against', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // 5 personas named Sequo, out of the 6-persona panel that answered this run
    // (`cjr/runs/developer-tools/ranking.json`'s top-level `personas`). The
    // count is on the header's one-line sub and again over the quote cards.
    expect(html).toContain('<small>Top 15% of the board · 5 of 6 buyers</small>');
    expect(html).toContain('<b>5 of 6</b> buyers named this product.');
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

    expect(html).toContain('2 of 6 buyers</small>');
    expect(html).toContain('<b>2 of 6</b> buyers named this product.');
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

    // The sharpest cut is also the header's left-hand line, with its juror cited.
    expect(html).toContain('<small>The Platform Owner · −80 on Durability</small>');
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

    expect(html).toContain('<u>#</u>3<i> / 12</i>');
    expect(html).toContain('of 12 products');
    expect(html).not.toContain('of 48 products');
  });

  it('says on the page that it was frozen', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // The sentence gained a clause when the comparison overlay landed — the peer
    // and category shapes are frozen too, and a reader is owed that in the same
    // breath as the rank. The claim under test is unchanged: the page says, on
    // the page, that it is frozen and never recomputed.
    expect(html).toContain('This page was frozen when it was issued and never recomputed');
    expect(html).toContain('the comparison shapes above');
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
    expect(html).toContain('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;');
    // The name is on this page a dozen times, including inside the share row's
    // copy attributes — and none of those places is a script context. The one
    // script element is share.ts's handler, and the name is not in it.
    const bodies = scriptBodies(html);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('alert');
    expect(bodies[0]).not.toContain('pwn');
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
    // The reason ends in a literal `</script>`, which is the closer this page's
    // one inline handler would be broken by. It is escaped where it is printed,
    // and it is not in the handler at all.
    expect(html).toContain('&lt;/script&gt;');
    const bodies = scriptBodies(html);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('ignore previous instructions');
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

    // The property is that the page LOADS nothing, not that it runs nothing. A
    // saved copy has to render whole from its own bytes; whether a clipboard
    // button works in it is a convenience, and `share.ts` ships one inline
    // handler for exactly that. So: no external script, no iframe, and nothing
    // that goes to the network for content.
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('fetch(');
    expect(html).not.toContain('XMLHttpRequest');
    expect(html).not.toContain('import(');

    // Every host the document FETCHES from, which is a different set from every
    // host it links to: an <a> is navigation the reader chooses, and the share
    // row's "Post on X" is supposed to leave the site. What must stay small is
    // what the page pulls on its own — <img>, <script>, <iframe> and <link>.
    const fetched = [
      ...[...html.matchAll(/<(?:img|script|iframe)[^>]*\ssrc="([^"]+)"/g)],
      ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)],
    ].map(([, url]) => new URL(url ?? '', 'https://thepit.show').host);
    expect([...new Set(fetched)].sort()).toEqual(['fonts.googleapis.com', 'fonts.gstatic.com', 'thepit.show']);

    // The share row's badge preview is the one image, and this app serves it
    // under this verdict's own slug. It is an illustration of the thing the
    // button beside it copies, not a dependency: the page reads whole without it.
    const images = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map(([, src]) => src ?? '');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^https:\/\/thepit\.show\/v\/[0-9a-f]+\/badge\.svg$/);

    // The palette is `lib/theme.ts`'s own values, inline — the same theme every
    // other surface renders, so a saved copy is not a different product.
    //
    // Asserted against the theme module rather than against literals. The rule was
    // always "the saved page carries THE theme", and pinning hexes here tested a
    // weaker thing: that it carried the theme as of the day the test was written.
    // A re-theme then fails this test for the one reason that is not a bug.
    // `theme-drift.test.ts` is what holds the values themselves in place.
    for (const token of ['--sunk', '--pit', '--card', '--rise', '--ink', '--cut'] as const) {
      const declared = new RegExp(`${token}:(#[0-9A-Fa-f]{6})`).exec(TOKENS)?.[1];
      expect(declared, `${token} is declared in the theme`).toBeDefined();
      expect(html, `the saved page carries ${token}`).toContain(`${token}:${String(declared)}`);
    }
    // The theme commits: a saved copy is dark wherever it is opened, and does not
    // change under the reader's system preference.
    expect(html.replace(/\s+/g, '')).toContain('color-scheme:dark');
    expect(html).not.toContain('prefers-color-scheme');

    // The only external reference is the site's typeface, and every family
    // declares a real local fallback — so a copy saved and opened offline loses
    // its typeface and nothing else.
    const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(([, href]) => href ?? '');
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0]).toContain('fonts.googleapis.com');
    // One sans and one mono, each with a real local fallback.
    expect(html).toContain('--sans:"Archivo","Helvetica Neue"');
    expect(html).toContain('--mono:"IBM Plex Mono",ui-monospace');
    // And no display face: the personality is weight, scale and tracking.
    expect(html).not.toContain('Archivo Black');
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

describe('the two hues, on the one page that draws both halves', () => {
  it('paints the surviving head --held and the taken segments --cut', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // `lib/theme.ts`: --cut is taken, --held is survived, and nothing else on any
    // surface is either. This page used to carry its own `.meter .kept` painted
    // `rgb(--ink-c / .40)` — a local copy of a rule the rest of the app had moved
    // on from — so the largest quantity on the card was drawn in the absence of
    // colour while the smaller one had the only colour on the page.
    //
    // Asserted against the theme rather than against a hex, for the same reason
    // the palette test above is: a re-theme must fail `theme-drift.test.ts`, not
    // this file.
    expect(/\.meter \.kept\{([^}]*)\}/.exec(TOKENS + BASE)?.[1] ?? '').toContain('--held-c');

    // Every `.kept` rule in the stylesheet this page actually serves — the
    // theme's and any the page adds — paints the head in --held. The cascade is
    // what a reader sees, so the cascade is what is asserted.
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const kept = style.match(/\.kept\s*\{[^}]*background:[^}]*\}/g) ?? [];
    expect(kept.length, 'the served stylesheet paints a kept head at all').toBeGreaterThan(0);
    for (const rule of kept) {
      expect(rule, 'a kept head must be --held').toContain('--held-c');
      expect(rule, 'a kept head must never be --cut').not.toContain('--cut');
      expect(rule, 'a kept head must not be a neutral again').not.toContain('--ink-c');
    }
    // And the taken segments are --cut, in the same stylesheet.
    for (const rule of style.match(/\.seg\s*\{[^}]*background:[^}]*\}/g) ?? []) {
      expect(rule, 'a taken segment must be --cut').toMatch(/--cut/);
      expect(rule, 'a taken segment must never be --held').not.toContain('--held');
    }
  });

  it('leads the card with the health figure, in the colour that means survived', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');

    // Sequo took 30 in cuts, so it walked out with 70 — and the bar's own
    // readout names the metric that ate the most of the other 30.
    expect(html).toContain('<b class="held">70 health left</b>');
    expect(html).toContain('<b class="pts">&minus;30 in cuts</b>');
    expect(html).toContain('&middot; worst: Durability &minus;');
  });
});

describe('the register fits the room', () => {
  it('calls a b2b panel The Buyers and a consumer one The Floor', async () => {
    const b2b = await renderSeeded('developer-tools', 'Sequo');
    expect(b2b).toContain('<figcaption class="rtitle">The Buyers</figcaption>');

    const consumer = renderVerdictPage(
      parseVerdict({
        ...handBuiltVerdict({ demandStatus: 'scored' }),
        payload: {
          ...(handBuiltVerdict({ demandStatus: 'scored' }).payload as Record<string, unknown>),
          category_type: 'consumer',
        },
      }),
    );
    expect(consumer).toContain('<figcaption class="rtitle">The Floor</figcaption>');
  });
});

/**
 * The share row.
 *
 * The audit's second item: the verdict is the most screenshot-able object the
 * product makes and had two controls, neither of which shared it. The row is
 * `lib/verdict/share.ts`'s and the page's job is to place it — so this asserts
 * the seam is wired and that the badge, which is the only compounding backlink a
 * ranking site gets, points at this verdict's own URL.
 */
describe('the share row', () => {
  it('renders four controls, with the badge and the copy line built from the frozen verdict', async () => {
    const html = await renderSeeded('developer-tools', 'Sequo');
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));
    const url = `https://thepit.show/v/${verdict.slug}`;

    expect(html).toContain('<div class="share-row">');
    expect(html).toContain('Copy verdict line');
    expect(html).toContain('Post on X');
    expect(html).toContain('Badge for README');

    // The badge is an absolute URL under this verdict's own slug, so a README
    // that embeds it links back here from wherever it is pasted. It appears
    // twice: once as the preview the reader sees, once inside the markdown the
    // button copies.
    expect(html).toContain(`src="${url}/badge.svg"`);
    expect(html).toContain(`[![The Pit: #${verdict.rank} of ${verdict.productCount} in ${verdict.category}](${url}/badge.svg)](${url})`);
    // The intent link carries the frozen sentence and the canonical URL.
    expect(html).toContain(`https://twitter.com/intent/tweet?text=${encodeURIComponent(cutsLine(verdict))}`);
    expect(html).toContain(encodeURIComponent(url));
    // And the download moved here from the header.
    expect(html).toContain(`href="${url}?download=1"`);
  });

  it('escapes a hostile name into the copy attributes, and keeps it out of the handler', () => {
    const html = renderVerdictPage(
      parseVerdict(handBuiltVerdict({ name: '"><script>alert(1)</script>' })),
      { origin: 'https://thepit.show' },
    );

    // The name reaches two sinks in this row and each is escaped for itself: the
    // `data-copy` attribute as HTML, the intent's `text` as a query parameter.
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(html).not.toContain('<script>alert');

    // And the handler itself holds no verdict text at all, which is why no name
    // can close it: the payload is in the attribute, the script is a constant.
    const bodies = scriptBodies(html);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('getAttribute(\'data-copy\')');
    expect(bodies[0]).not.toContain('alert(1)');
  });
});
