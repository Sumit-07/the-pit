/**
 * `GET /v/<slug>/badge.svg`, and the shield it draws.
 *
 * The route is exercised against the real seeded boards through the same store
 * binding a deployment uses, exactly as `verdict-route.test.ts` does, and the
 * drawing is checked against hand-built payloads for the cases the seeded data
 * cannot supply — a category label containing markup, a card with nothing cut.
 *
 * The badge is the one verdict surface that renders inside somebody else's
 * document, which makes two properties load-bearing: `brief` Part 5's rule that a
 * rank never appears without its product count, and that no payload string can
 * write an element into the SVG.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

process.env['PIT_WORKDIR'] = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

import { badgeFields, badgeSvg, escapeXml } from '@/lib/verdict/badge';
import { parseVerdict } from '@/lib/verdict/model';

import { handBuiltVerdict, seededVerdictNamed, WORKDIR } from './helpers/verdict.js';

const { GET } = await import('@/app/v/[slug]/badge.svg/route');
const { registerVerdictStore, resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');
const { MemoryVerdictStore } = await import('@/lib/verdict/store');

function params(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

function request(slug: string): Request {
  return new Request(`https://thepit.show/v/${slug}/badge.svg`);
}

let sequoSlug: string;

beforeAll(async () => {
  resetVerdictStore();
  const { buildSeedRows, loadSeedInput } = await import('@the-pit/db');
  const input = await loadSeedInput('developer-tools', WORKDIR);
  const target = input.ranking.ranking.find((row) => row.name.startsWith('Sequo'));
  if (target === undefined) throw new Error('no product in developer-tools named Sequo…');
  const row = buildSeedRows(input).verdicts.find(
    (candidate) => (candidate.payload as { verdict?: { id?: unknown } }).verdict?.id === target.id,
  );
  if (row === undefined) throw new Error('no seeded verdict for Sequo');
  sequoSlug = row.publicSlug;
  expect(await (await verdictStore()).bySlug(sequoSlug)).toBeDefined();
});

describe('the badge route', () => {
  it('serves an SVG for a slug that resolves', async () => {
    const response = await GET(request(sequoSlug), params(sequoSlug));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    // The row is frozen and the fetcher is an image proxy, so it is cached as
    // hard as the OG card is.
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, s-maxage=31536000, stale-while-revalidate=604800',
    );

    const svg = await response.text();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#7 of 48');
    expect(svg).toContain('Developer Tools');
    // The submitted name is not on a seeded listing's badge, and neither is the
    // designation: the shield carries the position, not the product.
    expect(svg).not.toContain('Sequo');
  });

  it('never puts a rank on the shield without its product count', async () => {
    const svg = await (await GET(request(sequoSlug), params(sequoSlug))).text();

    expect(svg).toMatch(/#\d+ of \d+/);
    expect(svg).not.toMatch(/#\d+ ·/);
  });

  it('answers an unknown slug with a 404 that is still a picture', async () => {
    const response = await GET(request('nosuchslug'), params('nosuchslug'));

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('not found');
  });

  it('escapes a name-shaped payload rather than writing elements into the SVG', async () => {
    // The category label is the only payload string on the shield, so that is
    // where the hostile value has to go.
    resetVerdictStore();
    const row = handBuiltVerdict({ category: '</text><script>alert(1)</script>', name: 'Runlet' });
    registerVerdictStore(new MemoryVerdictStore([row]));

    const response = await GET(request(row.publicSlug), params(row.publicSlug));
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('</text><script>');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;');
    // One text element per label and nothing more: three opens, three closes.
    expect(svg.match(/<text/g)).toHaveLength(3);
    expect(svg.match(/<\/text>/g)).toHaveLength(3);

    resetVerdictStore();
  });
});

describe('what the shield says', () => {
  it('states the rank with its count, the category, and the health that survived', () => {
    // cuts = 100 - mean(60, 80) = 30, so 70 health left — the same arithmetic the
    // page's health meter runs off the same frozen field.
    const fields = badgeFields(parseVerdict(handBuiltVerdict()));

    expect(fields.mark).toBe('THE PIT');
    expect(fields.claim).toBe('#7 of 48 · Developer Tools');
    expect(fields.health).toBe('70 health');
    expect(fields.title).toBe('The Pit — #7 of 48 · Developer Tools, 70 health left');
  });

  it('says 100 health when nothing came off the card', () => {
    const fields = badgeFields(
      parseVerdict(
        handBuiltVerdict({
          scorecard: [
            { metric: 'Trust Surface', score: 100, spread: 0, juror_count: 6, substituted_roles: [], deductions: [] },
          ],
        }),
      ),
    );

    expect(fields.health).toBe('100 health');
  });

  it('draws the two segments flat, square and in the site palette', () => {
    const svg = badgeSvg(parseVerdict(handBuiltVerdict()));

    expect(svg).toContain('fill="#1a1610"');
    expect(svg).toContain('fill="#f45c33"');
    expect(svg).toContain('fill="#3e9c86"');
    // Flat and square: no gradient, no rounded corner, no external font.
    expect(svg).not.toContain('rx=');
    expect(svg).not.toContain('linearGradient');
    expect(svg).toContain('font-family="ui-monospace,Menlo,monospace"');
    expect(svg).not.toContain('@import');
    // Named for assistive technology, and titled rather than aria-labelled so the
    // same string is what a browser shows on hover.
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title id="t">');
  });

  it('grows its width with the label it has to hold', () => {
    const width = (svg: string): number => Number(/ width="(\d+)"/.exec(svg)?.[1]);

    const short = width(badgeSvg(parseVerdict(handBuiltVerdict({ category: 'Notes' }))));
    const long = width(badgeSvg(parseVerdict(handBuiltVerdict({ category: 'Developer Productivity Tools' }))));

    expect(long).toBeGreaterThan(short);
    // 20px tall, always: a shield taller than its row is a broken README.
    expect(badgeSvg(parseVerdict(handBuiltVerdict()))).toContain('height="20"');
  });
});

describe('escaping for XML', () => {
  it('replaces the four characters that can leave a text node or an attribute', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('escapes the ampersand first, so an entity is not double-written', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});
