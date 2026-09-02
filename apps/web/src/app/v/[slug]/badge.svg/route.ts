/**
 * `GET /v/<slug>/badge.svg` — the shield a founder pastes into a README.
 *
 * The same split the OG route uses: the requirements and the drawing live in
 * `lib/verdict/badge.ts`, where they are pure and testable offline, and this file
 * is the transport — one store read, one content type, one set of headers. The
 * store is `lib/verdict/service.ts`'s, so the badge resolves a slug by exactly
 * the read the page and the OG card resolve it by, and cannot see a live ranking.
 *
 * The cache headers are the OG route's, for the OG route's reason: the row behind
 * this is frozen, and the fetcher is GitHub's image proxy rather than a person.
 *
 * A 404 still returns a picture. A README renders whatever it gets, and a
 * broken-image glyph says nothing; a shield that says "not found" says the URL
 * stopped resolving, which is the fact.
 */

import { badgeSvg, notFoundBadgeSvg } from '@/lib/verdict/badge';
import { parseVerdict } from '@/lib/verdict/model';
import { verdictStore } from '@/lib/verdict/service';

const SVG = 'image/svg+xml; charset=utf-8';

/** As frozen as the row behind it, and fetched by proxies rather than by people. */
const CACHE = 'public, max-age=300, s-maxage=31536000, stale-while-revalidate=604800';

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const store = await verdictStore();
  const row = await store.bySlug(slug);

  if (row === undefined) {
    return new Response(notFoundBadgeSvg(), {
      status: 404,
      headers: { 'Content-Type': SVG, 'Cache-Control': 'no-store' },
    });
  }

  return new Response(badgeSvg(parseVerdict(row)), {
    status: 200,
    headers: { 'Content-Type': SVG, 'Cache-Control': CACHE },
  });
}
