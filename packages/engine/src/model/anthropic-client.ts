/**
 * The live `ModelClient`: the Messages API behind the engine's one model seam.
 *
 * Request construction is a pure exported function (`buildMessageParams`) and the
 * class is a thin wrapper around it. That split is deliberate: there is no API
 * key in this project's test environment and `pnpm test` must pass offline
 * (Global Constraint 5), so the request shape — model id, tools, `strict`, where
 * the cache breakpoint lands, and the *absence* of `effort` on juror calls — is
 * asserted against the params object rather than by making a call.
 */

// A value import, not a type-only one: the typed error classes are statics on
// this binding and `instanceof` needs them at runtime. Importing the module does
// not touch credentials — only `new Anthropic()` does, in the constructor below.
import Anthropic from '@anthropic-ai/sdk';

import { resolveModelId, supportsEffort } from './model-ids.js';
import { ModelCallError, type ModelClient, type ModelRequest, type ModelResponse, type TokenUsage } from './types.js';

/**
 * Turn a `ModelRequest` into the exact body sent to `POST /v1/messages`.
 *
 * ## Structured output
 *
 * The answer comes back as a forced tool call, not as prose: `tool_choice` names
 * the tool and every tool definition carries `strict: true` (set on the tool
 * itself, alongside `name` / `description` / `input_schema` — not on
 * `tool_choice`). The deprecated `output_format` parameter is not used.
 *
 * ## Cache breakpoints
 *
 * Prompt caching is a PREFIX match, rendered `tools` -> `system` -> `messages`.
 * A single `cache_control: {type: 'ephemeral'}` marker is placed on the system
 * block named by `request.cacheBreakpoint`, which makes the prefix "all tools,
 * plus system blocks 0..cacheBreakpoint". Anything after it — later system
 * blocks and every message — is free to vary per call without invalidating.
 *
 * One breakpoint per request, of the four the API allows. That is all the engine
 * needs: within one run the panels have exactly one stable/volatile boundary
 * each (see the prompt builders), and each extra breakpoint is another prefix
 * whose write premium has to earn itself back.
 *
 * The minimum cacheable prefix is model-dependent (512-4096 tokens), so a short
 * prompt — a small category, or a one-product incremental chunk — silently will
 * not cache at all. Nothing here can detect that; Task 7 should watch
 * `usage.cache_read_input_tokens` across the six juror calls of one run and treat
 * a persistent zero as a defect rather than as noise.
 *
 * ## `effort`, and where this diverges from `01`
 *
 * `01 §5.1` specifies **Effort: `low`** for the merit jurors and `01 §5.2`/`§5.3`
 * specify `medium` for the clustering and persona passes. Only the latter two are
 * honoured here.
 *
 * `01`'s panels were local Claude Code subagents dispatched through the Workflow
 * tool; this engine calls the Messages API, and on that surface
 * `output_config.effort` is not supported by `claude-haiku-4-5` — the model the
 * jurors run on — and sending it is an error, not a no-op. So juror calls send no
 * `effort` and no `thinking` parameter at all. The clustering and persona calls
 * run on `claude-sonnet-5`, which does support `effort`, and are sent
 * `output_config: {effort: 'medium'}` exactly as `01 §5.2` and `§5.3` ask.
 *
 * The guard is on the resolved model id rather than on the tier, so pointing the
 * juror tier at a different model in `model-ids.ts` picks up its effort support
 * automatically instead of silently keeping `01`'s setting suppressed.
 */
export function buildMessageParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  if (request.tools.length === 0) {
    throw new ModelCallError('buildMessageParams: at least one tool is required', { retryable: false });
  }
  if (!request.tools.some((tool) => tool.name === request.toolName)) {
    throw new ModelCallError(
      `buildMessageParams: toolName ${JSON.stringify(request.toolName)} is not among the supplied tools`,
      { retryable: false },
    );
  }
  if (request.messages.length === 0) {
    throw new ModelCallError('buildMessageParams: at least one message is required', { retryable: false });
  }
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
    throw new ModelCallError(`buildMessageParams: maxTokens must be a positive integer, got ${request.maxTokens}`, {
      retryable: false,
    });
  }
  if (request.system.some((block) => block.cache_control != null)) {
    throw new ModelCallError('buildMessageParams: system blocks must not carry their own cache_control', {
      retryable: false,
    });
  }

  const modelId = resolveModelId(request.model);
  const system = withCacheBreakpoint(request.system, request.cacheBreakpoint);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: request.maxTokens,
    system,
    messages: [...request.messages],
    tools: request.tools.map((tool) => ({ ...tool, strict: true })),
    tool_choice: { type: 'tool', name: request.toolName },
  };

  // Absent for jurors by design — see the divergence note above.
  if (request.effort !== undefined && supportsEffort(modelId)) {
    params.output_config = { effort: request.effort };
  }

  return params;
}

/**
 * Copy the system blocks, putting the one ephemeral `cache_control` marker on the
 * block at `breakpoint`. Returns the blocks untouched when no breakpoint is set.
 */
function withCacheBreakpoint(
  blocks: readonly Anthropic.TextBlockParam[],
  breakpoint: number | undefined,
): Anthropic.TextBlockParam[] {
  const copied = blocks.map((block) => ({ ...block }));
  if (breakpoint === undefined) return copied;

  if (!Number.isInteger(breakpoint) || breakpoint < 0 || breakpoint >= copied.length) {
    throw new ModelCallError(
      `buildMessageParams: cacheBreakpoint ${breakpoint} is not an index into ${copied.length} system blocks`,
      { retryable: false },
    );
  }

  const block = copied[breakpoint];
  // Unreachable given the bounds check; checked because a silently unmarked
  // prefix is a cost regression that no test failure would announce.
  if (block === undefined) throw new ModelCallError('buildMessageParams: cache breakpoint index out of range', { retryable: false });
  block.cache_control = { type: 'ephemeral' };
  return copied;
}

/** Normalize `Anthropic.Usage` to the four numbers the cost ledger sums. */
export function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Pull the forced tool call out of a response, or say precisely why there is not
 * one. Exported so the mapping is testable against a literal `Anthropic.Message`
 * without a client.
 *
 * `max_tokens` and `refusal` are separated from "no tool block" because they mean
 * different things to a retry policy: a truncated response is worth retrying (and
 * is the symptom of a lowballed `MAX_TOKENS_*`), a refusal is not.
 */
export function extractToolOutput(message: Anthropic.Message, toolName: string): unknown {
  if (message.stop_reason === 'max_tokens') {
    throw new ModelCallError(
      `model response was truncated at max_tokens before ${JSON.stringify(toolName)} completed; raise the max_tokens budget`,
      { retryable: true },
    );
  }
  if (message.stop_reason === 'refusal') {
    throw new ModelCallError(`model refused the request (${message.stop_details?.category ?? 'no category'})`, {
      retryable: false,
    });
  }

  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === toolName) return block.input;
  }

  throw new ModelCallError(
    `model returned no ${JSON.stringify(toolName)} tool call (stop_reason ${JSON.stringify(message.stop_reason)})`,
    { retryable: true },
  );
}

/**
 * The live adapter.
 *
 * The SDK client is constructed with no arguments so it resolves credentials from
 * the environment; nothing in this repo reads or stores a key. Construction is
 * deferred to the constructor, so importing this module — which the package index
 * does — never touches credentials and never fails in a test run.
 */
export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(client: Anthropic = new Anthropic()) {
    this.client = client;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params = buildMessageParams(request);

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params);
    } catch (error) {
      throw classifyError(error);
    }

    return {
      output: extractToolOutput(message, request.toolName),
      usage: toTokenUsage(message.usage),
      model: message.model,
    };
  }
}

/**
 * Map an SDK error onto `ModelCallError`, most-specific class first.
 *
 * Never string-matches a message: the SDK's typed classes are the contract, the
 * wording of an error is not. `BadRequestError` comes first because it is the one
 * failure that must NOT be retried — a malformed schema or an unsupported
 * parameter (an `effort` sent to a model that has none) fails identically on
 * every attempt, and retrying it burns a customer's free retries on a bug.
 */
function classifyError(error: unknown): ModelCallError {
  if (error instanceof Anthropic.BadRequestError) {
    return new ModelCallError(`model rejected the request: ${error.message}`, {
      retryable: false,
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelCallError(`model credentials were rejected: ${error.message}`, {
      retryable: false,
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelCallError(`model call was rate limited: ${error.message}`, {
      retryable: true,
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    // Everything left: 5xx, 408, 409, and connection errors (which carry no
    // status). All are transient by nature, so they are retryable.
    const status = error.status;
    return new ModelCallError(`model call failed: ${error.message}`, {
      retryable: status === undefined || status >= 500 || status === 408 || status === 409,
      status,
      cause: error,
    });
  }
  return new ModelCallError(`model call failed: ${String(error)}`, { retryable: false, cause: error });
}
