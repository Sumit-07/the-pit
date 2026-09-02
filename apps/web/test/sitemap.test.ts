/**
 * `/sitemap.xml` and `/robots.txt`, checked against the stores they are derived
 * from.
 *
 * Both files are one-function modules, which makes them exactly the kind of thing
 * that is written once, is right on the day, and then silently stops being right:
 * a category is seeded and never indexed, or a private surface is added and never
 * disallowed. So these tests assert the two properties that decay —
 *
 * 1. **The sitemap is DERIVED.** Both seeded boards are in it because they are on
 *    disk, not because they were typed, and every verdict URL in it came out of
 *    the freezer that issued it.
 * 2. **The two lists agree.** Nothing robots.txt forbids appears in the sitemap.
 *
 * — and the one that must never regress: neither module opens a database. The
 * suite runs with `PIT_STORAGE=filesystem` and no `DATABASE_URL`, which is the
 * shape of the build this repository actually ships.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import robots, { PRIVATE, SITE_ORIGIN } from '@/app/robots';
import sitemap from '@/app/sitemap';
import { defaultBoardSource } from '@/lib/boards/source';
import { seededVerdictSlugs } from '@/lib/verdict/service';

/**
 * Both stores read `PIT_WORKDIR` lazily, inside the call, so assigning it after
 * the hoisted imports is enough — the same arrangement `verdict-route.test.ts`
 * relies on. `PIT_STORAGE` pins the filesystem binding, which is the shape of
 * the build this repository ships.
 */
process.env['PIT_WORKDIR'] = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');
process.env['PIT_STORAGE'] = 'filesystem';

let urls: string[];

beforeAll(async () => {
  urls = (await sitemap()).map((entry) => entry.url);
});

const path = (url: string): string => new URL(url).pathname;

describe('the sitemap', () => {
  it('lists the three fixed pages', () => {
    expect(urls).toContain(`${SITE_ORIGIN}/`);
    expect(urls).toContain(`${SITE_ORIGIN}/how-it-works`);
    expect(urls).toContain(`${SITE_ORIGIN}/boards`);
  });

  it('lists every board on disk, which is both of the seeded ones', () => {
    // Named rather than counted: a sitemap that "has two boards" would pass with
    // the same board twice.
    expect(urls).toContain(`${SITE_ORIGIN}/boards/developer-tools`);
    expect(urls).toContain(`${SITE_ORIGIN}/boards/health-fitness-wellness`);
  });

  it('lists a verdict URL for every product on those boards', async () => {
    const verdicts = urls.filter((url) => path(url).startsWith('/v/'));

    // 48 + 44 on this checkout, and the assertion is against the freezer rather
    // than against a typed-in total, so seeding a third category cannot make this
    // test wrong without making the sitemap wrong first.
    const expected = [
      ...(await seededVerdictSlugs('developer-tools')).values(),
      ...(await seededVerdictSlugs('health-fitness-wellness')).values(),
    ];
    expect(expected.length).toBeGreaterThan(80);
    expect(verdicts).toHaveLength(expected.length);
    for (const slug of expected) expect(urls).toContain(`${SITE_ORIGIN}/v/${slug}`);
  });

  it('stamps a board with the moment it was ranked, not the moment it was built', async () => {
    const document_ = await defaultBoardSource().read('developer-tools');
    const entry = (await sitemap()).find((row) => row.url === `${SITE_ORIGIN}/boards/developer-tools`);

    expect(document_).toBeDefined();
    expect(new Date(entry?.lastModified as Date).toISOString()).toBe(
      new Date(document_?.generatedAt as string).toISOString(),
    );
  });

  it('advertises nothing robots.txt forbids', () => {
    for (const url of urls) {
      for (const forbidden of PRIVATE) {
        expect(path(url).startsWith(forbidden), `${url} is disallowed by robots.txt`).toBe(false);
      }
    }
  });

  it('writes absolute URLs on the site origin, and no duplicates', () => {
    for (const url of urls) expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('robots.txt', () => {
  const file = robots();
  const rule = Array.isArray(file.rules) ? file.rules[0] : file.rules;

  it('lets a crawler read the whole public site', () => {
    expect(rule?.userAgent).toBe('*');
    expect(rule?.allow).toBe('/');
  });

  it('keeps the session, the capability shortener, runs, auth and the API out', () => {
    const disallow = (rule?.disallow ?? []) as string[];
    expect(disallow).toEqual(expect.arrayContaining(['/submit', '/account', '/a/', '/status/', '/auth/', '/api/']));
  });

  it('points at the sitemap', () => {
    expect(file.sitemap).toBe(`${SITE_ORIGIN}/sitemap.xml`);
  });
});
