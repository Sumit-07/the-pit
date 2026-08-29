/**
 * The success page's handover, and the backup email.
 *
 * The handover turns a payment id into a bearer URL, and a payment id is a weak
 * secret: it is in the address bar, in access logs, in analytics that record a
 * landing URL, and in the history of a shared machine. So the interesting tests
 * are the ones about the BOUND on that — the window closing, and the window
 * being measured from the order rather than from the request.
 */

import { describe, expect, it } from 'vitest';

import {
  HANDOFF_WINDOW_MS,
  MemoryRateLimiter,
  UnlimitedRateLimiter,
  AUTH_RATE_LIMITS,
  capabilityHandoff,
  capabilityIdempotencyKey,
  renderCapabilityEmail,
  type HandoffStore,
} from '../src/index.js';

const PAID_AT = new Date('2026-03-01T12:00:00.000Z');
const SLUG = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

/**
 * A store holding one order, with the age rule implemented as the interface
 * requires — inside the lookup, not left to the caller.
 */
function storeWithOrder(paymentId: string, orderedAt: Date = PAID_AT): HandoffStore {
  return {
    findCapabilityByPayment(input) {
      if (input.provider !== 'dodo' || input.providerPaymentId !== paymentId) {
        return Promise.resolve(null);
      }
      if (input.now.getTime() - orderedAt.getTime() >= input.windowMs) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ accountId: 'acct_1', email: 'payer@example.com', slug: SLUG });
    },
  };
}

const deps = (store: HandoffStore) => ({ store, limiter: new UnlimitedRateLimiter() });

describe('the handover', () => {
  it('gives the buyer their URL while they are still looking at the page', async () => {
    const result = await capabilityHandoff(
      {
        provider: 'dodo',
        paymentId: 'pay_abc123',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: new Date(PAID_AT.getTime() + 2000),
      },
      deps(storeWithOrder('pay_abc123')),
    );

    expect(result.outcome).toBe('ready');
    if (result.outcome !== 'ready') return;
    expect(result.slug).toBe(SLUG);
    expect(result.url).toBe(`https://thepit.show/a/${SLUG}`);
    expect(result.email).toBe('payer@example.com');
  });

  it('is thirty minutes, hand-derived', () => {
    expect(HANDOFF_WINDOW_MS).toBe(1_800_000);
    expect(HANDOFF_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('still works one millisecond before the window closes', async () => {
    const result = await capabilityHandoff(
      {
        provider: 'dodo',
        paymentId: 'pay_abc123',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: new Date(PAID_AT.getTime() + HANDOFF_WINDOW_MS - 1),
      },
      deps(storeWithOrder('pay_abc123')),
    );
    expect(result.outcome).toBe('ready');
  });

  it('stops revealing anything at thirty minutes exactly', async () => {
    // The boundary. A leaked log line is stale before anyone reads it.
    const result = await capabilityHandoff(
      {
        provider: 'dodo',
        paymentId: 'pay_abc123',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: new Date(PAID_AT.getTime() + HANDOFF_WINDOW_MS),
      },
      deps(storeWithOrder('pay_abc123')),
    );
    expect(result.outcome).toBe('unavailable');
  });

  it('measures the window from the order, so asking again does not restart it', async () => {
    const store = storeWithOrder('pay_abc123');
    const late = new Date(PAID_AT.getTime() + HANDOFF_WINDOW_MS + 60_000);
    // Three requests, all after the window. None of them re-opens it.
    for (let i = 0; i < 3; i += 1) {
      const result = await capabilityHandoff(
        { provider: 'dodo', paymentId: 'pay_abc123', origin: 'https://thepit.show', ip: '198.51.100.7', now: late },
        deps(store),
      );
      expect(result.outcome).toBe('unavailable');
    }
  });

  it('answers "unavailable" for an unknown payment and an expired one alike', async () => {
    // Distinguishing them would confirm that a guessed payment id was real.
    const store = storeWithOrder('pay_abc123');
    const unknown = await capabilityHandoff(
      {
        provider: 'dodo',
        paymentId: 'pay_never_existed',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: PAID_AT,
      },
      deps(store),
    );
    const expired = await capabilityHandoff(
      {
        provider: 'dodo',
        paymentId: 'pay_abc123',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: new Date(PAID_AT.getTime() + HANDOFF_WINDOW_MS),
      },
      deps(store),
    );
    expect(unknown).toEqual({ outcome: 'unavailable' });
    expect(expired).toEqual({ outcome: 'unavailable' });
  });

  it('refuses a payment id that could not be one, without touching the store', async () => {
    let touched = false;
    const store: HandoffStore = {
      findCapabilityByPayment() {
        touched = true;
        return Promise.resolve(null);
      },
    };

    for (const bad of ['', 'short', 'a'.repeat(129), 'pay abc', 'pay/../../etc', 'pay\nid']) {
      const result = await capabilityHandoff(
        { provider: 'dodo', paymentId: bad, origin: 'https://thepit.show', ip: '198.51.100.7', now: PAID_AT },
        deps(store),
      );
      expect(`${JSON.stringify(bad)}: ${result.outcome}`).toBe(`${JSON.stringify(bad)}: unavailable`);
    }
    expect(touched).toBe(false);
  });

  it('is rate limited per IP, so a leaked payment id cannot be walked', async () => {
    const store = storeWithOrder('pay_abc123');
    const limiter = new MemoryRateLimiter();
    const withLimiter = { store, limiter };

    for (let i = 0; i < AUTH_RATE_LIMITS.handoffPerIp.limit; i += 1) {
      const result = await capabilityHandoff(
        { provider: 'dodo', paymentId: 'pay_guess', origin: 'https://thepit.show', ip: '192.0.2.4', now: PAID_AT },
        withLimiter,
      );
      expect(result.outcome).toBe('unavailable');
    }
    const blocked = await capabilityHandoff(
      { provider: 'dodo', paymentId: 'pay_guess', origin: 'https://thepit.show', ip: '192.0.2.4', now: PAID_AT },
      withLimiter,
    );
    expect(blocked.outcome).toBe('rate_limited');
  });

  it('keys on the provider, so two processors cannot share a payment-id space', async () => {
    const result = await capabilityHandoff(
      {
        provider: 'somebody_else',
        paymentId: 'pay_abc123',
        origin: 'https://thepit.show',
        ip: '198.51.100.7',
        now: PAID_AT,
      },
      deps(storeWithOrder('pay_abc123')),
    );
    expect(result.outcome).toBe('unavailable');
  });
});

describe('the backup email', () => {
  const url = `https://thepit.show/a/${SLUG}`;

  it('carries the URL in both bodies, and says it is a backup', () => {
    const message = renderCapabilityEmail({
      email: 'payer@example.com',
      from: 'The Pit <no-reply@thepit.show>',
      url,
      accountId: 'acct_1',
    });

    expect(message.to).toBe('payer@example.com');
    expect(message.text).toContain(url);
    expect(message.html).toContain(url);
    // A text/plain alternative is not politeness — a message without one scores
    // worse with spam filters, and the domain's reputation is what stands
    // between this and a junk folder.
    expect(message.text.length).toBeGreaterThan(0);
    // The copy says the customer has already seen this, so a message that never
    // arrives has cost them nothing.
    expect(message.text).toContain('the same link the page showed you after payment'.slice(0, 20));
  });

  it('mentions rotation, which is the only revocation the URL has', () => {
    const message = renderCapabilityEmail({
      email: 'payer@example.com',
      from: 'The Pit <no-reply@thepit.show>',
      url,
      accountId: 'acct_1',
    });
    expect(message.text.toLowerCase()).toContain('rotate');
    expect(message.html.toLowerCase()).toContain('rotate');
  });

  it('says the verdict page is public and separate', () => {
    // `brief` Part 6: verdict URLs are public and must never be gated. A
    // customer who thinks this link is needed to share their verdict will not
    // share it.
    const message = renderCapabilityEmail({
      email: 'payer@example.com',
      from: 'The Pit <no-reply@thepit.show>',
      url,
      accountId: 'acct_1',
    });
    expect(message.text).toContain('verdict page is public');
  });

  it('never puts the slug in the idempotency key', () => {
    // The key is displayed in provider dashboards, delivery logs and bounce
    // reports. None of those should be a place to read an account URL from.
    const key = capabilityIdempotencyKey('acct_1', url);
    expect(key).not.toContain(SLUG);
    expect(key).toMatch(/^capability:[0-9a-f]{32}$/);
    expect(
      renderCapabilityEmail({ email: 'p@example.com', from: 'x <x@y.com>', url, accountId: 'acct_1' }).idempotencyKey,
    ).toBe(key);
  });

  it('changes the key when the slug rotates, so the resend is not suppressed', () => {
    const rotated = `https://thepit.show/a/${'_'.repeat(42)}8`;
    expect(capabilityIdempotencyKey('acct_1', url)).not.toBe(capabilityIdempotencyKey('acct_1', rotated));
  });

  it('escapes the URL into the HTML body', () => {
    // The origin is configurable per environment, which is where "nothing needs
    // escaping today" stops being true.
    const message = renderCapabilityEmail({
      email: 'payer@example.com',
      from: 'The Pit <no-reply@thepit.show>',
      url: 'https://thepit.show/a/x?a=1&b="><script>alert(1)</script>',
      accountId: 'acct_1',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&amp;');
  });
});
