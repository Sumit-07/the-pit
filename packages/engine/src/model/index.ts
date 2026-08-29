/**
 * The engine's one model seam (`docs/plans/phase-1-engine.md` Task 5).
 *
 * Every model call in the engine goes through `ModelClient`. Three adapters
 * implement it: `AnthropicClient` for the Messages API, `FixtureClient` for
 * tests, which run with no network and no API key (Global Constraint 5), and
 * `HandoffClient` (Task 9), which writes each would-be request to a file and
 * reads back an answer a local Claude Code subagent wrote — `01 §1`'s keyless
 * path, made repeatable.
 *
 * Nothing here orchestrates. Phase sequencing, parallel fan-out, retries and the
 * cost ledger are Task 7's; this module classifies a failure as retryable and
 * stops there.
 */

export { AnthropicClient, buildMessageParams, extractToolOutput, toTokenUsage } from './anthropic-client.js';
export type {
  EmittedRequest,
  HandoffCall,
  HandoffClientOptions,
  HandoffExpectation,
  HandoffPendingReason,
  HandoffPlan,
  HandoffRequestFile,
  HandoffResponseFile,
  HandoffRound,
} from './handoff-client.js';
export {
  buildRequestFile,
  fileExists,
  HANDOFF_FILE_VERSION,
  HandoffClient,
  HandoffPendingError,
  HandoffResponseError,
  LOCAL_SEEDING_CAVEAT,
  LOCAL_SUBAGENT_SEEDING,
  PHASES_IN_ROUND,
  phaseForTool,
  ROUND_OF_PHASE,
  roundDir,
  sameRequest,
  unwrapResponse,
  validateAgainst,
} from './handoff-client.js';
export type { FixtureResponse, FixtureScript } from './fixture-client.js';
export { FixtureClient, FixtureExhaustedError, ZERO_USAGE } from './fixture-client.js';
export { MODEL_IDS, resolveModelId, supportsEffort } from './model-ids.js';
export type {
  Effort,
  ModelCallErrorCode,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelTier,
  TokenUsage,
} from './types.js';
export { ModelCallError } from './types.js';
