/**
 * The three doors, as a customer actually meets them: over HTTP, through the
 * real handlers, ending at the one gate that decides whether they are signed in.
 *
 * `packages/auth`'s `convergence.test.ts` proves the decisions agree. This
 * proves the WIRING agrees — that three handlers, three sets of headers and
 * three `Set-Cookie` values all produce a cookie `GET /auth/session` accepts for
 * the same account. That is the seam where a convergence bug actually lands:
 * the logic is right and one route signs a cookie with the wrong keyring, or
 * names the wrong account, and nobody notices because each route's own test
 * passes.
 */

import {
  FixtureMailTransport,
  FixtureOAuthProvider,
  MemoryAuthStore,
  MemoryRateLimiter,
  SESSION_COOKIE_NAME,
  startOAuthSignIn,
  verifiedEmail,
  type SessionKeyring,
} from '@the-pit/auth';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CapabilityHandlerDeps } from '@/lib/auth/capability-handlers';
import { handleCapabilityOpen } from '@/lib/auth/capability-handlers';
import type { HandoffHandlerDeps } from '@/lib/auth/handoff-handlers';
import { handleCheckoutSuccess } from '@/lib/auth/handoff-handlers';
import type { AuthHandlerDeps } from '@/lib/auth/handlers';
import { handleAuthRequest, handleSession, handleVerifySubmit } from '@/lib/auth/handlers';
import type { OAuthHandlerDeps } from '@/lib/auth/oauth-handlers';
import { handleGitHubCallback } from '@/lib/auth/oauth-handlers';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const KEYRING: SessionKeyring = [SECRET];
const ORIGIN = 'https://thepit.show';
const REDIRECT_URI = `${ORIGIN}/auth/github/callback`;
const PAYER = 'payer@example.com';
const IP = '203.0.113.9';

let store: MemoryAuthStore;
let mail: FixtureMailTransport;
let provider: FixtureOAuthProvider;
let auth: AuthHandlerDeps;
let capability: CapabilityHandlerDeps;
let oauth: OAuthHandlerDeps;
let handoff: HandoffHandlerDeps;
let accountId: string;

beforeEach(() => {
  store = new MemoryAuthStore();
  // The ONLY thing that creates an account: the Dodo webhook, from the email
  // Dodo verified. Everything below reaches this row; nothing creates another.
  accountId = store.seedAccount(PAYER, 'acct_7').accountId;
  store.seedOrder({ accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });

  mail = new FixtureMailTransport();
  provider = new FixtureOAuthProvider();
  provider.setEmails('4242', [verifiedEmail(PAYER, true)]);
  const limiter = new MemoryRateLimiter();

  auth = {
    keyring: KEYRING,
    request: { store, mail, limiter, mailFrom: 'The Pit <x@thepit.show>', verifyUrl: `${ORIGIN}/auth/verify` },
    verify: { store, limiter, keyring: KEYRING },
  };
  capability = { origin: ORIGIN, capability: { store, limiter, keyring: KEYRING } };
  oauth = { redirectUri: REDIRECT_URI, oauth: { provider, store, limiter, keyring: KEYRING } };
  handoff = { origin: ORIGIN, provider: 'dodo', handoff: { store, limiter } };
});

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = { 'x-vercel-forwarded-for': IP };
  if (cookie !== undefined) headers['cookie'] = cookie;
  return new Request(`${ORIGIN}${path}`, { headers });
}

function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-vercel-forwarded-for': IP },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The `Cookie:` header a browser would send back for a `Set-Cookie`. */
const asCookie = (setCookie: string): string => setCookie.split(';')[0] ?? '';

/**
 * Who does the session gate say this cookie is?
 *
 * `expiresAt` is dropped: it is a wall-clock timestamp, so comparing it would
 * make these assertions depend on when the suite ran. Identity is the subject.
 */
async function whoAmI(cookie: string): Promise<{ signedIn: boolean; accountId?: string; email?: string }> {
  const response = handleSession(get('/auth/session', cookie), { ...auth, secureCookies: true });
  const body = (await response.json()) as { signedIn: boolean; accountId?: string; email?: string };
  return { signedIn: body.signedIn, accountId: body.accountId, email: body.email };
}

// ---------------------------------------------------------------------------

describe('door 1: the magic link', () => {
  it('reaches the account', async () => {
    await handleAuthRequest(formPost('/auth/request', { email: PAYER }), auth);
    const token = new URL(/https:\/\/\S+/.exec(mail.last?.text ?? '')?.[0] ?? '').searchParams.get('token') ?? '';

    const response = await handleVerifySubmit(formPost('/auth/verify', { token }), auth);
    expect(response.status).toBe(303);
    expect(await whoAmI(asCookie(response.headers.get('set-cookie') ?? ''))).toEqual({
      signedIn: true,
      accountId: 'acct_7',
      email: PAYER,
    });
  });
});

describe('door 2: the capability URL', () => {
  it('reaches the same account, with nothing delivered', async () => {
    const slug = store.seededSlug(accountId) ?? '';
    const response = await handleCapabilityOpen(get(`/a/${slug}`), slug, capability);

    expect(response.status).toBe(303);
    expect(await whoAmI(asCookie(response.headers.get('set-cookie') ?? ''))).toEqual({
      signedIn: true,
      accountId: 'acct_7',
      email: PAYER,
    });
    // Not one message was sent for this door to work.
    expect(mail.sent).toEqual([]);
  });
});

describe('door 3: GitHub', () => {
  it('reaches the same account', async () => {
    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: new Date() }, oauth.oauth);
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, asCookie(started.setCookie)),
      oauth,
    );

    expect(response.status).toBe(303);
    const session = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? '';
    expect(await whoAmI(asCookie(session))).toEqual({ signedIn: true, accountId: 'acct_7', email: PAYER });
  });
});

describe('all three, one account', () => {
  it('the same gate says the same thing for all three cookies', async () => {
    // The wiring assertion. Three handlers, three cookies, one identity.
    await handleAuthRequest(formPost('/auth/request', { email: PAYER }), auth);
    const token = new URL(/https:\/\/\S+/.exec(mail.last?.text ?? '')?.[0] ?? '').searchParams.get('token') ?? '';
    const viaLink = await handleVerifySubmit(formPost('/auth/verify', { token }), auth);

    const slug = store.seededSlug(accountId) ?? '';
    const viaSlug = await handleCapabilityOpen(get(`/a/${slug}`), slug, capability);

    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: new Date() }, oauth.oauth);
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const viaGitHub = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, asCookie(started.setCookie)),
      oauth,
    );

    const cookies = [
      viaLink.headers.get('set-cookie') ?? '',
      viaSlug.headers.get('set-cookie') ?? '',
      viaGitHub.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? '',
    ];

    const identities = await Promise.all(cookies.map((cookie) => whoAmI(asCookie(cookie))));
    expect(identities).toEqual([
      { signedIn: true, accountId: 'acct_7', email: PAYER },
      { signedIn: true, accountId: 'acct_7', email: PAYER },
      { signedIn: true, accountId: 'acct_7', email: PAYER },
    ]);

    // And there is still exactly one account behind all three.
    expect(store.accountCount).toBe(1);
  });

  it('all three redirect to the same place, and none of them carries a credential', async () => {
    const slug = store.seededSlug(accountId) ?? '';
    const viaSlug = await handleCapabilityOpen(get(`/a/${slug}`), slug, capability);

    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: new Date() }, oauth.oauth);
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const viaGitHub = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, asCookie(started.setCookie)),
      oauth,
    );

    for (const response of [viaSlug, viaGitHub]) {
      expect(response.headers.get('location')).toBe('/account');
      expect(response.headers.get('location')).not.toContain(slug);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});

describe('the guest-checkout story end to end', () => {
  it('pay, be shown the URL, follow it, and be signed in — with no email and no OAuth', async () => {
    // The path a mobile buyer takes, and the reason the capability URL exists.
    const success = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_abc123'), handoff);
    const body = await success.text();

    const url = /https:\/\/thepit\.show\/a\/([A-Za-z0-9_-]{43})/.exec(body);
    expect(url).not.toBeNull();
    const slug = url?.[1] ?? '';

    const opened = await handleCapabilityOpen(get(`/a/${slug}`), slug, capability);
    expect(await whoAmI(asCookie(opened.headers.get('set-cookie') ?? ''))).toEqual({
      signedIn: true,
      accountId: 'acct_7',
      email: PAYER,
    });

    // Nothing was delivered, and no provider was contacted.
    expect(mail.sent).toEqual([]);
    expect(provider.exchanges).toEqual([]);
  });

  it('then connect GitHub afterwards and still be the same account', async () => {
    // Retroactive claiming: their GitHub carries an address that bought nothing.
    provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);

    const slug = store.seededSlug(accountId) ?? '';
    const opened = await handleCapabilityOpen(get(`/a/${slug}`), slug, capability);
    const session = asCookie(opened.headers.get('set-cookie') ?? '');

    const started = startOAuthSignIn(
      { redirectUri: REDIRECT_URI, now: new Date(), cookieHeader: session },
      oauth.oauth,
    );
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const linked = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, `${session}; ${asCookie(started.setCookie)}`),
      oauth,
    );

    expect(linked.status).toBe(303);
    expect(store.accountCount).toBe(1);

    // And on a laptop with no cookie at all, GitHub now gets them back in.
    const fresh = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: new Date() }, oauth.oauth);
    const freshState = new URL(fresh.authorizationUrl).searchParams.get('state') ?? '';
    const laptop = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${freshState}`, asCookie(fresh.setCookie)),
      oauth,
    );
    const laptopSession = laptop.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? '';
    expect(await whoAmI(asCookie(laptopSession))).toEqual({
      signedIn: true,
      accountId: 'acct_7',
      email: PAYER,
    });
  });
});

describe('none of the three gates a verdict', () => {
  it('the verdict route takes no session and no store from any of this', async () => {
    // `brief` Part 6: verdict URLs are public, shareable, and work logged out.
    // Auth gates exactly three things — balance, history, re-pitch — and this
    // asserts the fourth is not among them, by construction: nothing in the
    // verdict route's module imports anything from `@/lib/auth`.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/app/v/[slug]/route.ts', import.meta.url), 'utf8'),
    );
    // Not a keyword search over the whole file — the module's own comment says
    // "there is no session read on this path", and a test that failed on the
    // documentation would be a test nobody could keep passing. What is asserted
    // is that it IMPORTS nothing from the auth layer and CALLS nothing that
    // could read a credential.
    expect(source).not.toContain('@/lib/auth');
    expect(source).not.toContain('@the-pit/auth');
    for (const call of ['readSession(', 'readCookie(', "headers.get('cookie')"]) {
      expect(`${call}: ${source.includes(call)}`).toBe(`${call}: false`);
    }
  });
});
