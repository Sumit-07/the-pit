import { describe, expect, it } from 'vitest';

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_ID_HAIKU,
  MODEL_ID_SONNET,
  MODEL_CLUSTER,
  MODEL_JUROR,
  PRICE_HAIKU_INPUT,
  PRICE_HAIKU_OUTPUT,
  PRICE_SONNET_INPUT,
  PRICE_SONNET_OUTPUT,
} from '../../src/config/constants.js';
import { ZERO_USAGE } from '../../src/model/fixture-client.js';
import { buildLedger, callCost, MODEL_PRICES, PhaseLedger, tierPrices, zeroCost } from '../../src/run/ledger.js';

/**
 * The ledger is the only place in the engine that turns tokens into dollars, and
 * Task 8's whole cost projection — and `brief` Part 7's $17-25/month inference
 * line — is computed off it.
 */

const usage = (partial: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...partial });

describe('MODEL_PRICES', () => {
  it('derives the cache rates from the published multipliers, so the two cannot drift', () => {
    expect(MODEL_PRICES[MODEL_ID_HAIKU]?.cache_write).toBeCloseTo(PRICE_HAIKU_INPUT * CACHE_WRITE_MULTIPLIER, 12);
    expect(MODEL_PRICES[MODEL_ID_HAIKU]?.cache_read).toBeCloseTo(PRICE_HAIKU_INPUT * CACHE_READ_MULTIPLIER, 12);
    expect(MODEL_PRICES[MODEL_ID_SONNET]?.cache_write).toBeCloseTo(PRICE_SONNET_INPUT * CACHE_WRITE_MULTIPLIER, 12);
    expect(MODEL_PRICES[MODEL_ID_SONNET]?.cache_read).toBeCloseTo(PRICE_SONNET_INPUT * CACHE_READ_MULTIPLIER, 12);
  });

  it('covers every id the tier map can resolve to', () => {
    expect(tierPrices(MODEL_JUROR).input).toBe(PRICE_HAIKU_INPUT);
    expect(tierPrices(MODEL_JUROR).output).toBe(PRICE_HAIKU_OUTPUT);
    expect(tierPrices(MODEL_CLUSTER).input).toBe(PRICE_SONNET_INPUT);
    expect(tierPrices(MODEL_CLUSTER).output).toBe(PRICE_SONNET_OUTPUT);
  });
});

describe('callCost', () => {
  it('prices a million input tokens at exactly the table rate', () => {
    expect(callCost(MODEL_ID_HAIKU, usage({ input_tokens: 1_000_000 }))).toBeCloseTo(PRICE_HAIKU_INPUT, 12);
    expect(callCost(MODEL_ID_SONNET, usage({ output_tokens: 1_000_000 }))).toBeCloseTo(PRICE_SONNET_OUTPUT, 12);
  });

  it('makes a cache read ten times cheaper than the same tokens uncached', () => {
    const cached = callCost(MODEL_ID_HAIKU, usage({ cache_read_input_tokens: 1_000_000 }));
    const uncached = callCost(MODEL_ID_HAIKU, usage({ input_tokens: 1_000_000 }));
    expect(cached).toBeCloseTo(uncached * CACHE_READ_MULTIPLIER, 12);
    // Which is the whole reason Task 7 warns when `cache_read_input_tokens` is 0.
    expect(cached).toBeLessThan(uncached);
  });

  it('prices an unpriced model at zero rather than throwing away a paid run', () => {
    // Task 9's handoff responder reports no usage and no known model id. A throw
    // here would lose the result of work that has already been done.
    expect(callCost('some-future-model', usage({ input_tokens: 1000 }))).toBe(0);
  });
});

describe('PhaseLedger', () => {
  it('sums tokens and dollars across calls', () => {
    const ledger = new PhaseLedger();
    ledger.record(MODEL_ID_HAIKU, usage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 }));
    ledger.record(MODEL_ID_HAIKU, usage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 }));

    const total = ledger.total();
    expect(total.calls).toBe(2);
    expect(total.usage.input_tokens).toBe(2000);
    expect(total.usage.output_tokens).toBe(400);
    expect(total.usage.cache_read_input_tokens).toBe(1600);
    expect(total.cost_usd).toBeCloseTo(
      2 * ((1000 * PRICE_HAIKU_INPUT + 200 * PRICE_HAIKU_OUTPUT + 800 * PRICE_HAIKU_INPUT * CACHE_READ_MULTIPLIER) / 1e6),
      12,
    );
  });

  it('counts a failed call as a call, because it was still billed for its input', () => {
    const ledger = new PhaseLedger();
    ledger.recordFailedCall();
    expect(ledger.total().calls).toBe(1);
    expect(ledger.total().cost_usd).toBe(0);
  });

  it('names unpriced models so a total can say it is incomplete', () => {
    const ledger = new PhaseLedger();
    ledger.record('local-subagent', usage({}));
    expect(ledger.unpricedModels).toEqual(['local-subagent']);
  });
});

describe('buildLedger', () => {
  it('totals the three phases', () => {
    const phase = (calls: number, cost: number) => ({ calls, usage: { ...ZERO_USAGE, input_tokens: 10 }, cost_usd: cost });
    const ledger = buildLedger({ score: phase(6, 0.1), uniqueness: phase(1, 0.05), customer: phase(4, 0.2) });

    expect(ledger.total.calls).toBe(11);
    expect(ledger.total.usage.input_tokens).toBe(30);
    expect(ledger.total.cost_usd).toBeCloseTo(0.35, 12);
  });

  it('starts from an empty cost', () => {
    expect(zeroCost()).toEqual({ calls: 0, usage: { ...ZERO_USAGE }, cost_usd: 0 });
  });
});
