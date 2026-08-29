/**
 * The capability routes, exercised as HTTP.
 *
 * The tests that matter here are the ones `packages/auth` cannot see, because
 * they are about the RESPONSE rather than the decision: which headers went out,
 * what ended up in the `Location`, and what — if anything — got written to a log.
 *
 * A capability URL is a bearer credential that lives in a URL, so every way a
 * URL escapes is a way this credential escapes. There are four, and there is a
 * test for each:
 *
 * 1. the `Referer` header, closed by `Referrer-Policy: no-referrer` and a `meta`
 *    tag on every page;
 * 2. the address bar and browser history, closed by redirecting to `/account`
 *    with the slug removed;
 * 3. caches, closed by `no-store`;
 * 4. our own logs, closed by not writing the slug to any of them.
 */

import {
  MemoryAuthStore,
  MemoryRateLimiter,
  newSessionPayload,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  mintCapabilitySlug,
  type SessionKeyring,
} from '@the-pit/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as capabilityRoute from '@/app/a/[slug]/route';
import * as rotateRoute from '@/app/auth/capability/rotate/route';
import type { CapabilityHandlerDeps } from '@/lib/auth/capability-handlers';
import { handleCapabilityOpen, handleCapabilityRotate } from '@/lib/auth/capability-handlers';
import { registerAuthStore, registerIdentityStore, resetAuthWiring } from '@/lib/auth/config';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const KEYRING: SessionKeyring = [SECRET];
const ORIGIN = 'https://thepit.show';
const PAYER = 'payer@example.com';

let store: MemoryAuthStore;
let deps: CapabilityHandlerDeps;
let accountId: string;
let slug: string;

beforeEach(() => {
  store = new MemoryAuthStore();
  const account = store.seedAccount(PAYER, 'acct_7');
  accountId = account.accountId;
  slug = store.seededSlug(accountId) ?? '';
  deps = {
    origin: ORIGIN,
    capability: { store, limiter: new MemoryRateLimiter(), keyring: KEYRING },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAuthWiring();
});

function get(path: string, ip = '203.0.113.9', cookie?: string): Request {
  const headers: Record<string, string> = { 'x-vercel-forwarded-for': ip };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return new Request(`${ORIGIN}${path}`, { headers });
}

function sessionCookie(): string {
  const signed = signSessionCookie(newSessionPayload({ accountId, email: PAYER, now: new Date() }), KEYRING);
  return `${SESSION_COOKIE_NAME}=${signed}`;
}

// ---------------------------------------------------------------------------

describe('GET /a/<slug>', () => {
  it('signs the customer in with no email, no password and no session', async () => {
    const response = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);

    expect(response.status).toBe(303);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toContain('HttpOnly');
  });

  it('does not leak the slug through the referer header', async () => {
    // THE test. A page that loads any third-party asset — a font, an image, an
    // analytics beacon — sends its own URL in a `Referer`. Without this header,
    // the account URL is handed to every one of them.
    const response = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sends no-referrer on the failure responses too', async () => {
    // A rejected slug is still a slug someone typed. Leaking a wrong guess to a
    // third party is only marginally better than leaking a right one.
    const unknown = await handleCapabilityOpen(get('/a/x'), mintCapabilitySlug(), deps);
    const malformed = await handleCapabilityOpen(get('/a/nope'), 'nope', deps);
    expect(unknown.headers.get('referrer-policy')).toBe('no-referrer');
    expect(malformed.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('gets the slug out of the address bar — the redirect carries no credential', async () => {
    // If this rendered a 200, the slug would sit in the address bar, in the
    // browser history of a shared machine, and in the `Referer` of everything
    // the account page ever loads.
    const response = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    const location = response.headers.get('location') ?? '';
    expect(location).toBe('/account');
    expect(location).not.toContain(slug);
  });

  it('is never cached — a shared cache holding this is the next person`s session', async () => {
    const response = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('writes the slug to no log line', async () => {
    // The fourth escape route. This is a weak defence against the platform's own
    // access log, which records the request line whatever we do — which is
    // exactly why rotation exists — but it does close the ones we control.
    const captured: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(...args);
      });
    }

    await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    await handleCapabilityOpen(get('/a/x'), mintCapabilitySlug(), deps);

    const written = captured.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n');
    expect(written).not.toContain(slug);
  });

  it('renders one page for an unknown slug and a malformed one', async () => {
    const unknown = await handleCapabilityOpen(get('/a/x'), mintCapabilitySlug(), deps);
    const malformed = await handleCapabilityOpen(get('/a/nope'), '../../etc/passwd', deps);

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it('never says which of the two it was', async () => {
    const body = await (await handleCapabilityOpen(get('/a/x'), mintCapabilitySlug(), deps)).text();
    expect(body.toLowerCase()).not.toContain('malformed');
    expect(body.toLowerCase()).not.toContain('unknown');
    // And the page offers the other doors rather than dead-ending.
    expect(body).toContain('/auth/sign-in');
  });

  it('marks every page noindex in the document as well as the header', async () => {
    const body = await (await handleCapabilityOpen(get('/a/x'), mintCapabilitySlug(), deps)).text();
    expect(body).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  it('answers 429 with a Retry-After once the per-IP budget is gone', async () => {
    for (let i = 0; i < 30; i += 1) {
      await handleCapabilityOpen(get('/a/x', '192.0.2.7'), mintCapabilitySlug(), deps);
    }
    const blocked = await handleCapabilityOpen(get('/a/x', '192.0.2.7'), mintCapabilitySlug(), deps);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('POST /auth/capability/rotate', () => {
  it('hands back a new URL and stops the old one working', async () => {
    const before = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    expect(before.status).toBe(303);

    const rotated = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, { method: 'POST', headers: { cookie: sessionCookie() } }),
      deps,
    );
    expect(rotated.status).toBe(200);
    const body = await rotated.text();

    // The new slug is in the page, and it is not the old one.
    const fresh = /\/a\/([A-Za-z0-9_-]{43})/.exec(body)?.[1] ?? '';
    expect(fresh).not.toBe('');
    expect(fresh).not.toBe(slug);

    const replayed = await handleCapabilityOpen(get(`/a/${slug}`), slug, deps);
    expect(replayed.status).toBe(404);

    const withNew = await handleCapabilityOpen(get(`/a/${fresh}`), fresh, deps);
    expect(withNew.status).toBe(303);
  });

  it('refuses without a session — holding the old slug is not authorization', async () => {
    // After a real leak the leaker holds the slug too. If possession authorized
    // a rotation they could lock the customer out of their own account.
    const response = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, { method: 'POST' }),
      deps,
    );
    expect(response.status).toBe(401);
  });

  it('refuses a cookie it did not sign', async () => {
    const forged = signSessionCookie(newSessionPayload({ accountId, email: PAYER, now: new Date() }), [
      'another-secret-long-enough-to-pass-0123456789abcdef0123456789',
    ]);
    const response = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${forged}` },
      }),
      deps,
    );
    expect(response.status).toBe(401);
  });

  it('sends no-referrer and no-store on the page that displays the new URL', async () => {
    // This page has a live credential in its body.
    const response = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, { method: 'POST', headers: { cookie: sessionCookie() } }),
      deps,
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('is honest that existing sessions survive a rotation', async () => {
    // A stateless 90-day cookie cannot be revoked individually. Saying so on the
    // page is the difference between a control and the appearance of one.
    const response = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, { method: 'POST', headers: { cookie: sessionCookie() } }),
      deps,
    );
    expect((await response.text()).toLowerCase()).toContain('stays signed in');
  });
});

describe('the routes themselves', () => {
  it('exposes GET on /a/<slug> and no POST', () => {
    // A bookmark is a GET. There is deliberately nothing here that a POST could
    // reach, so no mutation can be hung off the URL customers hand around.
    expect(typeof capabilityRoute.GET).toBe('function');
    expect((capabilityRoute as Record<string, unknown>)['POST']).toBeUndefined();
  });

  it('exposes POST on rotate and no GET', () => {
    // A GET that replaced a credential could be fired by any <img> tag, and by
    // every prefetcher and mail scanner that follows a link.
    expect(typeof rotateRoute.POST).toBe('function');
    expect((rotateRoute as Record<string, unknown>)['GET']).toBeUndefined();
  });

  it('runs on the node runtime, where node:crypto exists', () => {
    // The slug generator is `node:crypto`'s `randomBytes`. On the edge runtime
    // it would not resolve, and the failure would be at request time.
    expect(capabilityRoute.runtime).toBe('nodejs');
    expect(rotateRoute.runtime).toBe('nodejs');
  });

  it('resolves its dependencies through the registered store', async () => {
    // The seam `registerIdentityStore` exists for: no environment variable, no
    // database, and the same object serving the magic link.
    registerAuthStore(store);
    registerIdentityStore(store);
    process.env['SESSION_SECRET'] = SECRET;
    process.env['APP_ORIGIN'] = ORIGIN;

    const response = await capabilityRoute.GET(get(`/a/${slug}`), { params: Promise.resolve({ slug }) });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account');
  });
});
