/**
 * `GET /v/<slug>` — the verdict page.
 *
 * ## Public, and it works logged out
 *
 * `brief §2.1`: "Verdict URLs are public. Attempt balance and history are behind
 * the session." So there is no session read on this path, no cookie parsed, no
 * redirect to sign in, and nothing imported here can reach one. That is not a
 * policy this handler follows — it is the whole set of imports it has.
 *
 * ## Frozen
 *
 * The handler resolves a slug to a stored row and renders it. It never opens a
 * ranking, a board or a snapshot, because `DECISIONS.md §1.2` moves every z-score
 * on every placement: a page rendered live would show a different number tomorrow
 * than the one somebody shared today.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * `brief` Part 6 requires the page to be **downloadable**. The document this
 * returns is self-contained — its CSS is inline, it loads no font, it runs no
 * script — so `?download=1` is the same bytes with one header added, and the file
 * a customer saves is the page they were looking at. A React tree would have to
 * be re-rendered into a second, separately-maintained standalone document to make
 * that true. The magic-link screens (`lib/auth/pages.ts`) took the same route for
 * a related reason.
 */

import { parseVerdict, VerdictPayloadError } from '@/lib/verdict/model';
import { renderVerdictNotFound, renderVerdictPage } from '@/lib/verdict/page';
import { verdictStore } from '@/lib/verdict/service';

/**
 * A verdict never changes, so it is cached hard at the edge. `max-age` is short
 * rather than a year because the route's BEHAVIOUR above the row is still open:
 * `DECISIONS.md` S8 has not decided whether a superseded verdict keeps serving or
 * redirects, and a browser holding an `immutable` copy could not be told either
 * way. The document itself is frozen; the URL's disposition is not yet.
 */
export const VERDICT_CACHE_CONTROL = 'public, max-age=300, s-maxage=31536000, stale-while-revalidate=604800';

/** `Content-Disposition` filenames get the schema's own slug alphabet and nothing else. */
function safeFilename(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  return `the-pit-${clean === '' ? 'verdict' : clean}.html`;
}

/**
 * The origin the page's canonical, share and download links are written against.
 *
 * `PIT_PUBLIC_ORIGIN` wins, because behind a proxy `request.url` carries the
 * internal host and these links end up in a screenshot, an OG tag and a saved
 * file — three places nobody can correct later.
 */
function publicOrigin(request: Request): string {
  const configured = process.env['PIT_PUBLIC_ORIGIN'];
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

function html(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const origin = publicOrigin(request);

  const store = await verdictStore();
  const row = await store.bySlug(slug);

  if (row === undefined) {
    return html(renderVerdictNotFound(slug, { origin }), 404, { 'Cache-Control': 'no-store' });
  }

  let page: string;
  try {
    page = renderVerdictPage(parseVerdict(row), { origin });
  } catch (error) {
    if (!(error instanceof VerdictPayloadError)) throw error;
    // The stored row is the record a dispute is argued from (`brief` Part 7). If
    // it cannot be read, say so loudly rather than serving a blank card that
    // looks like a delivered verdict with nothing wrong with it. The detail stays
    // in the log; the page says only that this one needs a human.
    console.error(error);
    return html(renderVerdictNotFound(slug, { origin }), 500, { 'Cache-Control': 'no-store' });
  }

  const wantsDownload = new URL(request.url).searchParams.get('download') !== null;

  return html(page, 200, {
    'Cache-Control': VERDICT_CACHE_CONTROL,
    ...(wantsDownload ? { 'Content-Disposition': `attachment; filename="${safeFilename(slug)}"` } : {}),
  });
}
