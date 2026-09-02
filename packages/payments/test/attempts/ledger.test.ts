import { describe, expect, it } from 'vitest';

import { decideAttempt } from '../../src/attempts/decide.js';
import { AttemptsLedger, consumeIdempotencyKey, grantIdempotencyKey } from '../../src/attempts/ledger.js';
import type { VerdictWrite } from '../../src/attempts/types.js';
import { InsufficientAttemptsError } from '../../src/attempts/types.js';
import { TIER_SINGLE } from '../../src/money.js';
import { deliveredSoloCluster, providerTimeout } from '../helpers/outcomes.js';
import { emptyDeliveryRecord, MemoryAttemptsStore, memoryDeliveryTx } from '../helpers/stores.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');

function verdict(overrides: Partial<VerdictWrite> = {}): VerdictWrite {
  return {
    verdictId: 'vrd_1',
    listingId: 'lst_1',
    runId: 'run_1',
    accountId: 'acct_1',
    attemptNumber: 1,
    payload: { cuts: 97 },
    createdAt: NOW,
    ...overrides,
  };
}

function ledgerFor(store: MemoryAttemptsStore, record = emptyDeliveryRecord(), failOn?: Parameters<typeof memoryDeliveryTx>[2]) {
  return { ledger: new AttemptsLedger(store, memoryDeliveryTx(store, record, failOn)), record };
}

describe('grant (brief §2.2: on the signed webhook, idempotent)', () => {
  it('credits the tier’s attempts', async () => {
    const store = new MemoryAttemptsStore();
    const { ledger } = ledgerFor(store);
    const result = await ledger.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'granted', attemptsGranted: 1, balance: 1 });
  });

  it('grants nothing the second time the same provider event arrives', async () => {
    const store = new MemoryAttemptsStore();
    const { ledger } = ledgerFor(store);
    const input = {
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    };
    await ledger.grant(input);
    const replay = await ledger.grant(input);
    expect(replay).toEqual({ outcome: 'duplicate', attemptsGranted: 0, balance: 1 });
    expect(store.entryCount).toBe(1);
    expect(await ledger.balance('acct_1')).toBe(1);
  });

  it('namespaces the key so a grant and a delivery can never dedupe against each other', () => {
    expect(grantIdempotencyKey('x')).not.toBe(consumeIdempotencyKey('x'));
    expect(grantIdempotencyKey('evt_1')).toBe('dodo:event:evt_1');
    expect(consumeIdempotencyKey('run_1')).toBe('delivery:run:run_1');
  });
});

describe('an attempt is not consumed on job start (brief §2.3)', () => {
  it('leaves the ledger completely untouched', async () => {
    const store = new MemoryAttemptsStore();
    const { ledger } = ledgerFor(store);
    await ledger.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });

    const record = ledger.noteRunStarted({ runId: 'run_1', startedAt: NOW });

    expect(record.attemptsMoved).toBe(0);
    expect(await ledger.balance('acct_1')).toBe(1);
    // The balance being right is not enough: assert nothing was even attempted,
    // so a decrement-then-credit-back implementation would still fail here.
    expect(store.entryCount).toBe(1);
    expect(store.appendCalls).toHaveLength(1);
  });
});

describe('an attempt is not consumed on a failed run (brief §2.3)', () => {
  it('has no path from a free_retry decision to a ledger write', async () => {
    const store = new MemoryAttemptsStore();
    const { ledger, record } = ledgerFor(store);
    await ledger.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });

    const decision = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 0 });
    await expect(ledger.deliver({ decision, verdict: verdict(), now: NOW })).rejects.toThrow(RangeError);

    expect(await ledger.balance('acct_1')).toBe(1);
    expect(store.entryCount).toBe(1);
    expect(record.verdicts).toHaveLength(0);
  });
});

describe('deliver (brief §2.3: decrement in the same transaction as the verdict)', () => {
  async function funded() {
    const store = new MemoryAttemptsStore();
    const record = emptyDeliveryRecord();
    const ledger = new AttemptsLedger(store, memoryDeliveryTx(store, record));
    await ledger.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });
    return { store, record, ledger };
  }

  const consumeDecision = decideAttempt({ outcome: deliveredSoloCluster(), freeRetriesUsed: 0 });

  it('writes the verdict, marks it delivered, and decrements — all three', async () => {
    const { store, record, ledger } = await funded();
    const result = await ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW });

    expect(result).toEqual({ outcome: 'delivered', balance: 0, verdictId: 'vrd_1' });
    expect(record.verdicts).toHaveLength(1);
    expect(record.delivered).toEqual([{ runId: 'run_1', verdictId: 'vrd_1', deliveredAt: NOW }]);
    expect(store.entryCount).toBe(2);
  });

  it('consumes a solo-cluster delivery — the common case, not an edge case', async () => {
    const { ledger } = await funded();
    await ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW });
    expect(await ledger.balance('acct_1')).toBe(0);
  });

  it('charges once when the same run is delivered twice', async () => {
    const { store, ledger } = await funded();
    await ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW });
    const replay = await ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW });

    expect(replay.outcome).toBe('already_delivered');
    expect(await ledger.balance('acct_1')).toBe(0);
    expect(store.entryCount).toBe(2);
  });

  it('rolls the decrement back when the verdict write fails', async () => {
    const store = new MemoryAttemptsStore();
    const record = emptyDeliveryRecord();
    const good = new AttemptsLedger(store, memoryDeliveryTx(store, record));
    await good.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });

    const broken = new AttemptsLedger(store, memoryDeliveryTx(store, record, 'writeVerdict'));
    await expect(broken.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW })).rejects.toThrow();

    expect(await good.balance('acct_1')).toBe(1);
    expect(store.entryCount).toBe(1);
    expect(record.verdicts).toHaveLength(0);
  });

  it('rolls the verdict back when the decrement fails', async () => {
    const store = new MemoryAttemptsStore();
    const record = emptyDeliveryRecord();
    const good = new AttemptsLedger(store, memoryDeliveryTx(store, record));
    await good.grant({
      accountId: 'acct_1',
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: NOW,
    });

    const broken = new AttemptsLedger(store, memoryDeliveryTx(store, record, 'appendAttemptEntry'));
    await expect(broken.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW })).rejects.toThrow();

    expect(record.verdicts).toHaveLength(0);
    expect(record.delivered).toHaveLength(0);
    expect(await good.balance('acct_1')).toBe(1);
  });

  it('refuses to deliver on an account with no attempts, and writes no verdict', async () => {
    const store = new MemoryAttemptsStore();
    const record = emptyDeliveryRecord();
    const ledger = new AttemptsLedger(store, memoryDeliveryTx(store, record));

    await expect(ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW })).rejects.toThrow(
      InsufficientAttemptsError,
    );
    expect(record.verdicts).toHaveLength(0);
    expect(store.entryCount).toBe(0);
  });

  it('records who was charged and for which run', async () => {
    const { store, ledger } = await funded();
    await ledger.deliver({ decision: consumeDecision, verdict: verdict(), now: NOW });
    const consume = store.state.entries.at(-1);
    expect(consume?.delta).toBe(-1);
    expect(consume?.reason).toEqual({
      kind: 'consume',
      runId: 'run_1',
      verdictId: 'vrd_1',
      listingId: 'lst_1',
    });
  });
});
