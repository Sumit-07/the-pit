import { describe, expect, it } from 'vitest';

import { AttemptsLedger } from '../../src/attempts/ledger.js';
import { resolveSuccessRedirect } from '../../src/checkout/session.js';
import { HEADER_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, signWebhook } from '../../src/checkout/signature.js';
import type { DodoConfig } from '../../src/checkout/types.js';
import { handleDodoWebhook } from '../../src/checkout/webhook.js';
import { emptyDeliveryRecord, MemoryAttemptsStore, MemoryWebhookStore, memoryDeliveryTx } from '../helpers/stores.js';

const SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItdGVzdGluZw==';
const NOW = new Date('2026-08-29T12:00:00.000Z');

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: SECRET,
  productIds: { pdt_single: 'single' },
  returnUrl: 'https://thepit.show/checkout/return',
};

interface EventOverrides {
  id?: string;
  type?: string;
  amount?: number;
  currency?: string;
  productId?: string;
  email?: string;
  paymentId?: string;
}

function body(overrides: EventOverrides = {}): string {
  return JSON.stringify({
    id: overrides.id ?? 'evt_1',
    type: overrides.type ?? 'payment.succeeded',
    created_at: NOW.toISOString(),
    data: {
      payment_id: overrides.paymentId ?? 'pay_1',
      total_amount: overrides.amount ?? 500,
      currency: overrides.currency ?? 'USD',
      product_id: overrides.productId ?? 'pdt_single',
      customer: { email: overrides.email ?? 'founder@example.com' },
      metadata: { submission_id: 'sub_1' },
    },
  });
}

function signed(rawBody: string, messageId = 'msg_1'): Record<string, string> {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  return {
    [HEADER_ID]: messageId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_SIGNATURE]: `v1,${signWebhook({ id: messageId, timestamp, rawBody, secret: SECRET })}`,
  };
}

function harness() {
  const attempts = new MemoryAttemptsStore();
  const ledger = new AttemptsLedger(attempts, memoryDeliveryTx(attempts, emptyDeliveryRecord()));
  const store = new MemoryWebhookStore();
  return { attempts, ledger, store };
}

describe('grant on the signed webhook (brief §2.2)', () => {
  it('creates the account from the email Dodo verified and grants the tier', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body();
    const result = await handleDodoWebhook({
      rawBody: raw,
      headers: signed(raw),
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });

    expect(result.status).toBe('granted');
    expect(result.httpStatus).toBe(200);
    expect(result.status === 'granted' ? result.attemptsGranted : 0).toBe(1);
    expect(result.status === 'granted' ? result.accountCreated : false).toBe(true);
    expect(store.accounts.get('founder@example.com')).toBeDefined();
    expect(attempts.entryCount).toBe(1);
  });

  it('grants nothing on the withdrawn $15 tier and sends it for review', async () => {
    // The tier that cost $15 bundled a fit report nothing here produces, so it is
    // no longer sold. A payment at that amount is therefore an amount we do not
    // price: `needs_review`, not three attempts, and not one either.
    const { attempts, ledger, store } = harness();
    const raw = body({ amount: 1500, productId: 'pdt_triple' });
    const result = await handleDodoWebhook({
      rawBody: raw,
      headers: signed(raw),
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });
    expect(result.status).toBe('needs_review');
    expect(attempts.entryCount).toBe(0);
  });
});

describe('a replayed webhook grants nothing the second time (brief §2.2: Dodo retries)', () => {
  it('is idempotent on the provider event id', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body();
    const headers = signed(raw);

    const first = await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    const second = await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    const third = await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });

    expect(first.status).toBe('granted');
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');
    expect(second.status === 'duplicate' ? second.attemptsGranted : -1).toBe(0);
    // The balance is the assertion that matters, and the entry count is the one
    // that catches a "decrement then re-add" style fix.
    expect(await ledger.balance('acct_1')).toBe(1);
    expect(attempts.entryCount).toBe(1);
  });

  it('still answers 200 on a replay, so Dodo stops retrying', async () => {
    const { ledger, store } = harness();
    const raw = body();
    const headers = signed(raw);
    await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    const replay = await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    expect(replay.httpStatus).toBe(200);
  });
});

describe('unverifiable requests never reach the ledger', () => {
  it('rejects an unsigned body with 400 so the retries keep coming', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body();
    const result = await handleDodoWebhook({ rawBody: raw, headers: {}, config: CONFIG, ledger, store, now: NOW });

    expect(result.status).toBe('rejected');
    expect(result.httpStatus).toBe(400);
    expect(attempts.entryCount).toBe(0);
    expect(store.accounts.size).toBe(0);
  });

  it('rejects a body edited after signing, even when the amount is the only change', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body();
    const headers = signed(raw);
    const tampered = body({ amount: 1500, productId: 'pdt_bundle' });

    const result = await handleDodoWebhook({
      rawBody: tampered,
      headers,
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });
    expect(result.status).toBe('rejected');
    expect(attempts.entryCount).toBe(0);
  });

  it('rejects an unparseable body with 400 rather than swallowing it as a 200', async () => {
    const { ledger, store } = harness();
    const raw = '{"id":"evt_1"';
    const result = await handleDodoWebhook({
      rawBody: raw,
      headers: signed(raw),
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'rejected', httpStatus: 400 });
  });
});

describe('events that are not a settled payment', () => {
  it('ignores a failed payment without granting', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body({ type: 'payment.failed', id: 'evt_2' });
    const result = await handleDodoWebhook({
      rawBody: raw,
      headers: signed(raw),
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });
    expect(result.status).toBe('ignored');
    expect(result.httpStatus).toBe(200);
    expect(attempts.entryCount).toBe(0);
  });

  it('sends a refund to a human rather than clawing back automatically', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body({ type: 'refund.succeeded', id: 'evt_3' });
    await handleDodoWebhook({ rawBody: raw, headers: signed(raw), config: CONFIG, ledger, store, now: NOW });
    expect(store.reviewQueue.map((entry) => entry.reason)).toEqual(['refund.succeeded']);
    expect(attempts.entryCount).toBe(0);
  });

  it('files a refund ticket once even when the event is retried', async () => {
    const { ledger, store } = harness();
    const raw = body({ type: 'dispute.opened', id: 'evt_4' });
    const headers = signed(raw);
    await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    await handleDodoWebhook({ rawBody: raw, headers, config: CONFIG, ledger, store, now: NOW });
    expect(store.reviewQueue).toHaveLength(1);
  });
});

describe('an amount we do not price', () => {
  it('goes to review and grants nothing, rather than dividing by 500', async () => {
    const { attempts, ledger, store } = harness();
    const raw = body({ amount: 1000, productId: 'pdt_promo', id: 'evt_5' });
    const result = await handleDodoWebhook({
      rawBody: raw,
      headers: signed(raw),
      config: CONFIG,
      ledger,
      store,
      now: NOW,
    });

    expect(result.status).toBe('needs_review');
    expect(result.httpStatus).toBe(200);
    expect(attempts.entryCount).toBe(0);
    expect(store.reviewQueue).toHaveLength(1);
  });
});

describe('the success redirect grants nothing (brief §2.2)', () => {
  it('reports provisioning and no attempts', () => {
    expect(resolveSuccessRedirect({ submission_id: 'sub_1' })).toEqual({
      status: 'provisioning',
      submissionId: 'sub_1',
      message: expect.stringContaining('Payment received'),
      attemptsGranted: 0,
      // A path, and only a path. Whether it opens anything is decided by the
      // status route, against a signature this function cannot make.
      statusPath: '/status/s/sub_1',
    });
  });

  it('carries the submission id and its signature into one forward path', () => {
    const view = resolveSuccessRedirect({ submission_id: 'sub_1', t: 'sig', payment_id: 'pay_1' });
    expect(view.submissionId).toBe('sub_1');
    expect(view.statusPath).toBe('/status/s/sub_1?t=sig');
  });

  it('has nowhere to send a buyer whose return URL named no submission', () => {
    expect(resolveSuccessRedirect({ payment_id: 'pay_1' }).statusPath).toBeNull();
  });

  it('cannot grant, because it is handed nothing that could', () => {
    // A regression that made the redirect grant attempts would have to add a
    // parameter first: the function takes only a query string map.
    expect(resolveSuccessRedirect.length).toBe(1);
  });

  it('ignores query parameters that claim a payment succeeded', () => {
    const view = resolveSuccessRedirect({
      submission_id: 'sub_1',
      status: 'succeeded',
      attempts: '3',
      amount: '1500',
    });
    expect(view.attemptsGranted).toBe(0);
    expect(view.status).toBe('provisioning');
  });
});
