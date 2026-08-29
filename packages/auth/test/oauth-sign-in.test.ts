/**
 * The GitHub flow end to end, against a fixture provider that never opens a
 * socket.
 *
 * Four properties are load-bearing and each has a test written so that the
 * WRONG behaviour fails it:
 *
 * 1. An unverified GitHub address never matches a purchase — asserted on the
 *    outcome AND on the store's call log, so an implementation that looked the
 *    address up and then discarded the result still fails.
 * 2. A verified address that matches a payment email signs in to the EXISTING
 *    account; the account count does not move.
 * 3. A sign-in with no matching purchase creates nothing at all.
 * 4. The link is keyed on GitHub's immutable user id, so changing a GitHub email
 *    does not orphan the account — and a link is never moved to a different
 *    account, which is the takeover the unique index exists to stop.
 */

import { describe, expect, it } from 'vitest';

import {
  FixtureOAuthProvider,
  MemoryAuthStore,
  MemoryRateLimiter,
  UnlimitedRateLimiter,
  AUTH_RATE_LIMITS,
  completeOAuthSignIn,
  newSessionPayload,
  readSession,
  serializeSessionCookie,
  signSessionCookie,
  startOAuthSignIn,
  unverifiedEmail,
  verifiedEmail,
  SESSION_COOKIE_NAME,
  type CompleteOAuthResult,
  type OAuthDeps,
} from '../src/index.js';
import { TEST_SECRET } from './helpers/fixtures.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const KEYRING = [TEST_SECRET] as const;
const REDIRECT_URI = 'https://thepit.show/auth/github/callback';
const IP = '198.51.100.7';

interface Harness {
  store: MemoryAuthStore;
  provider: FixtureOAuthProvider;
  deps: OAuthDeps;
}

function harness(options: { pkce?: 'S256' | 'none' } = {}): Harness {
  const store = new MemoryAuthStore();
  const provider = new FixtureOAuthProvider({ pkce: options.pkce ?? 'none' });
  return {
    store,
    provider,
    deps: { provider, store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING },
  };
}

/** Run a whole round trip and return what the callback decided. */
async function roundTrip(
  h: Harness,
  options: { sessionCookie?: string; code?: string; now?: Date } = {},
): Promise<CompleteOAuthResult> {
  const now = options.now ?? NOW;
  const started = startOAuthSignIn(
    { redirectUri: REDIRECT_URI, now, ...(options.sessionCookie === undefined ? {} : { cookieHeader: options.sessionCookie }) },
    h.deps,
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  // The browser carries the state cookie back, plus whatever session it had.
  const stateCookie = started.setCookie.split(';')[0] ?? '';
  const cookieHeader = options.sessionCookie === undefined ? stateCookie : `${options.sessionCookie}; ${stateCookie}`;

  return await completeOAuthSignIn(
    {
      code: options.code ?? 'good-code',
      state,
      error: null,
      redirectUri: REDIRECT_URI,
      cookieHeader,
      ip: IP,
      now,
    },
    h.deps,
  );
}

function sessionCookieFor(accountId: string, email: string): string {
  const signed = signSessionCookie(newSessionPayload({ accountId, email, now: NOW }), KEYRING);
  return `${SESSION_COOKIE_NAME}=${signed}`;
}

// ---------------------------------------------------------------------------

describe('an unverified GitHub email never matches a purchase', () => {
  it('does not sign in, and never even asks the store about the address', async () => {
    // The attack, in full: the customer paid as payer@example.com. The attacker
    // typed that address into their own GitHub settings and never confirmed it.
    const h = harness();
    const customer = h.store.seedAccount('payer@example.com');
    h.provider.setEmails('999', [unverifiedEmail('payer@example.com', true)]);

    const result = await roundTrip(h);

    expect(result.outcome).toBe('no_purchase_found');
    if (result.outcome !== 'no_purchase_found') return;
    expect(result.verifiedEmails).toEqual([]);
    expect(result.ignoredEmails).toEqual(['payer@example.com']);

    // The discriminating half. An implementation that filtered AFTER looking the
    // address up would return the same outcome here and still be one edit away
    // from a takeover; the call log is what proves the address never reached
    // the store at all.
    const lookups = h.store.calls.filter((call) => call.method === 'findAccountByEmail');
    expect(lookups).toEqual([]);

    // And nothing was linked to the customer's account.
    expect(await h.store.identitiesFor(customer.accountId)).toEqual([]);
  });

  it('matches only the attacker`s own verified address when both are present', async () => {
    const h = harness();
    h.store.seedAccount('victim@example.com');
    const attackerAccount = h.store.seedAccount('attacker@example.com');
    h.provider.setEmails('999', [
      unverifiedEmail('victim@example.com', true),
      verifiedEmail('attacker@example.com'),
    ]);

    const result = await roundTrip(h);

    expect(result.outcome).toBe('signed_in');
    // Their own account, not the victim's.
    expect(result.outcome === 'signed_in' && result.email).toBe('attacker@example.com');
    expect(result.outcome === 'signed_in' && result.accountId).toBe(attackerAccount.accountId);

    const lookedUp = h.store.calls
      .filter((call) => call.method === 'findAccountByEmail')
      .map((call) => (call.method === 'findAccountByEmail' ? call.email : ''));
    expect(lookedUp).toEqual(['attacker@example.com']);
    expect(lookedUp).not.toContain('victim@example.com');
  });

  it('reports no verified address at all when GitHub returns only unverified ones', async () => {
    const h = harness();
    h.provider.setEmails('999', [unverifiedEmail('a@example.com', true), unverifiedEmail('b@example.com')]);

    const result = await roundTrip(h);
    expect(result.outcome).toBe('no_purchase_found');
    expect(result.outcome === 'no_purchase_found' && result.verifiedEmails).toEqual([]);
  });
});

describe('a verified email that matches a purchase reaches the existing account', () => {
  it('signs into the account the payment made, and creates no second one', async () => {
    const h = harness();
    const existing = h.store.seedAccount('payer@example.com');
    expect(h.store.accountCount).toBe(1);

    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)], 'octocat');
    const result = await roundTrip(h);

    expect(result.outcome).toBe('signed_in');
    if (result.outcome !== 'signed_in') return;
    expect(result.accountId).toBe(existing.accountId);
    expect(result.email).toBe('payer@example.com');
    expect(result.intent).toBe('sign_in');

    // No second account. This is the assertion that fails if the flow ever
    // starts creating one "just in case".
    expect(h.store.accountCount).toBe(1);

    // The session is real and names the same account.
    const verified = readSession({ cookieHeader: result.setCookies[0], keyring: KEYRING, now: NOW });
    expect(verified.valid && verified.session.accountId).toBe(existing.accountId);
  });

  it('folds case, so the address on GitHub need not match the receipt byte for byte', async () => {
    const h = harness();
    const existing = h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('Payer@Example.COM', true)]);

    const result = await roundTrip(h);
    expect(result.outcome === 'signed_in' && result.accountId).toBe(existing.accountId);
    expect(h.store.accountCount).toBe(1);
  });

  it('records the link, keyed on GitHub`s numeric id', async () => {
    const h = harness();
    const existing = h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)], 'octocat');

    await roundTrip(h);

    expect(await h.store.identitiesFor(existing.accountId)).toEqual([
      {
        accountId: existing.accountId,
        provider: 'github',
        providerUserId: '4242',
        linkedEmail: 'payer@example.com',
      },
    ]);
  });

  it('tries the primary address first when several are verified', async () => {
    const h = harness();
    h.store.seedAccount('secondary@example.com');
    const primaryAccount = h.store.seedAccount('primary@example.com');
    h.provider.setEmails('4242', [
      verifiedEmail('secondary@example.com', false),
      verifiedEmail('primary@example.com', true),
    ]);

    const result = await roundTrip(h);
    expect(result.outcome === 'signed_in' && result.accountId).toBe(primaryAccount.accountId);
  });

  it('falls through to a secondary address when the primary bought nothing', async () => {
    const h = harness();
    const bought = h.store.seedAccount('work@example.com');
    h.provider.setEmails('4242', [
      verifiedEmail('personal@example.com', true),
      verifiedEmail('work@example.com', false),
    ]);

    const result = await roundTrip(h);
    expect(result.outcome === 'signed_in' && result.accountId).toBe(bought.accountId);
    expect(h.store.accountCount).toBe(1);
  });
});

describe('a GitHub sign-in with no matching purchase creates no account', () => {
  it('says so plainly and leaves the store empty', async () => {
    const h = harness();
    expect(h.store.accountCount).toBe(0);
    h.provider.setEmails('4242', [verifiedEmail('stranger@example.com', true)]);

    const result = await roundTrip(h);

    expect(result.outcome).toBe('no_purchase_found');
    if (result.outcome !== 'no_purchase_found') return;
    // The addresses we looked at, so the page can name them.
    expect(result.verifiedEmails).toEqual(['stranger@example.com']);

    // Nothing was created. An account is a purchase.
    expect(h.store.accountCount).toBe(0);
    expect(h.store.identityCount).toBe(0);
    // And no session was issued — `no_purchase_found` carries no session cookie.
    expect(result.setCookies.every((cookie) => !cookie.startsWith(SESSION_COOKIE_NAME))).toBe(true);
  });

  it('leaves an existing unrelated account untouched', async () => {
    const h = harness();
    const other = h.store.seedAccount('someone-else@example.com');
    h.provider.setEmails('4242', [verifiedEmail('stranger@example.com', true)]);

    await roundTrip(h);

    expect(h.store.accountCount).toBe(1);
    expect(await h.store.identitiesFor(other.accountId)).toEqual([]);
  });
});

describe('a changed GitHub email does not orphan the account', () => {
  it('resolves through the link when the address no longer matches anything', async () => {
    const h = harness();
    const existing = h.store.seedAccount('payer@example.com');

    // First sign-in: matched by address, link recorded on id 4242.
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);
    const first = await roundTrip(h);
    expect(first.outcome === 'signed_in' && first.accountId).toBe(existing.accountId);

    // The customer changes their GitHub address. Same GitHub user, new email,
    // and no account was ever opened for it.
    h.provider.setEmails('4242', [verifiedEmail('brand-new@example.com', true)]);
    const second = await roundTrip(h);

    expect(second.outcome).toBe('signed_in');
    expect(second.outcome === 'signed_in' && second.accountId).toBe(existing.accountId);
    expect(h.store.accountCount).toBe(1);

    // The link's recorded address is refreshed, and it is still one link.
    expect(await h.store.identitiesFor(existing.accountId)).toEqual([
      {
        accountId: existing.accountId,
        provider: 'github',
        providerUserId: '4242',
        linkedEmail: 'brand-new@example.com',
      },
    ]);
  });

  it('checks the link BEFORE any address match', async () => {
    // A different GitHub user has since verified the customer's old address.
    // The customer's own link must still win for their own GitHub id.
    const h = harness();
    const customer = h.store.seedAccount('payer@example.com');
    const impostor = h.store.seedAccount('impostor@example.com');

    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);
    await roundTrip(h);

    // Same GitHub id, now also carrying the impostor's verified address first.
    h.provider.setEmails('4242', [
      verifiedEmail('impostor@example.com', true),
      verifiedEmail('payer@example.com', false),
    ]);
    const result = await roundTrip(h);

    expect(result.outcome === 'signed_in' && result.accountId).toBe(customer.accountId);
    expect(result.outcome === 'signed_in' && result.accountId).not.toBe(impostor.accountId);
    // The link answered it; no address lookup was needed on the second pass.
    const lookupsAfterFirst = h.store.calls
      .filter((call) => call.method === 'findAccountByEmail')
      .map((call) => (call.method === 'findAccountByEmail' ? call.email : ''));
    expect(lookupsAfterFirst).toEqual(['payer@example.com']);
  });

  it('refuses to move an existing link to another account', async () => {
    // The takeover `account_identities_provider_user_uk` exists to stop: the
    // attacker signs in once with their own account, then adds and verifies the
    // customer's address and signs in again hoping to be re-pointed.
    const h = harness();
    const attacker = h.store.seedAccount('attacker@example.com');
    h.store.seedAccount('payer@example.com');

    h.provider.setEmails('4242', [verifiedEmail('attacker@example.com', true)]);
    await roundTrip(h);

    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);
    const second = await roundTrip(h);

    // Resolved through the link to the attacker's OWN account. Boring, correct.
    expect(second.outcome === 'signed_in' && second.accountId).toBe(attacker.accountId);
    expect(h.store.identityCount).toBe(1);
  });
});

describe('retroactive claiming — GitHub is an upgrade, never a gate', () => {
  it('links to the session`s account even when no GitHub address matches the receipt', async () => {
    // The mobile story. They paid as a guest with a work address, reached the
    // account by capability URL, and their GitHub carries a personal address
    // that bought nothing.
    const h = harness();
    const account = h.store.seedAccount('work@example.com');
    h.provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);

    const result = await roundTrip(h, { sessionCookie: sessionCookieFor(account.accountId, account.email) });

    expect(result.outcome).toBe('signed_in');
    if (result.outcome !== 'signed_in') return;
    expect(result.intent).toBe('link');
    expect(result.accountId).toBe(account.accountId);
    expect(h.store.accountCount).toBe(1);

    // No address lookup happened at all — the session was the proof.
    expect(h.store.calls.filter((call) => call.method === 'findAccountByEmail')).toEqual([]);

    expect(await h.store.identitiesFor(account.accountId)).toEqual([
      {
        accountId: account.accountId,
        provider: 'github',
        providerUserId: '4242',
        linkedEmail: 'personal@example.com',
      },
    ]);
  });

  it('lets that customer sign in with GitHub afterwards, reaching the same account', async () => {
    // Linking first, signing in second — the two halves of "signing in later
    // must reach the same account as signing in first".
    const h = harness();
    const account = h.store.seedAccount('work@example.com');
    h.provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);

    await roundTrip(h, { sessionCookie: sessionCookieFor(account.accountId, account.email) });

    // Later, on a different device, with no session.
    const later = await roundTrip(h);
    expect(later.outcome === 'signed_in' && later.accountId).toBe(account.accountId);
    expect(h.store.accountCount).toBe(1);
  });

  it('refuses the link if the session expired during the round trip', async () => {
    const h = harness();
    const account = h.store.seedAccount('work@example.com');
    h.provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);

    const cookie = sessionCookieFor(account.accountId, account.email);
    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW, cookieHeader: cookie }, h.deps);
    expect(started.intent).toBe('link');
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    // The state is still valid (5 minutes on), but the browser lost the session.
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);
    const result = await completeOAuthSignIn(
      {
        code: 'good-code',
        state,
        error: null,
        redirectUri: REDIRECT_URI,
        cookieHeader: started.setCookie.split(';')[0] ?? '',
        ip: IP,
        now: later,
      },
      h.deps,
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toBe('session_expired');
    expect(h.store.identityCount).toBe(0);
  });

  it('decides the intent when the flow STARTS, not from the callback`s query string', async () => {
    // A callback that could be told which mode to run in is a callback an
    // attacker can tell to run in the mode that skips the email check. The
    // intent rides in the signed state cookie and there is no query parameter
    // for it.
    const h = harness();
    const anonymous = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, h.deps);
    expect(anonymous.intent).toBe('sign_in');

    const account = h.store.seedAccount('someone@example.com');
    const signedIn = startOAuthSignIn(
      { redirectUri: REDIRECT_URI, now: NOW, cookieHeader: sessionCookieFor(account.accountId, account.email) },
      h.deps,
    );
    expect(signedIn.intent).toBe('link');
  });
});

describe('the callback refuses what it should', () => {
  it('rejects a state that does not match the cookie', async () => {
    const h = harness();
    h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);

    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, h.deps);
    const result = await completeOAuthSignIn(
      {
        code: 'good-code',
        state: 'a-state-nobody-issued',
        error: null,
        redirectUri: REDIRECT_URI,
        cookieHeader: started.setCookie.split(';')[0] ?? '',
        ip: IP,
        now: NOW,
      },
      h.deps,
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toBe('state_mismatch');
    // Refused before the code ever reached the provider — a CSRF attempt must
    // not become an outbound request.
    expect(h.provider.exchanges).toEqual([]);
  });

  it('rejects a callback with no state cookie at all', async () => {
    const h = harness();
    const result = await completeOAuthSignIn(
      { code: 'good-code', state: 'anything', error: null, redirectUri: REDIRECT_URI, cookieHeader: null, ip: IP, now: NOW },
      h.deps,
    );
    expect(result.outcome === 'rejected' && result.reason).toBe('state_missing');
    expect(h.provider.exchanges).toEqual([]);
  });

  it('rejects a state cookie that has expired', async () => {
    const h = harness();
    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, h.deps);
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    // Ten minutes exactly. `expiresAt * 1000 <= now` is the refusal.
    const tooLate = new Date(NOW.getTime() + 10 * 60 * 1000);
    const result = await completeOAuthSignIn(
      {
        code: 'good-code',
        state,
        error: null,
        redirectUri: REDIRECT_URI,
        cookieHeader: started.setCookie.split(';')[0] ?? '',
        ip: IP,
        now: tooLate,
      },
      h.deps,
    );
    expect(result.outcome === 'rejected' && result.reason).toBe('state_expired');
  });

  it('renders a page rather than throwing when GitHub refuses the code', async () => {
    const h = harness();
    h.provider.failExchange();
    const result = await roundTrip(h);
    expect(result.outcome === 'rejected' && result.reason).toBe('exchange_failed');
  });

  it('renders a page rather than throwing when the identity fetch fails', async () => {
    const h = harness();
    h.provider.failIdentity();
    const result = await roundTrip(h);
    expect(result.outcome === 'rejected' && result.reason).toBe('identity_failed');
  });

  it('handles the customer pressing Cancel on GitHub`s screen', async () => {
    const h = harness();
    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, h.deps);
    const result = await completeOAuthSignIn(
      {
        code: null,
        state: new URL(started.authorizationUrl).searchParams.get('state'),
        error: 'access_denied',
        redirectUri: REDIRECT_URI,
        cookieHeader: started.setCookie.split(';')[0] ?? '',
        ip: IP,
        now: NOW,
      },
      h.deps,
    );
    expect(result.outcome === 'rejected' && result.reason).toBe('provider_denied');
    expect(h.provider.exchanges).toEqual([]);
  });

  it('clears the state cookie on every outcome, success and failure alike', async () => {
    const h = harness();
    h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);

    const ok = await roundTrip(h);
    expect(ok.outcome === 'signed_in' && ok.setCookies.some((c) => c.includes('pit_oauth=') && c.includes('Max-Age=0'))).toBe(true);

    h.provider.failExchange();
    const failed = await roundTrip(h);
    expect(failed.outcome === 'rejected' && failed.setCookies.some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('spends the per-IP budget before anything costs an outbound request', async () => {
    const store = new MemoryAuthStore();
    const provider = new FixtureOAuthProvider();
    const limiter = new MemoryRateLimiter();
    const deps: OAuthDeps = { provider, store, limiter, keyring: KEYRING };

    for (let i = 0; i < AUTH_RATE_LIMITS.oauthPerIp.limit; i += 1) {
      await completeOAuthSignIn(
        { code: 'x', state: 'x', error: null, redirectUri: REDIRECT_URI, cookieHeader: null, ip: '192.0.2.1', now: NOW },
        deps,
      );
    }
    const blocked = await completeOAuthSignIn(
      { code: 'x', state: 'x', error: null, redirectUri: REDIRECT_URI, cookieHeader: null, ip: '192.0.2.1', now: NOW },
      deps,
    );
    expect(blocked.outcome).toBe('rate_limited');
    expect(provider.exchanges).toEqual([]);
  });
});

describe('PKCE is run only where it is honoured', () => {
  it('sends no challenge for a provider that declares pkce: none — GitHub', async () => {
    const h = harness({ pkce: 'none' });
    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, h.deps);
    expect(new URL(started.authorizationUrl).searchParams.get('code_challenge')).toBeNull();
    expect(h.provider.authorizations[0]?.codeChallenge).toBeUndefined();

    h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);
    await roundTrip(h);
    expect(h.provider.exchanges[0]?.codeVerifier).toBeUndefined();
  });

  it('sends an S256 challenge, and the matching verifier at exchange time', async () => {
    const h = harness({ pkce: 'S256' });
    h.store.seedAccount('payer@example.com');
    h.provider.setEmails('4242', [verifiedEmail('payer@example.com', true)]);

    const result = await roundTrip(h);
    expect(result.outcome).toBe('signed_in');

    const challenge = h.provider.authorizations[0]?.codeChallenge;
    const verifier = h.provider.exchanges[0]?.codeVerifier;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The challenge is S256 of the verifier, never the verifier itself.
    expect(challenge).not.toBe(verifier);
    const { createHash } = await import('node:crypto');
    expect(challenge).toBe(createHash('sha256').update(verifier ?? '', 'ascii').digest('base64url'));
  });
});
