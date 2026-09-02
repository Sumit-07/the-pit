import { describe, expect, it } from 'vitest';

import {
  formatUsd,
  PRICE_TIERS,
  netProceedsCents,
  providerFeeCents,
  PURCHASE_TERMS,
  TIER_SINGLE,
  tierForPayment,
} from '../src/money.js';

describe('provider fee (brief §2.2: assume 5.5% + $0.40)', () => {
  it('takes $0.68 on a $5 sale, which is the figure brief Part 7 books', () => {
    // 500 * 550 / 10000 = 27.5, rounded half up = 28, plus the 40c flat = 68.
    expect(providerFeeCents(500)).toBe(68);
    expect(netProceedsCents(500)).toBe(432);
  });

  it('takes $1.23 on a $15 sale, whether or not one tier costs that', () => {
    // 1500 * 550 / 10000 = 82.5 -> 83, plus 40 = 123. The arithmetic is priced in
    // cents, not in tiers, and must stay right for an amount nothing sells for.
    expect(providerFeeCents(1500)).toBe(123);
    expect(netProceedsCents(1500)).toBe(1377);
  });

  it('rounds the half cent up, toward Dodo, never toward us', () => {
    // 100 * 550 / 10000 = 5.5 -> 6, not 5. An optimistic model is worse than none.
    expect(providerFeeCents(100)).toBe(46);
  });

  it('charges nothing on nothing', () => {
    expect(providerFeeCents(0)).toBe(0);
  });

  it('never reports a negative deposit when the flat fee exceeds the payment', () => {
    expect(netProceedsCents(10)).toBe(0);
  });

  it('refuses fractional cents rather than silently rounding an input', () => {
    expect(() => providerFeeCents(500.5)).toThrow(/whole cents/);
  });
});

describe('formatUsd', () => {
  it('pads the cents', () => {
    expect(formatUsd(500)).toBe('$5.00');
    expect(formatUsd(1377)).toBe('$13.77');
    expect(formatUsd(5)).toBe('$0.05');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('tiers (brief §2.3: $5 = 1 attempt)', () => {
  it('prices the one tier and nothing else', () => {
    expect(PRICE_TIERS).toEqual([TIER_SINGLE]);
    expect(TIER_SINGLE.amountCents).toBe(500);
    expect(TIER_SINGLE.attempts).toBe(1);
  });

  it('sells no fit report, because nothing here produces one', () => {
    expect(PRICE_TIERS.some((tier) => tier.fitReport)).toBe(false);
    expect(PRICE_TIERS.map((tier) => tier.label).join(' ')).not.toMatch(/fit report/i);
  });

  it('maps a settled $5 payment to one attempt', () => {
    expect(tierForPayment({ amountCents: 500, currency: 'USD' })).toBe(TIER_SINGLE);
  });

  it('accepts a lowercase currency code', () => {
    expect(tierForPayment({ amountCents: 500, currency: 'usd' })).toBe(TIER_SINGLE);
  });

  it('prices no $15 payment, now that the tier that cost that is withdrawn', () => {
    // Not zero attempts and not one: `null`, which the webhook turns into a
    // review queue entry. A $15 payment against a one-tier catalogue is a fact
    // about the world that somebody has to look at.
    expect(tierForPayment({ amountCents: 1500, currency: 'USD' })).toBeNull();
  });

  it('refuses to invent attempts for an amount it does not price', () => {
    // The tempting bug is `Math.floor(amountCents / 500)`, which would grant 2
    // here and would turn any future discount code into free attempts.
    expect(tierForPayment({ amountCents: 1000, currency: 'USD' })).toBeNull();
    expect(tierForPayment({ amountCents: 499, currency: 'USD' })).toBeNull();
    expect(tierForPayment({ amountCents: 5000, currency: 'USD' })).toBeNull();
  });

  it('refuses a currency it does not price rather than treating cents as cents', () => {
    expect(tierForPayment({ amountCents: 500, currency: 'EUR' })).toBeNull();
  });

  it('prefers the Dodo product id over the amount, so a discounted throw still grants one', () => {
    expect(
      tierForPayment({ amountCents: 300, currency: 'USD', productId: 'pdt_single' }, { pdt_single: 'single' }),
    ).toBe(TIER_SINGLE);
  });

  it('falls back to the amount when the product id is not mapped', () => {
    expect(tierForPayment({ amountCents: 500, currency: 'USD', productId: 'pdt_unknown' }, {})).toBe(TIER_SINGLE);
  });
});

describe('purchase page terms (brief §2.3)', () => {
  it('states that disliking the result is not a failure', () => {
    expect(PURCHASE_TERMS.some((line) => /disliking the result is not a failure/i.test(line))).toBe(true);
  });

  it('states that a re-pitch replaces rather than keeps the better score', () => {
    expect(PURCHASE_TERMS.some((line) => /never keep/i.test(line))).toBe(true);
  });

  it('states that attempts never expire', () => {
    expect(PURCHASE_TERMS.some((line) => /never expire/i.test(line))).toBe(true);
  });
});
