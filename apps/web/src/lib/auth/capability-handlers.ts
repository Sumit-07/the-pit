/**
 * The capability endpoints, as pure functions of a `Request` and their
 * dependencies. Same shape as `handlers.ts`: the route files are two lines each
 * and everything worth testing is here, testable with a hand-built `Request`.
 *
 * ## The headers are the security control on this path
 *
 * A capability URL is a bearer credential that lives in a URL, so the ways URLs
 * escape are the ways this credential escapes. There are four, and all four are
 * closed here rather than by convention:
 *
 * 1. **The `Referer` header.** A page loading any subresource — a font, an
 *    image, an analytics beacon — sends its own URL to that third party. This is
 *    the big one, and it is why `Referrer-Policy: no-referrer` is on every
 *    response and `<meta name="referrer" content="no-referrer">` is in every
 *    page `pages.ts` renders.
 * 2. **The address bar and browser history.** A successful open answers `303`
 *    with `Location: /account` — no slug — so the credential is never the URL of
 *    a page the customer sits on, never in the history of a shared machine, and
 *    never in a screenshot of the browser chrome.
 * 3. **Caches.** `no-store` on everything: a CDN or a shared browser cache
 *    holding this response is the next person's session.
 * 4. **Logs and analytics.** Nothing in this file logs the slug, and
 *    `test/capability-routes.test.ts` asserts that by capturing every `console`
 *    call during a request and searching them for it. That is a weak defence
 *    against the platform's own access log, which records the request line
 *    whatever we do — see the report; it is why rotation exists.
 *
 * ## Rotation is a POST
 *
 * A GET that replaced a credential would be triggerable by any `<img>` tag on
 * any page the customer visits, and by every prefetcher and mail scanner that
 * follows links — the same class of bug that made `GET /auth/verify` render a
 * button instead of consuming a token. `SameSite=Lax` on the session cookie
 * withholds it from cross-site POSTs, which is what makes the POST safe.
 */

import { clientIp, openCapabilityUrl, rotateCapability, type CapabilityDeps } from '@the-pit/auth';

import {
  capabilityRateLimitedPage,
  capabilityRejectedPage,
  capabilityRotatedPage,
} from '@/lib/auth/pages';

export interface CapabilityHandlerDeps {
  readonly capability: CapabilityDeps;
  /** Absolute origin, for building the URL a rotation hands back. */
  readonly origin: string;
  /** How many proxies we control sit in front of this process. Vercel: 1. */
  readonly trustedProxyHops?: number;
}

/**
 * Every capability response carries these.
 *
 * `no-referrer` is the one that matters and it is on the FAILURE responses too:
 * a rejected slug is still a slug someone typed, and leaking a wrong guess to a
 * third party is only marginally better than leaking a right one.
 */
const CAPABILITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...CAPABILITY_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

/**
 * `GET /a/<slug>` — exchange the slug for a session, then get it out of the URL.
 *
 * The `303` is not decoration. It makes the browser follow with a GET to a page
 * whose URL contains no credential, so the moment the customer is looking at
 * their account, the thing in the address bar is `/account`. A `200` rendered
 * here would leave the slug in the address bar, in the history, and in the
 * `Referer` of everything the account page ever loads.
 */
export async function handleCapabilityOpen(
  request: Request,
  slug: string,
  deps: CapabilityHandlerDeps,
): Promise<Response> {
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };

  const result = await openCapabilityUrl(
    { slug, ip: clientIp(request.headers, ipOptions), now: new Date() },
    deps.capability,
  );

  if (result.outcome === 'rate_limited') {
    return html(capabilityRateLimitedPage(), 429, { 'retry-after': String(result.retryAfterSeconds) });
  }
  if (result.outcome === 'rejected') {
    // `result.reason` distinguishes malformed from unknown for the log. It is
    // deliberately not rendered: telling someone walking the keyspace that a
    // candidate had the right shape is the only useful signal they can get.
    return html(capabilityRejectedPage(), 404);
  }

  return new Response(null, {
    status: 303,
    headers: { ...CAPABILITY_HEADERS, location: '/account', 'set-cookie': result.setCookie },
  });
}

/**
 * `POST /auth/capability/rotate` — replace the slug, from the session.
 *
 * Gated on the session rather than on holding the slug being replaced. After a
 * genuine leak the leaker also holds the slug, and a design where possession
 * were enough would let them rotate first and lock the customer out of their own
 * account. See `capability/access.ts`.
 */
export async function handleCapabilityRotate(
  request: Request,
  deps: CapabilityHandlerDeps,
): Promise<Response> {
  const result = await rotateCapability(
    { cookieHeader: request.headers.get('cookie'), origin: deps.origin, now: new Date() },
    deps.capability,
  );

  if (result.outcome === 'rejected') {
    // 401 for both reasons. `unknown_account` behind a valid signature is our
    // bug rather than an attack, and it is logged, not rendered.
    return html(capabilityRejectedPage(), 401);
  }

  return html(capabilityRotatedPage(result.url), 200);
}
