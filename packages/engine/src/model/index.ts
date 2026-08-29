/**
 * The engine's one model seam (`docs/plans/phase-1-engine.md` Task 5).
 *
 * Every model call in the engine goes through `ModelClient`. Two adapters
 * implement it: `AnthropicClient` for the Messages API and `FixtureClient` for
 * tests, which run with no network and no API key (Global Constraint 5).
 *
 * Nothing here orchestrates. Phase sequencing, parallel fan-out, retries and the
 * cost ledger are Task 7's; this module classifies a failure as retryable and
 * stops there.
 */

export { AnthropicClient, buildMessageParams, extractToolOutput, toTokenUsage } from './anthropic-client.js';
export type { FixtureResponse, FixtureScript } from './fixture-client.js';
export { FixtureClient, FixtureExhaustedError, ZERO_USAGE } from './fixture-client.js';
export { MODEL_IDS, resolveModelId, supportsEffort } from './model-ids.js';
export type { Effort, ModelClient, ModelRequest, ModelResponse, ModelTier, TokenUsage } from './types.js';
export { ModelCallError } from './types.js';
