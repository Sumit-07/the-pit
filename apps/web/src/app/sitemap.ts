/**
 * `/sitemap.xml` — the public surface, enumerated.
 *
 * Everything this site wants read is a document that already exists on disk or in
 * a bucket: three fixed pages, a board per seeded or published category, and a
 * verdict per product on those boards. So the sitemap is not a hand-kept list
 * that goes stale the day a category is added — it is derived from the SAME two
 * stores the pages themselves read, and a category seeded tomorrow appears in it
 * without anyone editing this file.
 *
 * ## What is in it, and what is deliberately not
 *
 * In: `/`, `/how-it-works`, `/boards`, every `/boards/<slug>`, and every
 * `/v/<slug>` that has been delivered. `brief §2.1` — "Verdict URLs are public...
 * works logged out" — is the whole reason the last group belongs here: the
 * verdict page is the artefact, and 92 cold-start verdicts that no crawler can
 * find are 92 pages that might as well not exist.
 *
 * Out: `/submit`, `/account`, `/a/*`, `/status/*`, `/auth/*` and `/api/*`. Each is
 * either behind a session, a capability token or a run id, and none of them is a
 * document. `robots.ts` disallows the same set, and the two lists are the same
 * list — a sitemap that advertises what robots.txt forbids is a contradiction a
 * crawler resolves by trusting neither.
 *
 * ## No database at build time
 *
 * `next build` prerenders this. `defaultBoardSource` is a `readFile` or a bucket
 * GET (`lib/boards/source.ts`), and `seededVerdictSlugs` materialises the frozen
 * cold-start rows from `cjr/` through the seed's own freezer — neither opens a
 * connection, which is what makes the filesystem-storage build work with no
 * `DATABASE_URL` in existence. A verdict delivered through the money path lives
 * in Postgres and is not enumerable here; it is reachable, linked from its board
 * row, and a crawler finds it the way a reader does.
 *
 * Every failure degrades to a shorter sitemap rather than to a failed build. A
 * malformed `cjr/` should cost the site its index entries for one category, not
 * its deploy.
 */

import type { MetadataRoute } from 'next';

import { defaultBoardSource } from '@/lib/boards/source';
import { seededVerdictSlugs } from '@/lib/verdict/service';

import { SITE_ORIGIN } from './robots';

export const revalidate = 86400;

/**
 * The origin the entries are written against.
 *
 * `<loc>` must be absolute and must match the host the pages are served from, so
 * a preview deployment gets its own origin through `PIT_PUBLIC_ORIGIN` — the same
 * variable `/v/<slug>` uses for its canonical link, for the same reason.
 */
function origin(): string {
  const configured = process.env['PIT_PUBLIC_ORIGIN'];
  return configured === undefined || configured === '' ? SITE_ORIGIN : configured.replace(/\/+$/, '');
}

/** The three pages that exist whether or not a single board has been published. */
const FIXED: readonly { path: string; priority: number; changeFrequency: 'daily' | 'monthly' }[] = [
  { path: '/', priority: 1, changeFrequency: 'daily' },
  { path: '/boards', priority: 0.9, changeFrequency: 'daily' },
  { path: '/how-it-works', priority: 0.6, changeFrequency: 'monthly' },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = origin();
  const now = new Date();

  const entries: MetadataRoute.Sitemap = FIXED.map((page) => ({
    url: `${base}${page.path}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  let slugs: string[] = [];
  try {
    slugs = await defaultBoardSource().list();
  } catch {
    // A bucket that refuses to enumerate, or a workdir that is not there. The
    // three fixed pages are still a valid sitemap.
    slugs = [];
  }

  for (const slug of slugs) {
    const document_ = await defaultBoardSource().read(slug);
    if (document_ === undefined) continue;

    // The board's own stamp, not the build's: `lastmod` is a claim about the
    // document, and a rebuild that changed nothing must not tell every crawler
    // that all 48 rows moved.
    const rankedAt = new Date(document_.generatedAt);
    const lastModified = Number.isNaN(rankedAt.getTime()) ? now : rankedAt;

    entries.push({
      url: `${base}/boards/${slug}`,
      lastModified,
      changeFrequency: 'daily',
      priority: 0.8,
    });

    // The verdict slugs come out of the freezer that issued them
    // (`lib/verdict/service.ts`), never re-derived here: `verdicts.public_slug`
    // is a hash of a deterministic uuid and a second implementation of a
    // permanent public URL would be worse than no sitemap entry at all.
    for (const verdictSlug of (await seededVerdictSlugs(slug)).values()) {
      entries.push({
        url: `${base}/v/${verdictSlug}`,
        lastModified,
        // A verdict is frozen. It is in here so it can be found, not so it can
        // be re-crawled.
        changeFrequency: 'yearly',
        priority: 0.7,
      });
    }
  }

  return entries;
}
