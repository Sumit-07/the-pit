/**
 * The seam every model call in the engine goes through.
 *
 * Global Constraint 5 (`docs/plans/phase-1-engine.md`): every model call goes
 * through `ModelClient`, tests use the fixture adapter, and `pnpm test` passes
 * with no network and no environment variables. Nothing below imports the
 * Anthropic client itself — only its request/response *types*, which are
 * type-only imports and therefore erased at build time. `FixtureClient` and the
 * whole prompt layer are usable without the SDK ever being constructed.
 *
 * Global Constraint 1: a `ModelResponse` never carries a rank. It carries the
 * raw JSON a panel returned; ranking arithmetic reads stored rows afterwards.
 */

import type Anthropic from '@anthropic-ai/sdk';

import type { MODEL_CLUSTER, MODEL_JUROR, MODEL_PERSONA } from '../config/constants.js';

/**
 * A logical model tier, not an API id. The frozen constants (`MODEL_JUROR`,
 * `MODEL_CLUSTER`, `MODEL_PERSONA`) name tiers so a model swap is a change to
 * one map (`src/model/model-ids.ts`) rather than to every call site — which is
 * exactly what `01 §7.2`'s `cfg.model` / `cfg.clusterModel` / `cfg.personaModel`
 * indirection exists for.
 *
 * Derived from the constants so that changing a tier name there is a type error
 * here rather than a silent mismatch.
 */
export type ModelTier = typeof MODEL_JUROR | typeof MODEL_CLUSTER | typeof MODEL_PERSONA;

/**
 * `output_config.effort`. Only sent where the model supports it — see the
 * divergence note on `buildMessageParams` in `src/model/anthropic-client.ts`.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What one call cost, in tokens. The four numbers Task 7's cost ledger needs and
 * the two (`cache_*`) that say whether the cache breakpoints are working at all:
 * `cache_read_input_tokens` staying at zero across calls that share a prefix is
 * the signal that something is invalidating it.
 *
 * The API returns `null` for the cache fields when nothing was cached; this
 * normalizes those to 0 so a ledger can sum without guarding every entry.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * One structured-output call.
 *
 * `system` is an ordered list of blocks rather than a single string because the
 * cache breakpoint has to sit *between* two pieces of the prompt: prompt caching
 * is a prefix match rendered `tools` -> `system` -> `messages`, so the stable
 * part must be earlier blocks and the volatile part must come after. The prompt
 * builders in `src/panels/prompts/` produce the blocks and name the index; the
 * adapter is what turns that index into `cache_control`.
 */
export interface ModelRequest {
  /** Tier, resolved to an API id by the adapter. */
  model: ModelTier;
  /**
   * System blocks, in render order. Blocks must not carry `cache_control` of
   * their own — `cacheBreakpoint` is the only way to place one, so that a prompt
   * builder cannot quietly place a breakpoint the request shape does not declare.
   */
  system: readonly Anthropic.TextBlockParam[];
  /** Conversation turns. Volatile, per-call content belongs here. */
  messages: readonly Anthropic.MessageParam[];
  /** Tool definitions. Exactly one is expected in practice; see `toolName`. */
  tools: readonly Anthropic.Tool[];
  /**
   * The tool whose input is the answer. The adapter forces it with
   * `tool_choice` and returns that block's `input` as `output`.
   */
  toolName: string;
  /** Required by the API. Never lowballed — see the `MAX_TOKENS_*` constants. */
  maxTokens: number;
  /**
   * `output_config.effort`, when the target model supports it. Omitted entirely
   * for jurors; see the divergence note in `src/model/anthropic-client.ts`.
   */
  effort?: Effort;
  /**
   * Index into `system` of the LAST block covered by the cache prefix. Omit for
   * no caching. Everything up to and including that block must be byte-identical
   * across the calls meant to share the cache; everything after it is free to
   * vary per call.
   */
  cacheBreakpoint?: number;
}

/**
 * What a call returned. `output` is the tool input as the model produced it:
 * parsed JSON, but NOT yet checked against the panel schema. Validation is the
 * caller's job and lives in `src/panels/schemas.ts`, so that the fixture adapter
 * can replay a deliberately malformed response and the validators can be tested
 * against it.
 */
export interface ModelResponse {
  output: unknown;
  usage: TokenUsage;
  /** The resolved API model id that actually answered. */
  model: string;
}

/** The one seam. Two adapters implement it: `AnthropicClient` and `FixtureClient`. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * A model call that did not produce a usable answer.
 *
 * `retryable` is a classification, not a policy: this module never retries.
 * Retry counts, backoff and the free-retry accounting in `brief §2.3` are Task
 * 7's. The classification lives here because it is derived from the SDK's typed
 * error classes, which is the only place that knows the difference between a
 * malformed request (never retry — it will fail identically) and a rate limit or
 * a 5xx (retry).
 */
export class ModelCallError extends Error {
  override readonly name = 'ModelCallError';
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable;
    this.status = options.status;
  }
}
