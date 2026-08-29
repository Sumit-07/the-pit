/**
 * The GitHub endpoints, as pure functions of a `Request` and their dependencies.
 *
 * Two routes: one that sends the browser to GitHub, one that receives it back.
 * Everything that decides anything lives in `@the-pit/auth`'s
 * `startOAuthSignIn` / `completeOAuthSignIn`; this file chooses status codes and
 * pages.
 *
 * ## Neither of these is on the buying path
 *
 * `brief §2.1`: no login at submission. Guest checkout takes a URL, a name, a
 * description and a payment, and nothing sits between a visitor and their
 * purchase. On a phone without the GitHub app installed, OAuth means typing a
 * password and a 2FA code into a mobile browser for a $5 impulse purchase — so
 * these routes exist beside the funnel, never inside it, and
 * `test/oauth-routes.test.ts` asserts that the whole post-payment handover works
 * with no session and no GitHub anywhere in it.
 *
 * ## The start route is a POST-less GET, deliberately
 *
 * Unlike rotation, starting an OAuth flow is harmless to trigger: it mints a
 * state, sets a cookie, and redirects. The worst a forged trigger achieves is a
 * wasted cookie. Making it a GET is what lets it be an ordinary link on an
 * ordinary page with no JavaScript, which is the same reason `/auth/sign-in` is
 * a plain form.
 */

import { clientIp, completeOAuthSignIn, startOAuthSignIn, type OAuthDeps } from '@the-pit/auth';

import { oauthNoPurchasePage, oauthRateLimitedPage, oauthRejectedPage } from '@/lib/auth/pages';

export interface OAuthHandlerDeps {
  readonly oauth: OAuthDeps;
  /** Must match what is registered with GitHub, byte for byte. */
  readonly redirectUri: string;
  readonly trustedProxyHops?: number;
}

/**
 * `no-referrer` here for a different reason than on the capability path: the
 * callback URL carries `?code=` and `?state=`, and a page that leaked its own
 * URL through a `Referer` would hand a third party a live authorization code.
 */
const OAUTH_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number, cookies: readonly string[] = []): Response {
  const headers = new Headers({ ...OAUTH_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(body, { status, headers });
}

/**
 * `GET /auth/github/start` — mint a state and send them to GitHub.
 *
 * The cookie header is read only to decide the INTENT: a customer who already
 * has a session is connecting GitHub to an account they hold, and the callback
 * must then link rather than go looking for an email match. That decision is
 * made here and sealed into the signed state cookie, so the callback cannot be
 * told which mode to run in by a query parameter.
 */
export function handleGitHubStart(request: Request, deps: OAuthHandlerDeps): Response {
  const started = startOAuthSignIn(
    { redirectUri: deps.redirectUri, now: new Date(), cookieHeader: request.headers.get('cookie') },
    deps.oauth,
  );

  return new Response(null, {
    status: 303,
    headers: { ...OAUTH_HEADERS, location: started.authorizationUrl, 'set-cookie': started.setCookie },
  });
}

/**
 * `GET /auth/github/callback` — the round trip lands here.
 *
 * A GET, because that is what GitHub redirects to and we do not get a choice.
 * That is safe here in a way it is not for the magic link: an authorization code
 * is single-use AT GITHUB, so a mail scanner or prefetcher that follows this URL
 * burns the code at the provider rather than spending something of ours — and
 * the state cookie it does not have would refuse it first anyway.
 */
export async function handleGitHubCallback(request: Request, deps: OAuthHandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };

  const result = await completeOAuthSignIn(
    {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      redirectUri: deps.redirectUri,
      cookieHeader: request.headers.get('cookie'),
      ip: clientIp(request.headers, ipOptions),
      now: new Date(),
    },
    deps.oauth,
  );

  if (result.outcome === 'rate_limited') {
    return html(oauthRateLimitedPage(), 429);
  }

  if (result.outcome === 'no_purchase_found') {
    // 404, not 401 and not 500. Nothing failed and nobody was refused
    // authentication — there simply is no account here, because an account is a
    // purchase. The page says so and names what was checked.
    return html(
      oauthNoPurchasePage({ verifiedEmails: result.verifiedEmails, ignoredEmails: result.ignoredEmails }),
      404,
      result.setCookies,
    );
  }

  if (result.outcome === 'rejected') {
    // `result.reason` is for the log. One page for every cause: telling someone
    // whether their state was missing, stale or wrong is free reconnaissance.
    return html(oauthRejectedPage(), 400, result.setCookies);
  }

  // 303 so a refresh on the account page does not replay the callback and land
  // on "that sign-in did not complete" straight after a successful one.
  const headers = new Headers({ ...OAUTH_HEADERS, location: '/account' });
  for (const cookie of result.setCookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}
