/**
 * The cost ledger — what a run actually spent, per phase, in tokens and dollars.
 *
 * `01 §7.3` models cost as a CALL COUNT (`5 x chunks + 1 + personas`) and never
 * prices a token, which was fine when the panels were local subagents. On the
 * Messages API a call's price depends on the model tier, on how much of the
 * prompt was cached, and on how long the answer ran, so the call count alone
 * cannot answer the question Phase 1 has to answer: does the whole 28-category
 * rebuild fit inside `brief` Part 7's $17-25/month inference line.
 *
 * Global Constraint 8 requires reporting actual tokens and cost after any task
 * that spends. This is the machinery that makes that possible for Task 8's
 * report, and its numbers are MEASURED — summed from `usage` on real responses —
 * as distinct from the dry-run projection, which is estimated. Task 9's
 * `HandoffClient` will report some calls as `unmeasured`; the ledger's `calls`
 * count stays truthful there even when the token counts are zero, which is what
 * lets that task's report say which figures are measured and which are not.
 *
 * No arithmetic here touches a rank (Global Constraint 1).
 */

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_ID_HAIKU,
  MODEL_ID_SONNET,
  PRICE_HAIKU_INPUT,
  PRICE_HAIKU_OUTPUT,
  PRICE_SONNET_INPUT,
  PRICE_SONNET_OUTPUT,
  TOKENS_PER_PRICE_UNIT,
} from '../config/constants.js';
import { ZERO_USAGE } from '../model/fixture-client.js';
import { resolveModelId } from '../model/model-ids.js';
import type { ModelTier, TokenUsage } from '../model/types.js';
import type { CostLedger, PhaseCost, PhaseName } from './types.js';

/** USD per million tokens for one model id, by usage kind. */
export interface ModelPrices {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/**
 * Prices keyed by the API id that actually answered, not by tier.
 *
 * By id because that is what the response reports: `ModelResponse.model` is the
 * id the API says served the call, so pricing off it survives a tier being
 * repointed in `model-ids.ts` and survives the API resolving an alias to
 * something else. Pricing off the tier would keep quoting the old model's rates
 * after a swap, silently, with no test failing.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrices>> = Object.freeze({
  [MODEL_ID_HAIKU]: pricesFor(PRICE_HAIKU_INPUT, PRICE_HAIKU_OUTPUT),
  [MODEL_ID_SONNET]: pricesFor(PRICE_SONNET_INPUT, PRICE_SONNET_OUTPUT),
});

/** Cache rates are the published multipliers on the model's own input rate. */
function pricesFor(input: number, output: number): ModelPrices {
  return {
    input,
    output,
    cache_write: input * CACHE_WRITE_MULTIPLIER,
    cache_read: input * CACHE_READ_MULTIPLIER,
  };
}

/**
 * What one call cost, in dollars.
 *
 * An unpriced model id costs 0 rather than throwing. A call has already been paid
 * for by the time it reaches here, so throwing would lose the result of a paid
 * run over a bookkeeping gap; `unpricedModels` is how a caller learns the total
 * is short, and Task 9's handoff responder — which reports no usage at all — is
 * the case this exists for.
 */
export function callCost(modelId: string, usage: TokenUsage): number {
  const prices = MODEL_PRICES[modelId];
  if (prices === undefined) return 0;

  return (
    (usage.input_tokens * prices.input +
      usage.output_tokens * prices.output +
      usage.cache_creation_input_tokens * prices.cache_write +
      usage.cache_read_input_tokens * prices.cache_read) /
    TOKENS_PER_PRICE_UNIT
  );
}

/** The tier a phase runs on, for the dry-run projection, which has no response to read. */
export function tierPrices(tier: ModelTier): ModelPrices {
  const prices = MODEL_PRICES[resolveModelId(tier)];
  // Unreachable while `MODEL_PRICES` covers every id `MODEL_IDS` can produce;
  // checked because a silent zero would understate a projected budget.
  if (prices === undefined) throw new Error(`tierPrices: no price for model tier ${JSON.stringify(tier)}`);
  return prices;
}

/** An empty cost: no calls, no tokens, no dollars. */
export function zeroCost(): PhaseCost {
  return { calls: 0, usage: { ...ZERO_USAGE }, cost_usd: 0 };
}

/**
 * Accumulates one phase's spend. Every call is recorded, including calls that
 * failed — a rate-limited request that returned nothing was still billed for its
 * input, and a ledger that hid that would understate the cost of exactly the runs
 * that cost the most.
 */
export class PhaseLedger {
  private calls = 0;
  private readonly usage: TokenUsage = { ...ZERO_USAGE };
  private cost = 0;
  private readonly unpriced = new Set<string>();

  /** Record one completed call. `modelId` is the id the response reported. */
  record(modelId: string, usage: TokenUsage): void {
    this.calls += 1;
    this.usage.input_tokens += usage.input_tokens;
    this.usage.output_tokens += usage.output_tokens;
    this.usage.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    this.usage.cache_read_input_tokens += usage.cache_read_input_tokens;
    this.cost += callCost(modelId, usage);
    if (MODEL_PRICES[modelId] === undefined) this.unpriced.add(modelId);
  }

  /** Record a call that failed before returning a usage figure. Still a call. */
  recordFailedCall(): void {
    this.calls += 1;
  }

  /** Model ids seen that carry no price, so a caller can say the total is incomplete. */
  get unpricedModels(): readonly string[] {
    return [...this.unpriced];
  }

  total(): PhaseCost {
    return { calls: this.calls, usage: { ...this.usage }, cost_usd: this.cost };
  }
}

/** Sum phase costs into the ledger written to `results.json.meta`. */
export function buildLedger(phases: Record<PhaseName, PhaseCost>): CostLedger {
  const total = zeroCost();
  for (const cost of Object.values(phases)) {
    total.calls += cost.calls;
    total.usage.input_tokens += cost.usage.input_tokens;
    total.usage.output_tokens += cost.usage.output_tokens;
    total.usage.cache_creation_input_tokens += cost.usage.cache_creation_input_tokens;
    total.usage.cache_read_input_tokens += cost.usage.cache_read_input_tokens;
    total.cost_usd += cost.cost_usd;
  }
  return { phases, total };
}
