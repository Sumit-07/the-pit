/**
 * The GitHub routes and the success-page handover, exercised as HTTP.
 *
 * Two things are being checked that `packages/auth` cannot see:
 *
 * 1. **What the response says.** A GitHub identity with no purchase gets a 404
 *    and a page that names the addresses it checked — not a 500, not a 401, and
 *    above all not an account.
 * 2. **That GitHub is nowhere near the buying path.** `brief §2.1`: no login at
 *    submission. The post-payment handover has to work with no session, no
 *    cookie and no OAuth anywhere in it, on any device.
 */

import {
  FixtureOAuthProvider,
  HANDOFF_WINDOW_MS,
  MemoryAuthStore,
  MemoryRateLimiter,
  newSessionPayload,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  startOAuthSignIn,
  unverifiedEmail,
  verifiedEmail,
  type SessionKeyring,
} from '@the-pit/auth';
import { beforeEach, describe, expect, it } from 'vitest';

import * as callbackRoute from '@/app/auth/github/callback/route';
import * as startRoute from '@/app/auth/github/start/route';
import { handleCheckoutSuccess, type HandoffHandlerDeps } from '@/lib/auth/handoff-handlers';
import { handleGitHubCallback, handleGitHubStart, type OAuthHandlerDeps } from '@/lib/auth/oauth-handlers';
import { resetAuthWiring } from '@/lib/auth/config';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const KEYRING: SessionKeyring = [SECRET];
const ORIGIN = 'https://thepit.show';
const REDIRECT_URI = `${ORIGIN}/auth/github/callback`;
const PAYER = 'payer@example.com';

let store: MemoryAuthStore;
let provider: FixtureOAuthProvider;
let oauth: OAuthHandlerDeps;
let handoff: HandoffHandlerDeps;

beforeEach(() => {
  resetAuthWiring();
  store = new MemoryAuthStore();
  provider = new FixtureOAuthProvider();
  const limiter = new MemoryRateLimiter();
  oauth = {
    redirectUri: REDIRECT_URI,
    oauth: { provider, store, limiter, keyring: KEYRING },
  };
  handoff = {
    origin: ORIGIN,
    provider: 'dodo',
    handoff: { store, limiter },
  };
});

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = { 'x-vercel-forwarded-for': '203.0.113.9' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return new Request(`${ORIGIN}${path}`, { headers });
}

/** Start a flow and return the query and cookie a callback would receive. */
function begin(sessionCookie?: string): { state: string; cookieHeader: string } {
  const started = startOAuthSignIn(
    { redirectUri: REDIRECT_URI, now: new Date(), cookieHeader: sessionCookie ?? null },
    oauth.oauth,
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  const stateCookie = started.setCookie.split(';')[0] ?? '';
  return {
    state,
    cookieHeader: sessionCookie === undefined ? stateCookie : `${sessionCookie}; ${stateCookie}`,
  };
}

function sessionCookieFor(accountId: string, email: string): string {
  return `${SESSION_COOKIE_NAME}=${signSessionCookie(newSessionPayload({ accountId, email, now: new Date() }), KEYRING)}`;
}

// ---------------------------------------------------------------------------

describe('GET /auth/github/start', () => {
  it('redirects to the provider and sets a state cookie', () => {
    const response = handleGitHubStart(get('/auth/github/start'), oauth);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('state=');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('does not leak the callback URL through a referer', () => {
    const response = handleGitHubStart(get('/auth/github/start'), oauth);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('says so plainly when GitHub is not configured, rather than throwing a 500', () => {
    // The state of this repository: no client id, no client secret.
    delete process.env['GITHUB_CLIENT_ID'];
    delete process.env['GITHUB_CLIENT_SECRET'];
    process.env['SESSION_SECRET'] = SECRET;

    const response = startRoute.GET(get('/auth/github/start'));
    expect(response.status).toBe(503);
    return response.text().then((body) => {
      expect(body).toContain('not available');
      // The other two doors still work, and the page points at one.
      expect(body).toContain('/auth/sign-in');
    });
  });
});

describe('GET /auth/github/callback', () => {
  it('signs into the account a verified address bought, and creates no second one', async () => {
    const account = store.seedAccount(PAYER);
    provider.setEmails('4242', [verifiedEmail(PAYER, true)]);
    const { state, cookieHeader } = begin();

    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader),
      oauth,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account');
    expect(store.accountCount).toBe(1);

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    // And the state cookie is cleared in the same response.
    expect(cookies.some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect(account.accountId).toBe('acct_1');
  });

  it('does NOT match an unverified address, and creates nothing', async () => {
    // The attack, at the HTTP layer: the attacker typed the customer's address
    // into their own GitHub settings and never confirmed it.
    store.seedAccount(PAYER);
    provider.setEmails('999', [unverifiedEmail(PAYER, true)]);
    const { state, cookieHeader } = begin();

    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader),
      oauth,
    );

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
    expect(store.identityCount).toBe(0);

    const body = await response.text();
    expect(body).toContain('No purchase found');
    // The page explains the one thing that is otherwise inexplicable.
    expect(body).toContain('has not confirmed you own them');
    expect(body).toContain(PAYER);
  });

  it('answers 404 for a stranger — not 500, not 401, and not an account', async () => {
    provider.setEmails('4242', [verifiedEmail('stranger@example.com', true)]);
    const { state, cookieHeader } = begin();

    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader),
      oauth,
    );

    expect(response.status).toBe(404);
    expect(store.accountCount).toBe(0);
    const body = await response.text();
    expect(body).toContain('accounts are made by a purchase');
    expect(body).toContain('stranger@example.com');
  });

  it('offers the capability URL from the receipt when there is no purchase', async () => {
    // What the brief asks the page to do instead of erroring.
    provider.setEmails('4242', [verifiedEmail('stranger@example.com', true)]);
    const { state, cookieHeader } = begin();
    const body = await (
      await handleGitHubCallback(get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader), oauth)
    ).text();

    expect(body).toContain('the receipt email has your account link in it');
  });

  it('renders one page for every refusal', async () => {
    const noState = await handleGitHubCallback(get('/auth/github/callback?code=c&state=s'), oauth);
    const { cookieHeader } = begin();
    const wrongState = await handleGitHubCallback(
      get('/auth/github/callback?code=c&state=not-the-one', cookieHeader),
      oauth,
    );

    expect(noState.status).toBe(400);
    expect(wrongState.status).toBe(400);
    expect(await noState.text()).toBe(await wrongState.text());
  });

  it('never names which check failed', async () => {
    const body = await (await handleGitHubCallback(get('/auth/github/callback?code=c&state=s'), oauth)).text();
    for (const leak of ['state', 'csrf', 'expired', 'mismatch', 'signature']) {
      expect(`${leak}: ${body.toLowerCase().includes(leak)}`).toBe(`${leak}: false`);
    }
  });

  it('clears the state cookie even when it refuses', async () => {
    const { cookieHeader } = begin();
    const response = await handleGitHubCallback(
      get('/auth/github/callback?code=c&state=wrong', cookieHeader),
      oauth,
    );
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('does not leak the authorization code through a referer', async () => {
    // The callback URL carries `?code=`. A page leaking its own URL would hand a
    // third party a live authorization code.
    const { state, cookieHeader } = begin();
    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader),
      oauth,
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('links to the session`s account when one is already signed in', async () => {
    // Retroactive claiming, over HTTP. Their GitHub address bought nothing.
    const account = store.seedAccount('work@example.com');
    provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);
    const session = sessionCookieFor(account.accountId, account.email);
    const { state, cookieHeader } = begin(session);

    const response = await handleGitHubCallback(
      get(`/auth/github/callback?code=good-code&state=${state}`, cookieHeader),
      oauth,
    );

    expect(response.status).toBe(303);
    expect(store.accountCount).toBe(1);
    expect(await store.identitiesFor(account.accountId)).toHaveLength(1);
  });

  it('runs on the node runtime', () => {
    expect(startRoute.runtime).toBe('nodejs');
    expect(callbackRoute.runtime).toBe('nodejs');
  });
});

describe('GET /checkout/success — the handover that needs no login', () => {
  it('shows the capability URL with no session and no GitHub anywhere in it', async () => {
    // `brief §2.1`: no login at submission. This is the whole guest-checkout
    // story, and it has to work on a phone with nothing installed.
    const account = store.seedAccount(PAYER);
    store.seedOrder({ accountId: account.accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });

    const response = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_abc123'), handoff);

    expect(response.status).toBe(200);
    const body = await response.text();
    const slug = store.seededSlug(account.accountId) ?? '';
    expect(body).toContain(`${ORIGIN}/a/${slug}`);
    expect(body).toContain('Bookmark this');
    // No cookie was set: following the URL is what signs them in.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not leak its own URL — the page has a live credential in its body', async () => {
    const account = store.seedAccount(PAYER);
    store.seedOrder({ accountId: account.accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });
    const response = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_abc123'), handoff);

    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('never implies it knows the balance', async () => {
    // `brief §2.2`: attempts are granted on the signed webhook, which may not
    // have landed. `resolveSuccessRedirect` is explicit that the redirect must
    // not read a balance, and this page must not either.
    const account = store.seedAccount(PAYER);
    store.seedOrder({ accountId: account.accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });
    const body = await (await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_abc123'), handoff)).text();

    for (const leak of ['attempts remaining', 'you have 1', 'balance']) {
      expect(`${leak}: ${body.toLowerCase().includes(leak)}`).toBe(`${leak}: false`);
    }
  });

  it('says the verdict page is public and does not need this link', async () => {
    // `brief` Part 6. A customer who thinks the account link is needed to share
    // their verdict will not share it.
    const account = store.seedAccount(PAYER);
    store.seedOrder({ accountId: account.accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });
    const body = await (await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_abc123'), handoff)).text();
    expect(body).toContain('public and shareable');
  });

  it('stops showing the URL once the window has closed', async () => {
    const account = store.seedAccount(PAYER);
    store.seedOrder({
      accountId: account.accountId,
      providerPaymentId: 'pay_old',
      createdAt: new Date(Date.now() - HANDOFF_WINDOW_MS - 1000),
    });

    const response = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_old'), handoff);
    const body = await response.text();

    // Still a 200 — the payment worked and the run is starting. Only the bearer
    // URL has stopped being shown.
    expect(response.status).toBe(200);
    expect(body).not.toContain(store.seededSlug(account.accountId) ?? 'unreachable');
    expect(body).toContain('Payment received');
    expect(body).toContain('/auth/sign-in');
  });

  it('shows the same page for an unknown payment id as for an expired one', async () => {
    const account = store.seedAccount(PAYER);
    store.seedOrder({
      accountId: account.accountId,
      providerPaymentId: 'pay_old',
      createdAt: new Date(Date.now() - HANDOFF_WINDOW_MS - 1000),
    });

    const expired = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_old'), handoff);
    const unknown = await handleCheckoutSuccess(get('/checkout/success?payment_id=pay_never_existed'), handoff);
    expect(await expired.text()).toBe(await unknown.text());
  });

  it('shows nothing at all with no payment id', async () => {
    const account = store.seedAccount(PAYER);
    store.seedOrder({ accountId: account.accountId, providerPaymentId: 'pay_abc123', createdAt: new Date() });
    const body = await (await handleCheckoutSuccess(get('/checkout/success'), handoff)).text();
    expect(body).not.toContain(store.seededSlug(account.accountId) ?? 'unreachable');
  });
});
