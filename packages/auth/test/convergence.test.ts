/**
 * Three doors, one room.
 *
 * Each of the three paths was tested in isolation elsewhere. This file tests the
 * property that only exists when they are used together, and which is where this
 * kind of design usually breaks: a customer who arrives by one door and later
 * uses another must land on the SAME `accounts` row, not on a second one that
 * quietly holds half their attempts.
 *
 * The assertion that carries the weight in every test below is
 * `store.accountCount`. Outcomes can agree while the store has silently grown a
 * duplicate, and a duplicate account is the failure that is invisible until a
 * customer says "it says I have one attempt left, I bought three".
 *
 * Every ordering is exercised, because they are genuinely different code paths:
 * a magic link resolves by address, a capability URL resolves by slug, and
 * GitHub resolves by link-then-address.
 */

import { describe, expect, it } from 'vitest';

import {
  FixtureMailTransport,
  FixtureOAuthProvider,
  MemoryAuthStore,
  UnlimitedRateLimiter,
  completeOAuthSignIn,
  hashToken,
  magicTokenExpiry,
  mintMagicToken,
  openCapabilityUrl,
  readSession,
  requestMagicLink,
  rotateCapability,
  startOAuthSignIn,
  verifiedEmail,
  verifyMagicLink,
  noTimingFloor,
  SESSION_COOKIE_NAME,
  type CapabilityDeps,
  type OAuthDeps,
} from '../src/index.js';
import { TEST_SECRET } from './helpers/fixtures.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const KEYRING = [TEST_SECRET] as const;
const PAYER = 'payer@example.com';
const IP = '198.51.100.7';
const REDIRECT_URI = 'https://thepit.show/auth/github/callback';

interface World {
  store: MemoryAuthStore;
  provider: FixtureOAuthProvider;
  capability: CapabilityDeps;
  oauth: OAuthDeps;
}

function world(): World {
  const store = new MemoryAuthStore();
  const provider = new FixtureOAuthProvider();
  const limiter = new UnlimitedRateLimiter();
  return {
    store,
    provider,
    capability: { store, limiter, keyring: KEYRING },
    oauth: { provider, store, limiter, keyring: KEYRING },
  };
}

/** The magic link, end to end, as `apps/web` runs it. */
async function signInByMagicLink(w: World, email: string): Promise<string | null> {
  const mail = new FixtureMailTransport();
  await requestMagicLink(
    { email, ip: IP, now: NOW },
    {
      store: w.store,
      limiter: new UnlimitedRateLimiter(),
      mail,
      mailFrom: 'The Pit <no-reply@thepit.show>',
      verifyUrl: 'https://thepit.show/auth/verify',
      timingFloor: noTimingFloor(),
    },
  );
  const sent = mail.last;
  if (sent === undefined) {
    return null;
  }
  const token = new URL(/https:\/\/\S+/.exec(sent.text)?.[0] ?? '').searchParams.get('token') ?? '';
  const verified = await verifyMagicLink(
    { token, ip: IP, now: NOW },
    { store: w.store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING },
  );
  return verified.outcome === 'verified' ? verified.session.accountId : null;
}

async function signInByCapability(w: World, slug: string): Promise<string | null> {
  const result = await openCapabilityUrl({ slug, ip: IP, now: NOW }, w.capability);
  return result.outcome === 'signed_in' ? result.account.accountId : null;
}

async function signInByGitHub(w: World, sessionCookie?: string): Promise<string | null> {
  const started = startOAuthSignIn(
    { redirectUri: REDIRECT_URI, now: NOW, ...(sessionCookie === undefined ? {} : { cookieHeader: sessionCookie }) },
    w.oauth,
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  const stateCookie = started.setCookie.split(';')[0] ?? '';
  const result = await completeOAuthSignIn(
    {
      code: 'good-code',
      state,
      error: null,
      redirectUri: REDIRECT_URI,
      cookieHeader: sessionCookie === undefined ? stateCookie : `${sessionCookie}; ${stateCookie}`,
      ip: IP,
      now: NOW,
    },
    w.oauth,
  );
  return result.outcome === 'signed_in' ? result.accountId : null;
}

/** The `Cookie:` header a browser holding a session would send. */
function asCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

// ---------------------------------------------------------------------------

describe('all three paths reach the one account the payment made', () => {
  it('magic link, capability URL and GitHub agree, and there is still one account', async () => {
    const w = world();
    // The only thing that ever creates an account: the Dodo webhook.
    const created = w.store.seedAccount(PAYER);
    const slug = w.store.seededSlug(created.accountId) ?? '';
    w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);

    const viaLink = await signInByMagicLink(w, PAYER);
    const viaSlug = await signInByCapability(w, slug);
    const viaGitHub = await signInByGitHub(w);

    expect(viaLink).toBe(created.accountId);
    expect(viaSlug).toBe(created.accountId);
    expect(viaGitHub).toBe(created.accountId);
    expect(new Set([viaLink, viaSlug, viaGitHub]).size).toBe(1);

    // THE assertion. Three sign-ins, one row.
    expect(w.store.accountCount).toBe(1);
  });

  it('holds in every order the three could be used in', async () => {
    // Six permutations. Each is a different resolution path — by address, by
    // slug, by provider link — and any of them creating a row would show here.
    const orders: readonly (readonly ('link' | 'slug' | 'github')[])[] = [
      ['link', 'slug', 'github'],
      ['link', 'github', 'slug'],
      ['slug', 'link', 'github'],
      ['slug', 'github', 'link'],
      ['github', 'link', 'slug'],
      ['github', 'slug', 'link'],
    ];

    for (const order of orders) {
      const w = world();
      const created = w.store.seedAccount(PAYER);
      const slug = w.store.seededSlug(created.accountId) ?? '';
      w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);

      const reached: (string | null)[] = [];
      for (const door of order) {
        if (door === 'link') reached.push(await signInByMagicLink(w, PAYER));
        if (door === 'slug') reached.push(await signInByCapability(w, slug));
        if (door === 'github') reached.push(await signInByGitHub(w));
      }

      expect(`${order.join('>')}: ${JSON.stringify(reached)}`).toBe(
        `${order.join('>')}: ${JSON.stringify([created.accountId, created.accountId, created.accountId])}`,
      );
      expect(`${order.join('>')}: ${w.store.accountCount}`).toBe(`${order.join('>')}: 1`);
      // And exactly one provider link, however many times GitHub was used.
      expect(`${order.join('>')}: ${w.store.identityCount}`).toBe(`${order.join('>')}: 1`);
    }
  });
});

describe('the guest-checkout story, in order', () => {
  it('pay on a phone, bookmark the URL, connect GitHub later, sign in with GitHub from a laptop', async () => {
    // The whole point of the design, walked through as a customer would.
    const w = world();

    // 1. They paid. The webhook made the account and minted the slug. No login
    //    happened at any point, on a device where OAuth would have lost them.
    const account = w.store.seedAccount('work@example.com');
    const slug = w.store.seededSlug(account.accountId) ?? '';

    // 2. The success page showed the URL. They bookmarked it and used it.
    const opened = await openCapabilityUrl({ slug, ip: IP, now: NOW }, w.capability);
    expect(opened.outcome).toBe('signed_in');
    if (opened.outcome !== 'signed_in') return;
    const phoneSession = asCookie(opened.setCookie);

    // 3. Later, still signed in, they connect GitHub — whose verified address is
    //    personal and bought nothing. The session is the proof, so it links.
    w.provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);
    const linked = await signInByGitHub(w, phoneSession);
    expect(linked).toBe(account.accountId);

    // 4. On a laptop, with no cookie at all, GitHub gets them back in.
    const laptop = await signInByGitHub(w);
    expect(laptop).toBe(account.accountId);

    // One account throughout, and one link.
    expect(w.store.accountCount).toBe(1);
    expect(w.store.identityCount).toBe(1);
  });

  it('signing in with GitHub first confers the same account as doing it later', async () => {
    // "Signing in later must reach the same account and confer the same
    // benefits as signing in first."
    const first = world();
    const second = world();

    for (const w of [first, second]) {
      w.store.seedAccount(PAYER);
      w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);
    }

    // GitHub first, then the capability URL.
    const githubFirst = await signInByGitHub(first);
    const slugFirst = first.store.seededSlug(githubFirst ?? '') ?? '';
    expect(await signInByCapability(first, slugFirst)).toBe(githubFirst);

    // The capability URL first, then GitHub.
    const account = second.store.seededSlug(
      (await second.store.findAccountByEmail(PAYER))?.accountId ?? '',
    );
    const slugSecond = await signInByCapability(second, account ?? '');
    expect(await signInByGitHub(second)).toBe(slugSecond);

    expect(first.store.accountCount).toBe(1);
    expect(second.store.accountCount).toBe(1);
  });
});

describe('convergence survives the things that move underneath it', () => {
  it('a rotated slug still lands on the account the other two doors reach', async () => {
    const w = world();
    const account = w.store.seedAccount(PAYER);
    w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);

    const opened = await openCapabilityUrl(
      { slug: w.store.seededSlug(account.accountId) ?? '', ip: IP, now: NOW },
      w.capability,
    );
    if (opened.outcome !== 'signed_in') throw new Error('unreachable');

    const rotated = await rotateCapability(
      { cookieHeader: asCookie(opened.setCookie), origin: 'https://thepit.show', now: NOW },
      w.capability,
    );
    if (rotated.outcome !== 'rotated') throw new Error('unreachable');

    expect(await signInByCapability(w, rotated.slug)).toBe(account.accountId);
    expect(await signInByMagicLink(w, PAYER)).toBe(account.accountId);
    expect(await signInByGitHub(w)).toBe(account.accountId);
    expect(w.store.accountCount).toBe(1);
  });

  it('a changed GitHub address does not fork the account', async () => {
    const w = world();
    const account = w.store.seedAccount(PAYER);
    w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);
    expect(await signInByGitHub(w)).toBe(account.accountId);

    // They change their GitHub email to one that never bought anything.
    w.provider.setEmails('4242', [verifiedEmail('moved@example.com', true)]);
    expect(await signInByGitHub(w)).toBe(account.accountId);

    // And the other two doors are unaffected.
    expect(await signInByMagicLink(w, PAYER)).toBe(account.accountId);
    expect(await signInByCapability(w, w.store.seededSlug(account.accountId) ?? '')).toBe(account.accountId);
    expect(w.store.accountCount).toBe(1);
  });

  it('two different payers keep two different accounts', async () => {
    // The mirror of convergence: the paths must not collapse two customers into
    // one either.
    const w = world();
    const first = w.store.seedAccount('one@example.com');
    const second = w.store.seedAccount('two@example.com');

    expect(await signInByCapability(w, w.store.seededSlug(first.accountId) ?? '')).toBe(first.accountId);
    expect(await signInByCapability(w, w.store.seededSlug(second.accountId) ?? '')).toBe(second.accountId);
    expect(await signInByMagicLink(w, 'one@example.com')).toBe(first.accountId);
    expect(await signInByMagicLink(w, 'two@example.com')).toBe(second.accountId);
    expect(first.accountId).not.toBe(second.accountId);
    expect(w.store.accountCount).toBe(2);
  });
});

describe('every door mints the same kind of session', () => {
  it('all three produce a cookie the same gate accepts for the same account', async () => {
    // `GET /auth/session` does not know or care which door was used, so the
    // three must be interchangeable at the point they hand over.
    const w = world();
    const account = w.store.seedAccount(PAYER);
    w.provider.setEmails('4242', [verifiedEmail(PAYER, true)]);

    const fromSlug = await openCapabilityUrl(
      { slug: w.store.seededSlug(account.accountId) ?? '', ip: IP, now: NOW },
      w.capability,
    );
    if (fromSlug.outcome !== 'signed_in') throw new Error('unreachable');

    const started = startOAuthSignIn({ redirectUri: REDIRECT_URI, now: NOW }, w.oauth);
    const fromGitHub = await completeOAuthSignIn(
      {
        code: 'good-code',
        state: new URL(started.authorizationUrl).searchParams.get('state'),
        error: null,
        redirectUri: REDIRECT_URI,
        cookieHeader: asCookie(started.setCookie),
        ip: IP,
        now: NOW,
      },
      w.oauth,
    );
    if (fromGitHub.outcome !== 'signed_in') throw new Error('unreachable');

    const raw = mintMagicToken();
    await w.store.createToken({
      tokenHash: hashToken(raw),
      email: PAYER,
      expiresAt: magicTokenExpiry(NOW),
      createdAt: NOW,
    });
    const fromLink = await verifyMagicLink(
      { token: raw, ip: IP, now: NOW },
      { store: w.store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING },
    );
    if (fromLink.outcome !== 'verified') throw new Error('unreachable');

    for (const setCookie of [fromSlug.setCookie, fromGitHub.setCookies[0] ?? '', fromLink.setCookie]) {
      expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
      const verified = readSession({ cookieHeader: setCookie, keyring: KEYRING, now: NOW });
      expect(verified.valid && verified.session.accountId).toBe(account.accountId);
      expect(verified.valid && verified.session.email).toBe(PAYER);
      // 90 days, identically. `brief §2.1`.
      expect(verified.valid && verified.session.expiresAt - verified.session.issuedAt).toBe(7_776_000);
    }
  });
});
