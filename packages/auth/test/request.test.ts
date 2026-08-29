/**
 * `POST /auth/request` — `brief §2.1`'s no-enumeration rule.
 *
 * > `POST /auth/request` → always respond "check your inbox" regardless of
 * > whether the email exists (no account enumeration)
 *
 * There are four channels through which "regardless" can leak, and there is a
 * test for each: the body, the status, the database work, and the clock. The
 * fifth — the mail transport failing — gets its own test because a 500 on the
 * known-address path would reopen the oracle through the error page.
 *
 * Each of these fails against the obvious wrong implementation. `it('is byte
 * identical')` fails against `if (!account) return { status: 404 }`. `it('does
 * the same database work')` fails against an early return before `createToken`.
 * `it('takes the same time')` fails against an unpadded await on the provider.
 */

import { describe, expect, it } from 'vitest';

import {
  CHECK_YOUR_INBOX,
  FixtureMailTransport,
  hashToken,
  INVALID_EMAIL_MESSAGE,
  MemoryAuthStore,
  MemoryRateLimiter,
  RATE_LIMITED_MESSAGE,
  requestMagicLink,
  ThrowingMailTransport,
  UnlimitedRateLimiter,
  type AuthRequestDeps,
  type AuthRequestResult,
} from '../src/index.js';
import { FakeTimingFloor, SlowMailTransport } from './helpers/fixtures.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const KNOWN = 'alice@example.com';
const UNKNOWN = 'nobody@example.com';
const IP = '203.0.113.9';

/** A fixed token, so the stored digest is a value this file can state outright. */
const FIXED_TOKEN = 'abc';
/** The published SHA-256 of "abc". Not obtained by running the implementation. */
const FIXED_TOKEN_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function harness(overrides: Partial<AuthRequestDeps> = {}): {
  store: MemoryAuthStore;
  mail: FixtureMailTransport;
  deps: AuthRequestDeps;
} {
  const store = new MemoryAuthStore();
  store.seedAccount(KNOWN, 'acct_7');
  const mail = new FixtureMailTransport();
  const deps: AuthRequestDeps = {
    store,
    mail,
    limiter: new UnlimitedRateLimiter(),
    mailFrom: 'The Pit <no-reply@thepit.show>',
    verifyUrl: 'https://thepit.show/auth/verify',
    ...overrides,
  };
  return { store, mail, deps };
}

describe('the raw token never reaches storage', () => {
  it('stores the SHA-256 digest, not the token', async () => {
    const { store, deps } = harness({ mintToken: () => FIXED_TOKEN });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    const stored = store.storedToken(FIXED_TOKEN_HASH);
    expect(stored?.tokenHash).toBe(FIXED_TOKEN_HASH);
    expect(store.tokenCount).toBe(1);
  });

  it('leaves the raw token nowhere in any stored row', async () => {
    const { store, deps } = harness({ mintToken: () => FIXED_TOKEN });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    // Search every field of every row, not just the one we expect it in — the
    // failure this guards against is a well-meaning `raw` column added later.
    const serialized = JSON.stringify(store.allStoredTokens());
    expect(serialized).toContain(FIXED_TOKEN_HASH);
    expect(JSON.parse(serialized)).toEqual([
      {
        tokenHash: FIXED_TOKEN_HASH,
        email: KNOWN,
        expiresAt: '2026-03-01T12:15:00.000Z',
        usedAt: null,
        createdAt: '2026-03-01T12:00:00.000Z',
      },
    ]);
  });

  it('puts the raw token in the mail and only in the mail', async () => {
    const { store, mail, deps } = harness({ mintToken: () => FIXED_TOKEN });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    expect(mail.last?.text).toContain(`token=${FIXED_TOKEN}`);
    expect(JSON.stringify(store.allStoredTokens())).not.toContain(`"${FIXED_TOKEN}"`);
    expect(mail.last?.idempotencyKey).toBe(`magic-link:${FIXED_TOKEN_HASH}`);
  });

  it('expires the token 15 minutes after it is issued', async () => {
    const { store, deps } = harness({ mintToken: () => FIXED_TOKEN });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    expect(store.storedToken(FIXED_TOKEN_HASH)?.expiresAt.toISOString()).toBe('2026-03-01T12:15:00.000Z');
  });

  it('stores the digest of the token it actually mailed', async () => {
    // Not the digest of a truncation, a re-encoding, or a second token minted
    // for the store. The link is the only place the raw value exists, so the
    // check has to start from there.
    const { store, mail, deps } = harness();
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    const link = /https:\/\/\S+/.exec(mail.last?.text ?? '')?.[0] ?? '';
    const mailed = new URL(link).searchParams.get('token') ?? '';

    expect(mailed).toHaveLength(43);
    expect(store.allStoredTokens()[0]?.tokenHash).toBe(hashToken(mailed));
  });
});

describe('no account enumeration', () => {
  it('answers byte-identically for a known and an unknown address', async () => {
    const { deps } = harness();

    const known = await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    const unknown = await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, deps);

    expect(known.httpStatus).toBe(200);
    expect(unknown.httpStatus).toBe(200);
    expect(known.message).toBe(CHECK_YOUR_INBOX);
    expect(visible(known)).toEqual(visible(unknown));
    expect(JSON.stringify(visible(known))).toBe(JSON.stringify(visible(unknown)));
  });

  it('says nothing in the sentence itself about whether the account exists', () => {
    expect(CHECK_YOUR_INBOX).toContain('If that address has an account');
    expect(CHECK_YOUR_INBOX).not.toContain('@');
  });

  it('still tells the operator which it was, in the log-only field', async () => {
    const { deps } = harness();

    expect((await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps)).outcome).toBe('sent');
    expect((await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, deps)).outcome).toBe('suppressed');
  });

  it('does the same database work in the same order either way', async () => {
    // The channel an identical body does not close: one query for an unknown
    // address and two for a known one is a measurable difference.
    const known = harness();
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, known.deps);

    const unknown = harness();
    await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, unknown.deps);

    expect(known.store.calls.map((call) => call.method)).toEqual(['createToken', 'findAccountByEmail']);
    expect(unknown.store.calls.map((call) => call.method)).toEqual(['createToken', 'findAccountByEmail']);
  });

  it('writes a token row for an address with no account', async () => {
    // Deliberate, and the reason the database work above is identical. It is
    // safe because `verifyMagicLink` refuses a token whose address has no
    // account — see `verify.test.ts`.
    const { store, deps } = harness();
    await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, deps);

    expect(store.tokenCount).toBe(1);
  });

  it('sends no mail to an address with no account', async () => {
    const { mail, deps } = harness();
    await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, deps);

    expect(mail.sent).toHaveLength(0);
  });

  it('takes the same time either way', async () => {
    // A 300ms provider round trip on the known path and nothing on the unknown
    // one is a louder oracle than any body difference. The floor removes it.
    const knownClock = new FakeTimingFloor(500);
    const known = harness({
      timingFloor: knownClock,
      mail: new SlowMailTransport(knownClock, 300),
    });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, known.deps);

    const unknownClock = new FakeTimingFloor(500);
    const unknown = harness({ timingFloor: unknownClock, mail: new SlowMailTransport(unknownClock, 300) });
    await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, unknown.deps);

    // 500 - 300 = 200 on the known path; 500 - 0 = 500 on the unknown one.
    expect(knownClock.sleeps).toEqual([200]);
    expect(unknownClock.sleeps).toEqual([500]);
    expect(knownClock.elapsed).toBe(unknownClock.elapsed);
    expect(knownClock.elapsed).toBe(500);
  });

  it('does not pad when the work already took longer than the floor', async () => {
    const clock = new FakeTimingFloor(500);
    const { deps } = harness({ timingFloor: clock, mail: new SlowMailTransport(clock, 900) });
    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);

    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed).toBe(900);
  });

  it('answers the same when the mail provider returns a failure', async () => {
    const mail = new FixtureMailTransport();
    mail.failEverySend();
    const { deps } = harness({ mail });

    const result = await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    expect(result.httpStatus).toBe(200);
    expect(result.message).toBe(CHECK_YOUR_INBOX);
    // Visible to the operator only.
    expect(result.outcome).toBe('delivery_failed');
  });

  it('answers the same when the mail provider THROWS', async () => {
    // The version that becomes a 500 next to a 200 if anything is unguarded.
    const { deps } = harness({ mail: new ThrowingMailTransport() });

    const result = await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    expect(result.httpStatus).toBe(200);
    expect(result.message).toBe(CHECK_YOUR_INBOX);
    expect(result.outcome).toBe('delivery_failed');
  });

  it('normalizes before deciding, so casing is not a second account', async () => {
    const { mail, deps } = harness();
    const result = await requestMagicLink({ email: '  ALICE@Example.com ', ip: IP, now: NOW }, deps);

    expect(result.outcome).toBe('sent');
    expect(mail.last?.to).toBe(KNOWN);
  });
});

describe('a malformed address', () => {
  it('is refused, because syntax is not a fact about any account', async () => {
    const { deps } = harness();
    const result = await requestMagicLink({ email: 'not-an-address', ip: IP, now: NOW }, deps);

    expect(result).toEqual({ httpStatus: 400, message: INVALID_EMAIL_MESSAGE, outcome: 'invalid_email' });
  });

  it('spends no budget and writes no row', async () => {
    const limiter = new MemoryRateLimiter();
    const { store, deps } = harness({ limiter });
    await requestMagicLink({ email: 'not-an-address', ip: IP, now: NOW }, deps);

    expect(store.calls).toEqual([]);
    expect(limiter.countFor(`auth:request:ip|${IP}`)).toBe(0);
  });
});

describe('rate limiting', () => {
  it('trips per email after three requests in fifteen minutes', async () => {
    const { deps } = harness({ limiter: new MemoryRateLimiter() });

    for (let i = 0; i < 3; i += 1) {
      const ok = await requestMagicLink({ email: KNOWN, ip: `10.0.0.${i}`, now: NOW }, deps);
      expect(ok.httpStatus).toBe(200);
    }

    const blocked = await requestMagicLink({ email: KNOWN, ip: '10.0.0.9', now: NOW }, deps);
    expect(blocked.httpStatus).toBe(429);
    expect(blocked.message).toBe(RATE_LIMITED_MESSAGE);
    expect(blocked.outcome).toBe('rate_limited_email');
    expect(blocked.retryAfterSeconds).toBe(900);
  });

  it('trips per IP after ten requests, independently of any one address', async () => {
    const { deps } = harness({ limiter: new MemoryRateLimiter() });

    for (let i = 0; i < 10; i += 1) {
      const ok = await requestMagicLink({ email: `person${i}@example.com`, ip: IP, now: NOW }, deps);
      expect(ok.httpStatus).toBe(200);
    }

    const blocked = await requestMagicLink({ email: 'person99@example.com', ip: IP, now: NOW }, deps);
    expect(blocked.httpStatus).toBe(429);
    expect(blocked.outcome).toBe('rate_limited_ip');
  });

  it('leaves a fresh address alone when one address is exhausted', async () => {
    const { deps } = harness({ limiter: new MemoryRateLimiter() });
    for (let i = 0; i < 3; i += 1) {
      await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    }

    expect((await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps)).httpStatus).toBe(429);
    expect((await requestMagicLink({ email: 'bob@example.com', ip: IP, now: NOW }, deps)).httpStatus).toBe(200);
  });

  it('leaves a fresh IP alone when one IP is exhausted', async () => {
    const { deps } = harness({ limiter: new MemoryRateLimiter() });
    for (let i = 0; i < 10; i += 1) {
      await requestMagicLink({ email: `person${i}@example.com`, ip: IP, now: NOW }, deps);
    }

    expect((await requestMagicLink({ email: 'other@example.com', ip: IP, now: NOW }, deps)).httpStatus).toBe(429);
    expect(
      (await requestMagicLink({ email: 'other@example.com', ip: '198.51.100.4', now: NOW }, deps)).httpStatus,
    ).toBe(200);
  });

  it('counts an unknown address against its own email budget too', async () => {
    // If the email bucket only moved for real accounts, watching one's own bucket
    // would answer the question the response refuses to.
    const limiter = new MemoryRateLimiter();
    const { deps } = harness({ limiter });

    await requestMagicLink({ email: UNKNOWN, ip: IP, now: NOW }, deps);
    expect(limiter.countFor(`auth:request:email|${UNKNOWN}`)).toBe(1);
    expect(limiter.countFor(`auth:request:email|${KNOWN}`)).toBe(0);
  });

  it('spends the budget BEFORE looking an account up', async () => {
    const limiter = new MemoryRateLimiter();
    const { store, deps } = harness({ limiter });
    for (let i = 0; i < 3; i += 1) {
      await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    }
    const before = store.calls.length;

    await requestMagicLink({ email: KNOWN, ip: IP, now: NOW }, deps);
    expect(store.calls.length).toBe(before);
  });
});

/** Everything the requester can observe. `outcome` is a log field, not a response. */
function visible(result: AuthRequestResult): { httpStatus: number; message: string; retryAfterSeconds?: number } {
  return result.retryAfterSeconds === undefined
    ? { httpStatus: result.httpStatus, message: result.message }
    : { httpStatus: result.httpStatus, message: result.message, retryAfterSeconds: result.retryAfterSeconds };
}
