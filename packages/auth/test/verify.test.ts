/**
 * Redemption — `brief §2.1`'s "15-minute expiry, single use", and the session
 * that comes out the other side.
 *
 * The GET-does-not-consume test lives in `apps/web/test/auth-routes.test.ts`,
 * where the GET handler actually is. What is asserted here is the other half of
 * that guarantee: this module, the only thing that can spend a token, is
 * reachable only by calling it, and it spends the token exactly once.
 */

import { describe, expect, it } from 'vitest';

import {
  hashToken,
  MemoryAuthStore,
  MemoryRateLimiter,
  magicTokenExpiry,
  UnlimitedRateLimiter,
  verifyMagicLink,
  verifySessionCookie,
  type SessionKeyring,
  type VerifyDeps,
} from '../src/index.js';
import { TEST_SECRET } from './helpers/fixtures.js';

const KEYRING: SessionKeyring = [TEST_SECRET];
const ISSUED = new Date('2026-03-01T12:00:00.000Z');
const KNOWN = 'alice@example.com';
const IP = '203.0.113.9';
const TOKEN = 'a-token-worth-43-characters-give-or-take-it';

function harness(overrides: Partial<VerifyDeps> = {}): { store: MemoryAuthStore; deps: VerifyDeps } {
  const store = new MemoryAuthStore();
  store.seedAccount(KNOWN, 'acct_7');
  return {
    store,
    deps: { store, limiter: new UnlimitedRateLimiter(), keyring: KEYRING, ...overrides },
  };
}

async function issue(store: MemoryAuthStore, email = KNOWN, at = ISSUED): Promise<void> {
  await store.createToken({
    tokenHash: hashToken(TOKEN),
    email,
    expiresAt: magicTokenExpiry(at),
    createdAt: at,
  });
}

describe('a valid token', () => {
  it('signs the holder in', async () => {
    const { store, deps } = harness();
    await issue(store);

    const result = await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);

    expect(result.outcome).toBe('verified');
    expect(result.outcome === 'verified' && result.session).toEqual({
      accountId: 'acct_7',
      email: KNOWN,
      issuedAt: Math.floor(ISSUED.getTime() / 1000),
      expiresAt: Math.floor(ISSUED.getTime() / 1000) + 90 * 24 * 3600,
    });
  });

  it('returns a cookie that verifies against the same keyring', async () => {
    const { store, deps } = harness();
    await issue(store);

    const result = await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);
    expect(result.outcome).toBe('verified');
    if (result.outcome !== 'verified') {
      return;
    }

    const value = /__Host-pit_session=([^;]+)/.exec(result.setCookie)?.[1] ?? '';
    expect(verifySessionCookie(value, KEYRING, ISSUED)).toEqual({ valid: true, session: result.session });
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('Max-Age=7776000');
  });

  it('marks the token used at the moment it was redeemed', async () => {
    const { store, deps } = harness();
    await issue(store);

    const at = new Date('2026-03-01T12:03:00.000Z');
    await verifyMagicLink({ token: TOKEN, ip: IP, now: at }, deps);

    expect(store.storedToken(hashToken(TOKEN))?.usedAt?.toISOString()).toBe('2026-03-01T12:03:00.000Z');
  });

  it('looks the token up by its digest, never by the token', async () => {
    const { store, deps } = harness();
    await issue(store);
    await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);

    const consume = store.calls.find((call) => call.method === 'consumeToken');
    expect(consume).toEqual({ method: 'consumeToken', tokenHash: hashToken(TOKEN) });
    expect(JSON.stringify(store.calls)).not.toContain(TOKEN);
  });
});

describe('single use', () => {
  it('refuses the same token the second time', async () => {
    const { store, deps } = harness();
    await issue(store);

    expect((await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps)).outcome).toBe('verified');
    expect(await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_token',
    });
  });

  it('issues no second session on the replay', async () => {
    const { store, deps } = harness();
    await issue(store);
    await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);

    const replay = await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);
    expect(JSON.stringify(replay)).not.toContain('__Host-pit_session');
  });
});

describe('expiry', () => {
  it('accepts the token in the fifteenth minute', async () => {
    const { store, deps } = harness();
    await issue(store);

    // Issued 12:00:00, expires 12:15:00. One second before is still good.
    const result = await verifyMagicLink({ token: TOKEN, ip: IP, now: new Date('2026-03-01T12:14:59.000Z') }, deps);
    expect(result.outcome).toBe('verified');
  });

  it('refuses it at fifteen minutes exactly', async () => {
    const { store, deps } = harness();
    await issue(store);

    expect(await verifyMagicLink({ token: TOKEN, ip: IP, now: new Date('2026-03-01T12:15:00.000Z') }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_token',
    });
  });

  it('refuses it a minute later', async () => {
    const { store, deps } = harness();
    await issue(store);

    expect(await verifyMagicLink({ token: TOKEN, ip: IP, now: new Date('2026-03-01T12:16:00.000Z') }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_token',
    });
  });

  it('does not spend an expired token, so nothing changes on retry', async () => {
    const { store, deps } = harness();
    await issue(store);
    await verifyMagicLink({ token: TOKEN, ip: IP, now: new Date('2026-03-01T12:16:00.000Z') }, deps);

    expect(store.storedToken(hashToken(TOKEN))?.usedAt).toBeNull();
  });
});

describe('a token that cannot become a session', () => {
  it('refuses a token that was never issued', async () => {
    const { deps } = harness();
    expect(await verifyMagicLink({ token: 'never-issued', ip: IP, now: ISSUED }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'invalid_token',
    });
  });

  it('reports an unknown token exactly as it reports a spent one', async () => {
    // `brief §2.1`'s non-enumeration posture, carried to the redemption side.
    const { store, deps } = harness();
    await issue(store);
    await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);

    const spent = await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps);
    const unknown = await verifyMagicLink({ token: 'never-issued', ip: IP, now: ISSUED }, deps);
    expect(spent).toEqual(unknown);
  });

  it('refuses an empty token without touching the store', async () => {
    const { store, deps } = harness();
    expect(await verifyMagicLink({ token: '   ', ip: IP, now: ISSUED }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'missing_token',
    });
    expect(store.calls).toEqual([]);
  });

  it('refuses a valid token whose address has no account, and spends it anyway', async () => {
    // `requestMagicLink` writes a token row for an unknown address in order to
    // keep its database work constant. This is the check that makes that safe:
    // a token can never bring an account into existence, and it does not survive
    // to be replayed once an account appears.
    const { store, deps } = harness();
    await issue(store, 'nobody@example.com');

    expect(await verifyMagicLink({ token: TOKEN, ip: IP, now: ISSUED }, deps)).toEqual({
      outcome: 'rejected',
      reason: 'no_account',
    });
    expect(store.storedToken(hashToken(TOKEN))?.usedAt).not.toBeNull();
  });
});

describe('rate limiting the redemption side', () => {
  it('lets twenty attempts through and refuses the twenty-first', async () => {
    const { deps } = harness({ limiter: new MemoryRateLimiter() });

    for (let i = 0; i < 20; i += 1) {
      const attempt = await verifyMagicLink({ token: `guess-${i}`, ip: IP, now: ISSUED }, deps);
      expect(attempt.outcome).toBe('rejected');
    }

    expect(await verifyMagicLink({ token: 'guess-20', ip: IP, now: ISSUED }, deps)).toEqual({
      outcome: 'rate_limited',
      retryAfterSeconds: 900,
    });
  });

  it('limits per IP, so one guesser does not lock everyone out', async () => {
    const { store, deps } = harness({ limiter: new MemoryRateLimiter() });
    await issue(store);
    for (let i = 0; i < 20; i += 1) {
      await verifyMagicLink({ token: `guess-${i}`, ip: IP, now: ISSUED }, deps);
    }

    const elsewhere = await verifyMagicLink({ token: TOKEN, ip: '198.51.100.4', now: ISSUED }, deps);
    expect(elsewhere.outcome).toBe('verified');
  });

  it('does not touch the store once the budget is spent', async () => {
    const { store, deps } = harness({ limiter: new MemoryRateLimiter() });
    for (let i = 0; i < 20; i += 1) {
      await verifyMagicLink({ token: `guess-${i}`, ip: IP, now: ISSUED }, deps);
    }
    const before = store.calls.length;

    await verifyMagicLink({ token: 'guess-20', ip: IP, now: ISSUED }, deps);
    expect(store.calls.length).toBe(before);
  });
});
