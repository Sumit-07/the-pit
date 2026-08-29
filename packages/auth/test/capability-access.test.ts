/**
 * Opening a capability URL, and the one revocation it has.
 *
 * The rotation tests are the important ones. A capability URL cannot be
 * un-shared, has no expiry that would help, and cannot tell the customer's
 * browser from someone reading over their shoulder — so if rotation does not
 * genuinely invalidate the old slug, the design has no answer at all for "I
 * think this leaked". Every assertion below is written so that an implementation
 * which ADDED a slug instead of REPLACING one would fail it.
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryAuthStore,
  MemoryRateLimiter,
  UnlimitedRateLimiter,
  AUTH_RATE_LIMITS,
  isCapabilitySlug,
  mintCapabilitySlug,
  openCapabilityUrl,
  readSession,
  rotateCapability,
  serializeSessionCookie,
  signSessionCookie,
  newSessionPayload,
  SESSION_COOKIE_NAME,
  type CapabilityDeps,
} from '../src/index.js';
import { TEST_SECRET } from './helpers/fixtures.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const KEYRING = [TEST_SECRET] as const;

function setup(): { store: MemoryAuthStore; deps: CapabilityDeps } {
  const store = new MemoryAuthStore();
  return {
    store,
    deps: { store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING },
  };
}

/** The cookie header a signed-in browser would send. */
function cookieFor(accountId: string, email: string, now: Date = NOW): string {
  const signed = signSessionCookie(newSessionPayload({ accountId, email, now }), KEYRING);
  return `${SESSION_COOKIE_NAME}=${signed}`;
}

describe('opening a capability URL', () => {
  it('signs in the account the slug belongs to', async () => {
    const { store, deps } = setup();
    const account = store.seedAccount('payer@example.com');
    const slug = store.seededSlug(account.accountId) ?? '';

    const result = await openCapabilityUrl({ slug, ip: '198.51.100.7', now: NOW }, deps);

    expect(result.outcome).toBe('signed_in');
    if (result.outcome !== 'signed_in') return;
    expect(result.account).toEqual({ accountId: account.accountId, email: 'payer@example.com' });
    // The cookie is the real thing, verifiable by the same keyring.
    const verified = readSession({ cookieHeader: result.setCookie, keyring: KEYRING, now: NOW });
    expect(verified.valid && verified.session.accountId).toBe(account.accountId);
  });

  it('needs no session to work — that is the entire point', async () => {
    // The customer this path exists for has nothing: no cookie, no delivered
    // email, no password. `openCapabilityUrl` takes no cookie header at all.
    const { store, deps } = setup();
    const account = store.seedAccount('nobody-home@example.com');
    const result = await openCapabilityUrl(
      { slug: store.seededSlug(account.accountId) ?? '', ip: '203.0.113.9', now: NOW },
      deps,
    );
    expect(result.outcome).toBe('signed_in');
  });

  it('refuses an unknown slug and a malformed one identically to the caller', async () => {
    const { deps } = setup();
    const unknown = await openCapabilityUrl({ slug: mintCapabilitySlug(), ip: '198.51.100.7', now: NOW }, deps);
    const malformed = await openCapabilityUrl({ slug: 'nope', ip: '198.51.100.7', now: NOW }, deps);

    expect(unknown.outcome).toBe('rejected');
    expect(malformed.outcome).toBe('rejected');
    // The REASON differs for the log, and the route renders one page for both.
    expect(unknown.outcome === 'rejected' && unknown.reason).toBe('unknown_slug');
    expect(malformed.outcome === 'rejected' && malformed.reason).toBe('malformed_slug');
  });

  it('does not spend a rate-limit slot on a path that could not be a slug', async () => {
    // A crawler hitting /a/favicon.ico must not exhaust the budget of a real
    // customer sharing an office NAT address.
    const store = new MemoryAuthStore();
    const limiter = new MemoryRateLimiter();
    const deps: CapabilityDeps = { store, limiter, keyring: KEYRING };

    await openCapabilityUrl({ slug: 'favicon.ico', ip: '198.51.100.7', now: NOW }, deps);
    expect(limiter.countFor('auth:capability:ip|198.51.100.7')).toBe(0);

    // A well-formed miss does cost one — guessing has to be finite.
    await openCapabilityUrl({ slug: mintCapabilitySlug(), ip: '198.51.100.7', now: NOW }, deps);
    expect(limiter.countFor('auth:capability:ip|198.51.100.7')).toBe(1);
  });

  it('never reaches the store for a malformed slug', async () => {
    const { store, deps } = setup();
    await openCapabilityUrl({ slug: '../../../etc/passwd', ip: '198.51.100.7', now: NOW }, deps);
    expect(store.calls).toEqual([]);
  });

  it('stops a guessing loop once the per-IP budget is gone', async () => {
    const store = new MemoryAuthStore();
    const deps: CapabilityDeps = { store, limiter: new MemoryRateLimiter(), keyring: KEYRING };
    const limit = AUTH_RATE_LIMITS.capabilityPerIp.limit;

    for (let i = 0; i < limit; i += 1) {
      const attempt = await openCapabilityUrl({ slug: mintCapabilitySlug(), ip: '192.0.2.5', now: NOW }, deps);
      expect(attempt.outcome).toBe('rejected');
    }
    const blocked = await openCapabilityUrl({ slug: mintCapabilitySlug(), ip: '192.0.2.5', now: NOW }, deps);
    expect(blocked.outcome).toBe('rate_limited');

    // A different address is unaffected — the bucket is per IP, not global.
    const elsewhere = await openCapabilityUrl({ slug: mintCapabilitySlug(), ip: '192.0.2.6', now: NOW }, deps);
    expect(elsewhere.outcome).toBe('rejected');
  });
});

describe('rotation is a revocation', () => {
  it('makes the old slug stop resolving, and the new one start', async () => {
    // THE test for the only control this credential has.
    const { store, deps } = setup();
    const account = store.seedAccount('leaked@example.com');
    const old = store.seededSlug(account.accountId) ?? '';

    // Before: the old slug works.
    expect((await openCapabilityUrl({ slug: old, ip: '198.51.100.7', now: NOW }, deps)).outcome).toBe('signed_in');

    const rotated = await rotateCapability(
      { cookieHeader: cookieFor(account.accountId, account.email), origin: 'https://thepit.show', now: NOW },
      deps,
    );
    expect(rotated.outcome).toBe('rotated');
    if (rotated.outcome !== 'rotated') return;
    expect(rotated.slug).not.toBe(old);
    expect(isCapabilitySlug(rotated.slug)).toBe(true);
    expect(rotated.url).toBe(`https://thepit.show/a/${rotated.slug}`);

    // After: the old one is gone. An implementation that ADDED a slug rather
    // than replacing one would still sign in here, and this is the line that
    // catches it.
    const replayed = await openCapabilityUrl({ slug: old, ip: '198.51.100.7', now: NOW }, deps);
    expect(replayed.outcome).toBe('rejected');
    expect(replayed.outcome === 'rejected' && replayed.reason).toBe('unknown_slug');

    // And the new one reaches the same account — rotation moves the door, not
    // the room behind it.
    const fresh = await openCapabilityUrl({ slug: rotated.slug, ip: '198.51.100.7', now: NOW }, deps);
    expect(fresh.outcome === 'signed_in' && fresh.account.accountId).toBe(account.accountId);
  });

  it('leaves exactly one live slug after several rotations', async () => {
    const { store, deps } = setup();
    const account = store.seedAccount('churn@example.com');
    const cookie = cookieFor(account.accountId, account.email);

    const seen = [store.seededSlug(account.accountId) ?? ''];
    for (let i = 0; i < 4; i += 1) {
      const rotated = await rotateCapability({ cookieHeader: cookie, origin: 'https://thepit.show', now: NOW }, deps);
      expect(rotated.outcome).toBe('rotated');
      if (rotated.outcome === 'rotated') seen.push(rotated.slug);
    }

    expect(new Set(seen).size).toBe(5);
    // Every slug but the last resolves to nothing.
    for (const stale of seen.slice(0, -1)) {
      expect((await openCapabilityUrl({ slug: stale, ip: '198.51.100.7', now: NOW }, deps)).outcome).toBe('rejected');
    }
    const live = seen.at(-1) ?? '';
    expect((await openCapabilityUrl({ slug: live, ip: '198.51.100.7', now: NOW }, deps)).outcome).toBe('signed_in');
  });

  it('is gated on the session, not on holding the slug being replaced', async () => {
    // If holding the slug were enough, the person who leaked it could rotate
    // too and lock the customer out of their own account with one request.
    const { store, deps } = setup();
    store.seedAccount('gated@example.com');

    const anonymous = await rotateCapability(
      { cookieHeader: null, origin: 'https://thepit.show', now: NOW },
      deps,
    );
    expect(anonymous.outcome).toBe('rejected');
    expect(anonymous.outcome === 'rejected' && anonymous.reason).toBe('no_session');
  });

  it('refuses a cookie it did not sign', async () => {
    const { store, deps } = setup();
    const account = store.seedAccount('forged@example.com');
    // Signed with a different secret — the MAC is the whole control.
    const forged = signSessionCookie(
      newSessionPayload({ accountId: account.accountId, email: account.email, now: NOW }),
      ['a-different-secret-that-is-also-long-enough-0123456789abcdef'],
    );

    const result = await rotateCapability(
      {
        cookieHeader: `${SESSION_COOKIE_NAME}=${forged}`,
        origin: 'https://thepit.show',
        now: NOW,
      },
      deps,
    );
    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toBe('no_session');
  });

  it('does not rotate one account by presenting another account`s session', async () => {
    const { store, deps } = setup();
    const mine = store.seedAccount('mine@example.com');
    const yours = store.seedAccount('yours@example.com');
    const yourSlug = store.seededSlug(yours.accountId) ?? '';

    await rotateCapability(
      { cookieHeader: cookieFor(mine.accountId, mine.email), origin: 'https://thepit.show', now: NOW },
      deps,
    );

    // Your slug is untouched: rotation reads the account id out of the signed
    // cookie and has no other input it could be steered by.
    const yoursStillWorks = await openCapabilityUrl({ slug: yourSlug, ip: '198.51.100.7', now: NOW }, deps);
    expect(yoursStillWorks.outcome === 'signed_in' && yoursStillWorks.account.accountId).toBe(yours.accountId);
  });

  it('mints the new slug from the same CSPRNG, at full length', async () => {
    // The case where "we already had a generator lying around" creeps in.
    const { store, deps } = setup();
    const account = store.seedAccount('freshbits@example.com');

    const rotated = await rotateCapability(
      { cookieHeader: cookieFor(account.accountId, account.email), origin: 'https://thepit.show', now: NOW },
      deps,
    );
    expect(rotated.outcome === 'rotated' && rotated.slug).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reports an unknown account rather than silently claiming success', async () => {
    const { deps } = setup();
    // A validly signed cookie naming an account that is not there — our bug or
    // a deleted row, never an attacker, since the MAC held.
    const result = await rotateCapability(
      { cookieHeader: cookieFor('acct_missing', 'ghost@example.com'), origin: 'https://thepit.show', now: NOW },
      deps,
    );
    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toBe('unknown_account');
  });
});

describe('the session a capability URL mints', () => {
  it('carries the account and lasts the same 90 days as a magic link`s', async () => {
    const { store, deps } = setup();
    const account = store.seedAccount('ninety@example.com');
    const result = await openCapabilityUrl(
      { slug: store.seededSlug(account.accountId) ?? '', ip: '198.51.100.7', now: NOW },
      deps,
    );
    expect(result.outcome).toBe('signed_in');
    if (result.outcome !== 'signed_in') return;

    // 90 days in seconds, hand-derived: 90 * 24 * 60 * 60 = 7,776,000.
    expect(result.session.expiresAt - result.session.issuedAt).toBe(7_776_000);
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Lax');
    expect(result.setCookie).toContain('Secure');
    expect(result.setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  it('drops the __Host- prefix and Secure only when told cookies are insecure', async () => {
    const store = new MemoryAuthStore();
    const account = store.seedAccount('localdev@example.com');
    const result = await openCapabilityUrl(
      { slug: store.seededSlug(account.accountId) ?? '', ip: '127.0.0.1', now: NOW },
      { store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING, secureCookies: false },
    );
    expect(result.outcome === 'signed_in' && result.setCookie.startsWith('pit_session=')).toBe(true);
    expect(result.outcome === 'signed_in' && result.setCookie).not.toContain('Secure');
  });
});

describe('the memory store enforces what Postgres will', () => {
  it('refuses a rotation to a slug that is not 43 base64url characters', async () => {
    const store = new MemoryAuthStore();
    const account = store.seedAccount('shape@example.com');
    await expect(
      store.rotateCapabilitySlug({ accountId: account.accountId, slug: 'too-short', now: NOW }),
    ).rejects.toThrow(/accounts_capability_slug_shape/);
  });

  it('refuses to give two accounts the same slug', async () => {
    const store = new MemoryAuthStore();
    const first = store.seedAccount('one@example.com');
    const second = store.seedAccount('two@example.com');
    const taken = store.seededSlug(first.accountId) ?? '';

    await expect(
      store.rotateCapabilitySlug({ accountId: second.accountId, slug: taken, now: NOW }),
    ).rejects.toThrow(/accounts_capability_slug_uk/);
  });
});
