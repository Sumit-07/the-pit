/**
 * `brief §2.1`: "Rate limit per email and per IP."
 *
 * The word doing the work is "and". Two limits that share a counter are one
 * limit, and the two attacks they stop — a mail cannon at one address from many
 * hosts, and address harvesting from one host across many addresses — each defeat
 * the other limit entirely. So the independence assertions below are the point of
 * this file; the window arithmetic is the supporting cast.
 *
 * Every expected number is derived from the policy by hand: with a limit of 3 in
 * a 900 000 ms window, three hits at t=0 exhaust it, and the window frees a slot
 * 900 000 ms after the oldest hit — so at t=60 000 the wait is 840 000 ms, which
 * is 840 seconds.
 */

import { describe, expect, it } from 'vitest';

import { AUTH_RATE_LIMITS, bucketKey, MemoryRateLimiter } from '../src/index.js';

const POLICY = { limit: 3, windowMs: 900_000 };
const at = (ms: number): Date => new Date(1_800_000_000_000 + ms);

describe('the budgets brief §2.1 requires', () => {
  it('limits per email over the same 15 minutes a token lives', () => {
    expect(AUTH_RATE_LIMITS.requestPerEmail).toEqual({ limit: 3, windowMs: 900_000 });
  });

  it('limits per IP more loosely, for the office behind one NAT address', () => {
    expect(AUTH_RATE_LIMITS.requestPerIp).toEqual({ limit: 10, windowMs: 900_000 });
  });

  it('limits redemption per IP too, so token guessing is not free', () => {
    expect(AUTH_RATE_LIMITS.verifyPerIp).toEqual({ limit: 20, windowMs: 900_000 });
  });
});

describe('the sliding window', () => {
  it('allows exactly `limit` hits and reports the budget going down', () => {
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');

    expect(limiter.consumeSync({ key, policy: POLICY, now: at(0) })).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(0) }).remaining).toBe(1);
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(0) }).remaining).toBe(0);
  });

  it('refuses the fourth and says to come back in 900 seconds', () => {
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');
    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key, policy: POLICY, now: at(0) });
    }

    expect(limiter.consumeSync({ key, policy: POLICY, now: at(0) })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 900,
    });
  });

  it('counts down as the window slides — 840 seconds left one minute in', () => {
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');
    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key, policy: POLICY, now: at(0) });
    }

    // 900 000 - 60 000 = 840 000 ms.
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(60_000) }).retryAfterSeconds).toBe(840);
  });

  it('refuses a denied call the budget — a rejected request must not extend the wait', () => {
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');
    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key, policy: POLICY, now: at(0) });
    }
    limiter.consumeSync({ key, policy: POLICY, now: at(1_000) });
    limiter.consumeSync({ key, policy: POLICY, now: at(2_000) });

    // Still keyed to the ORIGINAL three hits, not to the two refusals: 900 000 -
    // 2 000 = 898 000 ms. A caller that keeps hammering must not be able to push
    // their own reset out forever — and, on a shared NAT address, must not be
    // able to push a legitimate user's out either.
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(2_000) }).retryAfterSeconds).toBe(898);
  });

  it('lets the caller back in exactly when it said it would', () => {
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');
    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key, policy: POLICY, now: at(0) });
    }

    // It answered `retryAfterSeconds: 900` at t=0, so t=900 000 must work and
    // anything before it must not. A limiter whose advice is off by one window
    // sends people away and then refuses them again when they come back.
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(899_999) }).allowed).toBe(false);
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(900_000) }).allowed).toBe(true);
  });

  it('does not let a fixed-window burst through the boundary', () => {
    // A fixed window would allow 3 at 14:59 and 3 more at 15:01 — six inside two
    // minutes. The sliding window allows one, because two of the first three are
    // still inside the trailing 15 minutes.
    const limiter = new MemoryRateLimiter();
    const key = bucketKey('auth:request:email', 'alice@example.com');
    limiter.consumeSync({ key, policy: POLICY, now: at(0) });
    limiter.consumeSync({ key, policy: POLICY, now: at(899_000) });
    limiter.consumeSync({ key, policy: POLICY, now: at(899_500) });

    // t = 900 001: only the hit at 0 has aged out.
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(900_001) }).allowed).toBe(true);
    expect(limiter.consumeSync({ key, policy: POLICY, now: at(900_002) }).allowed).toBe(false);
  });
});

describe('the two budgets are independent', () => {
  it('exhausting one address leaves another address on the same IP alone', () => {
    const limiter = new MemoryRateLimiter();
    const alice = bucketKey('auth:request:email', 'alice@example.com');
    const bob = bucketKey('auth:request:email', 'bob@example.com');

    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key: alice, policy: POLICY, now: at(0) });
    }

    expect(limiter.consumeSync({ key: alice, policy: POLICY, now: at(0) }).allowed).toBe(false);
    expect(limiter.consumeSync({ key: bob, policy: POLICY, now: at(0) }).allowed).toBe(true);
  });

  it('exhausting one IP leaves the same address from elsewhere alone', () => {
    const limiter = new MemoryRateLimiter();
    const hostile = bucketKey('auth:request:ip', '203.0.113.7');
    const home = bucketKey('auth:request:ip', '198.51.100.4');

    for (let i = 0; i < 10; i += 1) {
      limiter.consumeSync({ key: hostile, policy: AUTH_RATE_LIMITS.requestPerIp, now: at(0) });
    }

    expect(limiter.consumeSync({ key: hostile, policy: AUTH_RATE_LIMITS.requestPerIp, now: at(0) }).allowed).toBe(
      false,
    );
    expect(limiter.consumeSync({ key: home, policy: AUTH_RATE_LIMITS.requestPerIp, now: at(0) }).allowed).toBe(true);
  });

  it('never lets an email bucket and an IP bucket collide on the same subject', () => {
    // The pathological case: an address that looks like whatever the IP bucket
    // is keyed on. Different namespaces make it impossible by construction.
    const limiter = new MemoryRateLimiter();
    const asEmail = bucketKey('auth:request:email', '203.0.113.7');
    const asIp = bucketKey('auth:request:ip', '203.0.113.7');

    expect(asEmail).not.toBe(asIp);
    for (let i = 0; i < 3; i += 1) {
      limiter.consumeSync({ key: asEmail, policy: POLICY, now: at(0) });
    }
    expect(limiter.countFor(asIp)).toBe(0);
    expect(limiter.consumeSync({ key: asIp, policy: POLICY, now: at(0) }).allowed).toBe(true);
  });

  it('keeps the request and verify budgets apart', () => {
    expect(bucketKey('auth:request:ip', '203.0.113.7')).not.toBe(bucketKey('auth:verify:ip', '203.0.113.7'));
  });
});
