import { describe, expect, it } from 'vitest';

import { FixtureDodoTransport } from '../../src/checkout/fixture-transport.js';
import { CheckoutConfigError, createCheckoutSession } from '../../src/checkout/session.js';
import type { DodoConfig } from '../../src/checkout/types.js';
import { TIER_SINGLE, TIER_TRIPLE } from '../../src/money.js';
import type { SubmissionDraft } from '../../src/submission/guards.js';
import { clearanceFor } from '../helpers/clearance.js';

const NOW = new Date('2026-08-29T21:30:00.000Z');

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: 'whsec_c2VjcmV0',
  productIds: { pdt_single: 'single', pdt_triple: 'triple' },
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
    expect(request?.returnUrl).toBe(CONFIG.returnUrl);
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
    const transport = new FixtureDodoTransport();
    const clearance = clearanceFor(DRAFT, NOW);
    await createCheckoutSession({ clearance, tier: TIER_SINGLE, config: CONFIG, transport, submissionId: 'sub_1' });
    await createCheckoutSession({ clearance, tier: TIER_TRIPLE, config: CONFIG, transport, submissionId: 'sub_1' });
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
        tier: TIER_TRIPLE,
        config: { ...CONFIG, productIds: { pdt_single: 'single' } },
        transport,
        submissionId: 'sub_1',
      }),
    ).rejects.toThrow(CheckoutConfigError);
  });
});
