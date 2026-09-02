import { describe, expect, it } from 'vitest';

import { FixtureDodoTransport } from '../../src/checkout/fixture-transport.js';
import {
  CheckoutConfigError,
  createCheckoutSession,
  runStatusPath,
  successReturnUrl,
} from '../../src/checkout/session.js';
import type { DodoConfig } from '../../src/checkout/types.js';
import type { PriceTier } from '../../src/money.js';
import { TIER_SINGLE } from '../../src/money.js';
import type { SubmissionDraft } from '../../src/submission/guards.js';
import { clearanceFor } from '../helpers/clearance.js';

const NOW = new Date('2026-08-29T21:30:00.000Z');

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: 'whsec_c2VjcmV0',
  productIds: { pdt_single: 'single' },
  returnUrl: 'https://thepit.show/checkout/return',
};

const DRAFT: SubmissionDraft = {
  url: 'https://www.runlet.dev/',
  name: 'Runlet',
  description: 'A fast Rust web server for edge deploys',
  categorySlug: 'developer-tools',
};

describe('guest checkout (brief §2.1: no login at submission)', () => {
  it('opens a session from a URL, a name, a description and a tier — no account', async () => {
    const transport = new FixtureDodoTransport();
    const result = await createCheckoutSession({
      clearance: clearanceFor(DRAFT, NOW),
      tier: TIER_SINGLE,
      config: CONFIG,
      transport,
      submissionId: 'sub_1',
    });

    expect(result.session.paymentLink).toContain('https://');
    const request = transport.calls[0];
    expect(request?.productId).toBe('pdt_single');
    // The configured return URL, with this submission named on it so the buyer
    // lands on their own run rather than on a page about a payment.
    expect(request?.returnUrl).toBe(`${CONFIG.returnUrl}?submission_id=sub_1`);
    // Nothing identity-shaped crosses: no account id, no email, no session.
    expect(Object.keys(request?.metadata ?? {}).sort()).toEqual([
      'attempt_number',
      'category',
      'cycle_id',
      'description_hash',
      'normalized_url',
      'submission_id',
    ]);
  });

  it('sends only the submission id, not the description text, through Dodo', async () => {
    const transport = new FixtureDodoTransport();
    await createCheckoutSession({
      clearance: clearanceFor(DRAFT, NOW),
      tier: TIER_SINGLE,
      config: CONFIG,
      transport,
      submissionId: 'sub_1',
    });
    const values = Object.values(transport.calls[0]?.metadata ?? {});
    expect(values).toContain('sub_1');
    expect(values.join(' ')).not.toContain('Rust web server');
  });
});

describe('a double-clicked pay button opens one session', () => {
  it('returns the same session for the same purchase', async () => {
    const transport = new FixtureDodoTransport();
    const clearance = clearanceFor(DRAFT, NOW);
    const first = await createCheckoutSession({
      clearance,
      tier: TIER_SINGLE,
      config: CONFIG,
      transport,
      submissionId: 'sub_1',
    });
    const second = await createCheckoutSession({
      clearance,
      tier: TIER_SINGLE,
      config: CONFIG,
      transport,
      submissionId: 'sub_1',
    });

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(transport.calls).toHaveLength(2);
    expect(transport.sessionCount).toBe(1);
  });

  it('opens a separate session for a genuinely different tier', async () => {
    // One tier is on sale, so the second one here is a stand-in for whatever a
    // future pricing decision adds. The guarantee under test is the idempotency
    // key's, not the catalogue's: two tiers over one clearance must not collide
    // into one session, and that has to still be true on the day a tier returns.
    const transport = new FixtureDodoTransport();
    const clearance = clearanceFor(DRAFT, NOW);
    const future = { ...TIER_SINGLE, id: 'bundle', amountCents: 900 } as unknown as PriceTier;
    const config: DodoConfig = {
      ...CONFIG,
      productIds: { pdt_single: 'single', pdt_bundle: 'bundle' } as unknown as DodoConfig['productIds'],
    };
    await createCheckoutSession({ clearance, tier: TIER_SINGLE, config, transport, submissionId: 'sub_1' });
    await createCheckoutSession({ clearance, tier: future, config, transport, submissionId: 'sub_1' });
    expect(transport.sessionCount).toBe(2);
  });
});

describe('test mode (Phase 3 has no live credentials)', () => {
  it('refuses to open a live checkout without an explicit acknowledgement', async () => {
    const transport = new FixtureDodoTransport();
    await expect(
      createCheckoutSession({
        clearance: clearanceFor(DRAFT, NOW),
        tier: TIER_SINGLE,
        config: { ...CONFIG, mode: 'live' },
        transport,
        submissionId: 'sub_1',
      }),
    ).rejects.toThrow(CheckoutConfigError);
    expect(transport.calls).toHaveLength(0);
  });

  it('allows live mode once someone says so in the code', async () => {
    const transport = new FixtureDodoTransport();
    await createCheckoutSession({
      clearance: clearanceFor(DRAFT, NOW),
      tier: TIER_SINGLE,
      config: { ...CONFIG, mode: 'live' },
      transport,
      submissionId: 'sub_1',
      acknowledgeLiveMode: true,
    });
    expect(transport.calls).toHaveLength(1);
  });
});

describe('configuration mistakes fail loudly', () => {
  it('refuses to sell a tier with no Dodo product id behind it', async () => {
    const transport = new FixtureDodoTransport();
    await expect(
      createCheckoutSession({
        clearance: clearanceFor(DRAFT, NOW),
        tier: TIER_SINGLE,
        config: { ...CONFIG, productIds: {} },
        transport,
        submissionId: 'sub_1',
      }),
    ).rejects.toThrow(CheckoutConfigError);
  });
});

/**
 * The buyer comes back from Dodo to a page about a PAYMENT and has to be able to
 * reach a page about their RUN. Everything that carries them across is written
 * here, at checkout, and read on the way back — nothing in between can be asked
 * what it meant.
 */
describe('the return URL carries the run (brief Part 6)', () => {
  it('names the submission and its signature, and keeps them together', () => {
    expect(successReturnUrl('https://thepit.show/checkout/success', 'sub_1', 'sig')).toBe(
      'https://thepit.show/checkout/success?submission_id=sub_1&t=sig',
    );
  });

  it('keeps whatever query the configured return URL already had', () => {
    expect(successReturnUrl('https://thepit.show/checkout/success?src=dodo', 'sub_1')).toBe(
      'https://thepit.show/checkout/success?src=dodo&submission_id=sub_1',
    );
  });

  it('puts the token on the checkout it was minted for', async () => {
    const transport = new FixtureDodoTransport();
    await createCheckoutSession({
      clearance: clearanceFor(DRAFT, NOW),
      tier: TIER_SINGLE,
      config: CONFIG,
      transport,
      submissionId: 'sub_1',
      statusToken: 'signed-value',
    });
    expect(transport.calls[0]?.returnUrl).toBe(`${CONFIG.returnUrl}?submission_id=sub_1&t=signed-value`);
  });

  it('escapes an id that would otherwise change the path', () => {
    expect(runStatusPath('a/b?c')).toBe('/status/s/a%2Fb%3Fc');
  });
});
