/**
 * `/robots.txt` — everything public is crawlable, and nothing else is a document.
 *
 * The allow list is the whole site, because that is what the site is: `brief`
 * Part 6 wants the boards free and CDN-cached and the verdict URLs public and
 * working logged out. A product whose argument is "the method is checkable" does
 * not hide the pages the method is checkable on.
 *
 * The disallow list is the five surfaces that are not documents at all:
 *
 * - `/submit` and `/account` are behind a session.
 * - `/a/*` is the capability shortener — a URL that IS a credential, and one a
 *   crawler must never dereference, index or hand to a cache.
 * - `/status/*` is a live view of one run, keyed on a run id.
 * - `/auth/*` is the magic-link and OAuth machinery. A crawler following a
 *   verify link would consume it.
 * - `/api/*` is JSON, including the webhook the payment processor posts to.
 *
 * `PRIVATE` and `SITE_ORIGIN` live here rather than in `sitemap.ts`, and the
 * sitemap imports them, because the dependency has to run this way round: this
 * file has no dependencies at all, and the sitemap reads two stores. A sitemap
 * that advertised a path this file forbids is the ordinary way a robots.txt
 * becomes fiction, and `test/sitemap.test.ts` holds the two lists together.
 */

import type { MetadataRoute } from 'next';

/**
 * The origin every absolute public URL is written against.
 *
 * `brief` Part 5 fixes the domain. A preview deployment overrides it through
 * `PIT_PUBLIC_ORIGIN`, the same variable `/v/<slug>` uses for its canonical link.
 */
export const SITE_ORIGIN = 'https://thepit.show';

/** Not documents. Behind a session, a capability token, a run id, or a content type. */
export const PRIVATE = ['/submit', '/account', '/a/', '/status/', '/auth/', '/api/'] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...PRIVATE] }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
