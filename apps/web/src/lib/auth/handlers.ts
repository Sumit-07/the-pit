/**
 * The three auth endpoints, as pure functions of a `Request` and their
 * dependencies.
 *
 * The route files under `src/app/auth/` are two lines each: resolve the deps,
 * call the handler. Everything worth testing is here, and it is testable with a
 * hand-built `Request` — no server, no database, no key, no Next.js runtime.
 *
 * ## The shape that matters
 *
 * `handleVerifyPage` takes NO dependencies. Not an unused parameter, not an
 * optional one — its signature has no store, no limiter and no keyring in it, so
 * "the GET does not consume the token" is a property of the type rather than of
 * this month's implementation. `brief §2.1` is explicit that this is the one
 * people skip:
 *
 * > Corporate mail scanners (Outlook Safe Links) follow GET links and would burn
 * > single-use tokens. Do not skip this.
 *
 * `test/auth-routes.test.ts` asserts the consequence from the outside: after a
 * GET, the store's call log is empty and the token still redeems.
 *
 * ## Content negotiation
 *
 * `POST /auth/request` answers HTML to a form post and JSON to a JSON post, so
 * the sign-in page works with scripting disabled and a client can still call it
 * as an API. Both answers are constants within their format — `brief §2.1`'s
 * "always respond 'check your inbox'" is about the response not varying with the
 * ADDRESS, and it does not.
 */

import {
  clientIp,
  readSession,
  requestMagicLink,
  verifyMagicLink,
  type AuthRequestDeps,
  type SessionKeyring,
  type VerifyDeps,
} from '@the-pit/auth';

import {
  requestResultPage,
  verifyButtonPage,
  verifyRateLimitedPage,
  verifyRejectedPage,
} from '@/lib/auth/pages';

export interface AuthHandlerDeps {
  readonly request: AuthRequestDeps;
  readonly verify: VerifyDeps;
  readonly keyring: SessionKeyring;
  /** `false` on `http://localhost`; see `@the-pit/auth`'s cookie module. */
  readonly secureCookies?: boolean;
  /** How many proxies we control sit in front of this process. Vercel: 1. */
  readonly trustedProxyHops?: number;
}

/**
 * Headers every auth response carries.
 *
 * `no-store` because two of these pages have a bearer token in their URL and the
 * third sets a 90-day credential; a CDN or a browser cache holding either is a
 * session handed to the next person on the machine. `no-referrer` because the
 * token is in the query string of the verify page and the `Referer` header is
 * how query strings escape.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

/** Read one field from a form-encoded or JSON body, whichever was sent. */
async function readField(request: Request, name: string): Promise<{ value: string; wantsJson: boolean }> {
  const contentType = request.headers.get('content-type') ?? '';
  const wantsJson = contentType.includes('application/json');

  if (wantsJson) {
    const parsed: unknown = await request.json().catch(() => null);
    const value =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)[name] === 'string'
        ? ((parsed as Record<string, string>)[name] ?? '')
        : '';
    return { value, wantsJson };
  }

  const form = await request.formData().catch(() => null);
  const field = form?.get(name);
  return { value: typeof field === 'string' ? field : '', wantsJson };
}

/**
 * `POST /auth/request`.
 *
 * The handler adds nothing to the decision — `requestMagicLink` already returns
 * one status and one message, and the only thing that happens here is choosing
 * a content type for them. `result.outcome` is deliberately not used to vary
 * anything: it is the log field, and this is the file where someone would be
 * tempted to render it.
 */
export async function handleAuthRequest(request: Request, deps: AuthHandlerDeps): Promise<Response> {
  const { value: email, wantsJson } = await readField(request, 'email');
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };

  const result = await requestMagicLink(
    { email, ip: clientIp(request.headers, ipOptions), now: new Date() },
    deps.request,
  );

  const extra: Record<string, string> =
    result.retryAfterSeconds === undefined ? {} : { 'retry-after': String(result.retryAfterSeconds) };

  return wantsJson
    ? json({ message: result.message }, result.httpStatus, extra)
    : html(requestResultPage(result.message), result.httpStatus, extra);
}

/**
 * `GET /auth/verify` — renders a button and touches nothing.
 *
 * No `deps` parameter, no `async`, no `await`. There is nothing here that could
 * spend a token even if someone tried.
 */
export function handleVerifyPage(request: Request): Response {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  // An empty token still renders the button. The POST is what decides, and
  // deciding here would mean this handler had an opinion about token validity,
  // which is the first step toward it checking one.
  return html(verifyButtonPage(token), 200);
}

/** `POST /auth/verify` — the only thing in the app that can spend a token. */
export async function handleVerifySubmit(request: Request, deps: AuthHandlerDeps): Promise<Response> {
  const { value: token } = await readField(request, 'token');
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };

  const result = await verifyMagicLink(
    { token, ip: clientIp(request.headers, ipOptions), now: new Date() },
    deps.verify,
  );

  if (result.outcome === 'rate_limited') {
    return html(verifyRateLimitedPage(), 429, { 'retry-after': String(result.retryAfterSeconds) });
  }
  if (result.outcome === 'rejected') {
    return html(verifyRejectedPage(), 400);
  }

  // 303, not 302: the browser must follow with a GET, or a refresh on the
  // account page replays the POST and lands on the "that link no longer works"
  // page immediately after a successful sign-in.
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, location: '/account', 'set-cookie': result.setCookie },
  });
}

/**
 * `GET /auth/session` — who the cookie says you are, or 401.
 *
 * `brief §2.1`: "Attempt balance and history are behind the session. Verdict
 * URLs are public." This is the gate, on its own, with no data behind it: the
 * balance and the history belong to the ledger and to the accounts schema, which
 * are other agents' work. What it proves is that the gate refuses a cookie it
 * did not sign — see `test/auth-routes.test.ts`.
 */
export function handleSession(request: Request, deps: AuthHandlerDeps): Response {
  const options = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const verified = readSession({
    cookieHeader: request.headers.get('cookie'),
    keyring: deps.keyring,
    now: new Date(),
    ...options,
  });

  if (!verified.valid) {
    // One body for every reason. A tampered cookie and an absent one are the
    // same 401; the reason is a log field, not a response.
    return json({ signedIn: false }, 401);
  }

  return json(
    {
      signedIn: true,
      accountId: verified.session.accountId,
      email: verified.session.email,
      expiresAt: new Date(verified.session.expiresAt * 1000).toISOString(),
    },
    200,
  );
}
