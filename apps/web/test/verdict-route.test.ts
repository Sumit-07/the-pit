/**
 * `GET /v/<slug>`.
 *
 * The route is exercised against the real seeded boards through the same store
 * binding a deployment uses, with `PIT_WORKDIR` pointed at the repository's
 * `cjr/`. No database, no network: `@the-pit/db`'s seed builder is pure over
 * files, and `lib/verdict/service.ts` is the only thing that reads them.
 *
 * The property this file is really about is `brief §2.1`: "verdict URLs are
 * public ... attempt balance and history sit behind a session". A page that
 * needed a session could not be cached publicly at the edge and could not be
 * fetched with no cookies at all, so both are asserted.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

process.env['PIT_WORKDIR'] = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

const { GET } = await import('@/app/v/[slug]/route');
const { resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');

function request(url: string): Request {
  return new Request(url);
}

function params(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

let sequoSlug: string;

beforeAll(async () => {
  resetVerdictStore();
  // The public slug is derived, not chosen: `verdictSlug` in `@the-pit/db`
  // hashes the verdict id. Look it up the way a visitor's link would have been
  // produced rather than hard-coding a digest.
  const store = await verdictStore();
  const { buildSeedRows, loadSeedInput } = await import('@the-pit/db');
  const input = await loadSeedInput('developer-tools', process.env['PIT_WORKDIR'] as string);
  const seed = buildSeedRows(input);
  // Found by ENGINE ID, not by the name on the page: every seeded listing is
  // anonymous (`DECISIONS.md`, S4-source), so the frozen payload carries a
  // designation and the submitted name is not in it to search for.
  const target = input.ranking.ranking.find((candidate) => candidate.name.startsWith('Sequo'));
  if (target === undefined) throw new Error('no product in developer-tools named Sequo…');
  const row = seed.verdicts.find(
    (candidate) => (candidate.payload as { verdict?: { id?: unknown } }).verdict?.id === target.id,
  );
  if (row === undefined) throw new Error('no seeded verdict for Sequo');
  sequoSlug = row.publicSlug;
  expect(await store.bySlug(sequoSlug)).toBeDefined();
});

describe('the public verdict URL', () => {
  it('serves the page to a request carrying no session at all', async () => {
    const response = await GET(request(`https://thepit.show/v/${sequoSlug}`), params(sequoSlug));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    // Cacheable at the edge for everyone. A session-gated page could not be.
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('Set-Cookie')).toBeNull();

    const html = await response.text();
    // The designation, and NOT the submitted name — this listing is seeded, and a
    // seeded listing is published anonymously.
    expect(html).toMatch(/Unit [A-Za-z]+-\d{3}/);
    expect(html).not.toContain('Sequo');
    expect(html).toContain('of 48 products');
    expect(html).toContain('Verdict &middot; Developer Tools');
  });

  it('writes its canonical and share URLs against the request origin', async () => {
    const response = await GET(request(`https://thepit.show/v/${sequoSlug}?x=1`), params(sequoSlug));
    const html = await response.text();

    expect(html).toContain(`<link rel="canonical" href="https://thepit.show/v/${sequoSlug}">`);
    expect(html).toContain(`content="https://thepit.show/v/${sequoSlug}/og"`);
  });

  it('hands the page over as a file when asked', async () => {
    const response = await GET(request(`https://thepit.show/v/${sequoSlug}?download=1`), params(sequoSlug));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="the-pit-${sequoSlug}.html"`);
    // The same bytes as the page: what is saved is what was being read.
    const downloaded = await response.text();
    const viewed = await (await GET(request(`https://thepit.show/v/${sequoSlug}`), params(sequoSlug))).text();
    expect(downloaded).toBe(viewed);
  });

  it('keeps a hostile slug out of the Content-Disposition header', async () => {
    // The slug reaches the handler from the URL. `verdicts_public_slug_shape`
    // constrains what can be STORED; nothing constrains what can be REQUESTED,
    // and a quote in a filename is a header injection.
    const response = await GET(
      request('https://thepit.show/v/x"%20evil'),
      params('x" evil'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });
});

describe('a slug that resolves to nothing', () => {
  it('is a 404 that says which link failed, escaped', async () => {
    const response = await GET(
      request('https://thepit.show/v/nope'),
      params('<img src=x onerror=alert(1)>'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const html = await response.text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Verdict URLs are permanent');
  });
});
