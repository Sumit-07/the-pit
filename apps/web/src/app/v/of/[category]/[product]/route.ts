/**
 * `GET /v/of/<category>/<product>` — the board row's route to its verdict.
 *
 * ## Why a redirect and not an href
 *
 * Every product on a board has a verdict page and, until this existed, nothing on
 * the site linked to one: `/boards/<slug>` named 48 products and carried no `/v/`
 * link at all, so the surface `brief` Part 6 calls "the thing someone pays $5 for"
 * was reachable only by pasting a hash.
 *
 * The obvious fix — put the verdict's slug on the board row — is the one thing
 * the board must not do. `verdicts.public_slug` is a hash of a deterministic uuid
 * that lives in `@the-pit/db`, and `test/boards-read-path.test.ts` walks the
 * module graph of every public board route to keep that package (and the driver
 * under it) off a cached read. `brief` Part 3 is the reason: "Boards are CDN
 * snapshots... Reads never touch a model", and `02 §4`: "The board never computes
 * anything at read time." A board that loaded a database client to render a
 * hyperlink would break both, and a board that re-implemented the hash would be a
 * second definition of a permanent public URL.
 *
 * So the board names what it legitimately knows — its category slug and the
 * engine's product id, both already in the document it renders from — and this
 * route resolves that pair to the verdict's own URL. The static document stays
 * static; the lookup happens once, on a click, off the read path.
 *
 * ## And it is the right seam for S8
 *
 * `DECISIONS.md` S8 — what a re-pitch does to a superseded verdict URL — is open.
 * A slug baked into a prerendered board would be the wrong answer to every
 * reading of it: under `redirect_to_current` the board would keep pointing at the
 * archived page until the next rebuild. A board row that points at the PRODUCT
 * and a resolver that decides which verdict that means is the shape all the
 * readings need. Today it resolves the cold-start verdict; when S8 settles it
 * gains a rule and the board does not move.
 *
 * ## Public, like the page it lands on
 *
 * No session, no cookie, and — as `lib/verdict/service.ts` documents — no
 * database unless the deployment binds one. It is a `permanent: false` redirect
 * because which verdict a product resolves to is exactly the thing S8 has not
 * decided; a 308 cached in a browser could not be told otherwise later.
 */

import { seededVerdictSlugs } from '@/lib/verdict/service';

/**
 * Short, and revalidating.
 *
 * A verdict page is immutable and cached hard (`VERDICT_CACHE_CONTROL`). Which
 * verdict a product currently resolves to is not: a re-pitch issues a new one.
 * Five minutes at the edge keeps 48 rows off the origin without pinning an answer
 * that can change.
 */
export const RESOLVE_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400';

export async function GET(
  request: Request,
  context: { params: Promise<{ category: string; product: string }> },
): Promise<Response> {
  const { category, product } = await context.params;

  // The id arrives from the URL. Anything that is not a plain non-negative
  // integer is not a product id this board could have written, and it must not
  // reach a map lookup as a string that happens to coerce.
  const engineId = /^\d{1,9}$/.test(product) ? Number(product) : Number.NaN;
  if (!Number.isInteger(engineId)) return new Response('Not found', { status: 404 });

  const slugs = await seededVerdictSlugs(category);
  const slug = slugs.get(engineId);
  if (slug === undefined) return new Response('Not found', { status: 404 });

  // Relative, so the redirect is correct behind any proxy and in any preview
  // deployment without a configured origin. `slug` came out of the freezer, not
  // out of the URL, but it is encoded all the same — the one place a slug becomes
  // a header value is the one place it must not be able to hold a newline.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/v/${encodeURIComponent(slug)}`,
      'Cache-Control': RESOLVE_CACHE_CONTROL,
    },
  });
}
