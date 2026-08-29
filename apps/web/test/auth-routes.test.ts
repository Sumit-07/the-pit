/**
 * The auth routes, exercised as HTTP.
 *
 * These call the handlers with hand-built `Request` objects and assert on the
 * `Response` — no server, no database, no key, no network. What is checked here
 * is the part `packages/auth`'s unit tests cannot see: the actual status, the
 * actual bytes, the actual `Set-Cookie`, and above all which verb reaches the
 * store.
 *
 * The most valuable test in this file is `a GET does not consume the token`. It
 * is the `brief §2.1` requirement that gets skipped, and skipping it produces a
 * bug that reproduces only on corporate mail systems: Outlook Safe Links,
 * Proofpoint and Mimecast fetch every URL in an inbound message, so a
 * single-use token behind a GET is spent before the recipient has finished
 * reading the subject line.
 */

import {
  CHECK_YOUR_INBOX,
  FixtureMailTransport,
  hashToken,
  MemoryAuthStore,
  MemoryRateLimiter,
  magicTokenExpiry,
  newSessionPayload,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  type SessionKeyring,
} from '@the-pit/auth';
import { beforeEach, describe, expect, it } from 'vitest';

import * as signInRoute from '@/app/auth/sign-in/route';
import * as verifyRoute from '@/app/auth/verify/route';
import { AuthNotWiredError, resetAuthWiring } from '@/lib/auth/config';
import type { AuthHandlerDeps } from '@/lib/auth/handlers';
import { handleAuthRequest, handleSession, handleVerifyPage, handleVerifySubmit } from '@/lib/auth/handlers';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const KEYRING: SessionKeyring = [SECRET];
const KNOWN = 'alice@example.com';
const UNKNOWN = 'nobody@example.com';
const ORIGIN = 'https://thepit.show';
const TOKEN = 'a-token-that-came-out-of-an-email-message-xy';

let store: MemoryAuthStore;
let mail: FixtureMailTransport;
let deps: AuthHandlerDeps;

beforeEach(() => {
  store = new MemoryAuthStore();
  store.seedAccount(KNOWN, 'acct_7');
  mail = new FixtureMailTransport();
  const limiter = new MemoryRateLimiter();
  deps = {
    keyring: KEYRING,
    request: {
      store,
      mail,
      limiter,
      mailFrom: 'The Pit <no-reply@thepit.show>',
      verifyUrl: `${ORIGIN}/auth/verify`,
    },
    verify: { store, limiter, keyring: KEYRING },
  };
});

function formPost(path: string, fields: Record<string, string>, ip = '203.0.113.9'): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-vercel-forwarded-for': ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function jsonPost(path: string, body: unknown, ip = '203.0.113.9'): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

/** Issue a token straight into the store, as `POST /auth/request` would. */
async function issueToken(email = KNOWN, at = new Date()): Promise<void> {
  await store.createToken({
    tokenHash: hashToken(TOKEN),
    email,
    expiresAt: magicTokenExpiry(at),
    createdAt: at,
  });
}

describe('GET /auth/verify renders a button and consumes nothing', () => {
  it('never touches the store', async () => {
    // THE Safe Links test. A mail scanner following the link in the message
    // reaches exactly this, and must leave with the token unspent.
    await issueToken();
    store.calls.length = 0;

    const response = handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([]);
    expect(store.storedToken(hashToken(TOKEN))?.usedAt).toBeNull();
  });

  it('leaves the token still redeemable afterwards', async () => {
    await issueToken();

    handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));
    handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));
    handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));

    // Three scanners later, the human presses the button and it works.
    const redeemed = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);
    expect(redeemed.status).toBe(303);
  });

  it('serves a form that POSTs the token back to the same URL', async () => {
    await issueToken();
    const body = await handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`)).text();

    expect(body).toContain('<form method="post" action="/auth/verify">');
    expect(body).toContain(`<input type="hidden" name="token" value="${TOKEN}">`);
    expect(body).toContain('<button type="submit"');
  });

  it('escapes the token into the value attribute', () => {
    // Reflected from a query string onto the page that is about to set a 90-day
    // cookie. An unescaped `"` here would be an XSS on precisely the wrong page.
    const hostile = '"><script>alert(1)</script>';
    const body = handleVerifyPage(
      new Request(`${ORIGIN}/auth/verify?token=${encodeURIComponent(hostile)}`),
    );

    return body.text().then((html) => {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });
  });

  it('is never cached and never indexed — the URL carries a bearer token', () => {
    const response = handleVerifyPage(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));

    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('renders the page even with no token, rather than judging one', () => {
    // Deciding here would mean this handler had an opinion about validity, which
    // is one small edit away from it checking one.
    const response = handleVerifyPage(new Request(`${ORIGIN}/auth/verify`));
    expect(response.status).toBe(200);
    expect(store.calls).toEqual([]);
  });
});

describe('POST /auth/verify', () => {
  it('signs the holder in and sets the session cookie', async () => {
    await issueToken();

    const response = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=7776000');
  });

  it('redirects with 303, so a refresh does not replay the POST', async () => {
    await issueToken();
    const response = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);
    // A 302 would have the browser re-POST on refresh, and the second POST lands
    // on "that link no longer works" seconds after a successful sign-in.
    expect(response.status).toBe(303);
  });

  it('refuses the same token twice and sets no second cookie', async () => {
    await issueToken();
    await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);

    const replay = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);
    expect(replay.status).toBe(400);
    expect(replay.headers.get('set-cookie')).toBeNull();
    expect(await replay.text()).toContain('That link no longer works');
  });

  it('refuses an expired token', async () => {
    await issueToken(KNOWN, new Date(Date.now() - 16 * 60 * 1000));

    const response = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('renders the same page for expired, spent and never-issued', async () => {
    await issueToken();
    await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);

    const spent = await (await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps)).text();
    const unknown = await (await handleVerifySubmit(formPost('/auth/verify', { token: 'never' }), deps)).text();

    expect(spent).toBe(unknown);
  });
});

describe('POST /auth/request says the same thing either way', () => {
  it('returns byte-identical bodies for a known and an unknown address', async () => {
    const known = await handleAuthRequest(formPost('/auth/request', { email: KNOWN }), deps);
    const unknown = await handleAuthRequest(formPost('/auth/request', { email: UNKNOWN }), deps);

    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(200);

    const knownBody = await known.text();
    const unknownBody = await unknown.text();
    expect(knownBody).toBe(unknownBody);
    expect(Buffer.from(knownBody).equals(Buffer.from(unknownBody))).toBe(true);
    expect(knownBody).toContain(CHECK_YOUR_INBOX);
  });

  it('returns identical headers too, so the difference is not in the envelope', async () => {
    const known = await handleAuthRequest(formPost('/auth/request', { email: KNOWN }), deps);
    const unknown = await handleAuthRequest(formPost('/auth/request', { email: UNKNOWN }), deps);

    expect([...known.headers].sort()).toEqual([...unknown.headers].sort());
  });

  it('is identical as JSON as well', async () => {
    const known = await handleAuthRequest(jsonPost('/auth/request', { email: KNOWN }), deps);
    const unknown = await handleAuthRequest(jsonPost('/auth/request', { email: UNKNOWN }), deps);

    expect(await known.text()).toBe(await unknown.text());
    expect(known.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('mails the known address and not the unknown one', async () => {
    await handleAuthRequest(formPost('/auth/request', { email: KNOWN }), deps);
    await handleAuthRequest(formPost('/auth/request', { email: UNKNOWN }), deps);

    expect(mail.sent.map((message) => message.to)).toEqual([KNOWN]);
  });

  it('never echoes the submitted address back into the page', async () => {
    const response = await handleAuthRequest(formPost('/auth/request', { email: KNOWN }), deps);
    expect(await response.text()).not.toContain(KNOWN);
  });

  it('sends a link that lands on the verify page', async () => {
    await handleAuthRequest(formPost('/auth/request', { email: KNOWN }), deps);

    const link = /https:\/\/\S+/.exec(mail.last?.text ?? '')?.[0] ?? '';
    expect(link.startsWith(`${ORIGIN}/auth/verify?token=`)).toBe(true);

    // And the round trip works: that URL renders the button, the button posts.
    const page = handleVerifyPage(new Request(link));
    expect(page.status).toBe(200);

    const token = new URL(link).searchParams.get('token') ?? '';
    const redeemed = await handleVerifySubmit(formPost('/auth/verify', { token }), deps);
    expect(redeemed.status).toBe(303);
  });

  it('answers 400 for a malformed address, which is not a fact about an account', async () => {
    const response = await handleAuthRequest(formPost('/auth/request', { email: 'not-an-address' }), deps);
    expect(response.status).toBe(400);
  });

  it('rate limits per email across different IPs', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await handleAuthRequest(formPost('/auth/request', { email: KNOWN }, `10.0.0.${i}`), deps);
      expect(ok.status).toBe(200);
    }

    const blocked = await handleAuthRequest(formPost('/auth/request', { email: KNOWN }, '10.0.0.9'), deps);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('900');
  });

  it('rate limits per IP across different addresses', async () => {
    for (let i = 0; i < 10; i += 1) {
      const ok = await handleAuthRequest(formPost('/auth/request', { email: `p${i}@example.com` }), deps);
      expect(ok.status).toBe(200);
    }

    const blocked = await handleAuthRequest(formPost('/auth/request', { email: 'p99@example.com' }), deps);
    expect(blocked.status).toBe(429);
  });

  it('reads the client address from the header a caller cannot forge', async () => {
    // `x-forwarded-for` is client-supplied; `x-vercel-forwarded-for` is not. An
    // attacker who could pick their own bucket would have no per-IP limit at all.
    for (let i = 0; i < 10; i += 1) {
      await handleAuthRequest(formPost('/auth/request', { email: `p${i}@example.com` }), deps);
    }

    const forged = new Request(`${ORIGIN}/auth/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-forwarded-for': '198.51.100.77',
      },
      body: new URLSearchParams({ email: 'p99@example.com' }).toString(),
    });

    expect((await handleAuthRequest(forged, deps)).status).toBe(429);
  });
});

describe('GET /auth/session', () => {
  it('reports the account behind a cookie it signed', () => {
    const session = newSessionPayload({ accountId: 'acct_7', email: KNOWN, now: new Date() });
    const value = signSessionCookie(session, KEYRING);
    const request = new Request(`${ORIGIN}/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` },
    });

    const response = handleSession(request, deps);
    expect(response.status).toBe(200);
    return response.json().then((body: unknown) => {
      expect(body).toMatchObject({ signedIn: true, accountId: 'acct_7', email: KNOWN });
    });
  });

  it('rejects a tampered cookie', async () => {
    const session = newSessionPayload({ accountId: 'acct_7', email: KNOWN, now: new Date() });
    const value = signSessionCookie(session, KEYRING);
    const [version, , signature] = value.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...session, accountId: 'acct_somebody_else' }),
      'utf8',
    ).toString('base64url');

    const request = new Request(`${ORIGIN}/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${version ?? ''}.${forged}.${signature ?? ''}` },
    });

    const response = handleSession(request, deps);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ signedIn: false });
  });

  it('answers a tampered cookie exactly as it answers no cookie', async () => {
    const noCookie = handleSession(new Request(`${ORIGIN}/auth/session`), deps);
    const tampered = handleSession(
      new Request(`${ORIGIN}/auth/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=v1.aaaa.bbbb` } }),
      deps,
    );

    expect(noCookie.status).toBe(tampered.status);
    expect(await noCookie.text()).toBe(await tampered.text());
  });

  it('rejects a cookie signed with somebody else’s secret', async () => {
    const session = newSessionPayload({ accountId: 'acct_7', email: KNOWN, now: new Date() });
    const foreign = signSessionCookie(session, ['attacker-secret-0123456789abcdef0123456789abcdef01234']);

    const response = handleSession(
      new Request(`${ORIGIN}/auth/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${foreign}` } }),
      deps,
    );
    expect(response.status).toBe(401);
  });

  it('accepts the cookie the verify POST actually issued', async () => {
    await issueToken();
    const verified = await handleVerifySubmit(formPost('/auth/verify', { token: TOKEN }), deps);
    const setCookie = verified.headers.get('set-cookie') ?? '';
    const value = /__Host-pit_session=([^;]+)/.exec(setCookie)?.[1] ?? '';

    const response = handleSession(
      new Request(`${ORIGIN}/auth/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` } }),
      deps,
    );
    expect(response.status).toBe(200);
  });
});

describe('the route files wire the verbs the way brief §2.1 requires', () => {
  it('serves GET /auth/verify with no store, no keyring and no mail configured', async () => {
    // The structural version of the Safe Links guarantee. `authDeps()` throws
    // when nothing is wired up, so a GET that reached a database — or that had
    // been collapsed into the POST — could not answer 200 here. It does, because
    // `handleVerifyPage` takes a Request and nothing else.
    resetAuthWiring();

    const response = await verifyRoute.GET(new Request(`${ORIGIN}/auth/verify?token=${TOKEN}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post" action="/auth/verify">');
  });

  it('cannot serve POST /auth/verify without one — that is the verb that spends the token', async () => {
    resetAuthWiring();

    await expect(async () => verifyRoute.POST(formPost('/auth/verify', { token: TOKEN }))).rejects.toBeInstanceOf(
      AuthNotWiredError,
    );
  });

  it('exports no verb on /auth/verify other than GET and POST', () => {
    // A HEAD or a PUT that fell through to the framework's default could serve
    // the GET body to a scanner, which is harmless, or something else, which is
    // not. Being explicit about the pair is the cheap half of that.
    const verbs = Object.keys(verifyRoute).filter((key) => key === key.toUpperCase());
    expect(verbs.sort()).toEqual(['GET', 'POST']);
  });

  it('serves the sign-in form with no wiring either', async () => {
    resetAuthWiring();

    const response = signInRoute.GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post" action="/auth/request">');
  });
});
