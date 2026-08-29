import type Anthropic from '@anthropic-ai/sdk';
import AnthropicSDK from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { MODEL_ID_HAIKU, MODEL_ID_SONNET } from '../../src/config/constants.js';
import {
  AnthropicClient,
  buildMessageParams,
  extractToolOutput,
  MODEL_IDS,
  ModelCallError,
  resolveModelId,
  supportsEffort,
  toTokenUsage,
} from '../../src/model/index.js';
import type { ModelRequest } from '../../src/model/index.js';

/**
 * `AnthropicClient` is exercised only through its request construction and its
 * response mapping. There is no API key in this environment and no test may reach
 * the network (Global Constraint 5), so what is asserted is the shape of what it
 * WOULD send.
 */

const TOOL: Anthropic.Tool = {
  name: 'submit',
  description: 'submit',
  input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'haiku',
    system: [
      { type: 'text', text: 'stable prefix' },
      { type: 'text', text: 'also stable' },
    ],
    messages: [{ role: 'user', content: 'volatile' }],
    tools: [TOOL],
    toolName: 'submit',
    maxTokens: 1000,
    ...overrides,
  };
}

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL_ID_HAIKU,
    content: [{ type: 'tool_use', id: 'tu_1', name: 'submit', input: { ok: true } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 60,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  } as Anthropic.Message;
}

/** A stand-in for the SDK client. Only `messages.create` is ever reached. */
function stubClient(handler: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create: handler } } as unknown as Anthropic;
}

describe('model id resolution', () => {
  it('maps the frozen tiers onto the exact API ids, with no date suffix', () => {
    expect(MODEL_IDS).toEqual({ haiku: MODEL_ID_HAIKU, sonnet: MODEL_ID_SONNET });
    expect(resolveModelId('haiku')).toBe('claude-haiku-4-5');
    expect(resolveModelId('sonnet')).toBe('claude-sonnet-5');
  });

  it('refuses an unknown tier rather than guessing a model', () => {
    expect(() => resolveModelId('opus' as never)).toThrow(ModelCallError);
  });

  it('knows haiku has no effort setting and sonnet does', () => {
    expect(supportsEffort(MODEL_ID_HAIKU)).toBe(false);
    expect(supportsEffort(MODEL_ID_SONNET)).toBe(true);
  });
});

describe('buildMessageParams', () => {
  it('sends the resolved model id and a forced tool call', () => {
    const params = buildMessageParams(request());

    expect(params.model).toBe(MODEL_ID_HAIKU);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'submit' });
    expect(params.max_tokens).toBe(1000);
  });

  it('sets strict on every tool, and never on tool_choice', () => {
    const params = buildMessageParams(request());

    expect(params.tools).toHaveLength(1);
    expect(params.tools?.[0]).toMatchObject({ name: 'submit', strict: true });
    expect(params.tool_choice).not.toHaveProperty('strict');
  });

  it('does not use the deprecated output_format parameter', () => {
    expect(buildMessageParams(request())).not.toHaveProperty('output_format');
  });

  it('sends NO effort on a juror call even when one is requested (01 §5.1 vs the Messages API)', () => {
    const params = buildMessageParams(request({ model: 'haiku', effort: 'low' }));

    expect(params.output_config).toBeUndefined();
    expect(params).not.toHaveProperty('thinking');
  });

  it('sends effort medium on a sonnet call (01 §5.2, §5.3)', () => {
    const params = buildMessageParams(request({ model: 'sonnet', effort: 'medium' }));

    expect(params.output_config).toEqual({ effort: 'medium' });
  });

  describe('cache breakpoints', () => {
    it('places exactly one ephemeral marker, on the named system block', () => {
      const params = buildMessageParams(request({ cacheBreakpoint: 1 }));
      const system = params.system as Anthropic.TextBlockParam[];

      expect(system[0]?.cache_control).toBeUndefined();
      expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
      expect(system.filter((block) => block.cache_control !== undefined)).toHaveLength(1);
    });

    it('leaves everything after the breakpoint uncached, so the volatile part can vary', () => {
      const params = buildMessageParams(request({ cacheBreakpoint: 0 }));
      const system = params.system as Anthropic.TextBlockParam[];

      expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
      expect(system[1]?.cache_control).toBeUndefined();
      expect(JSON.stringify(params.messages)).not.toContain('cache_control');
    });

    it('marks nothing when no breakpoint is asked for', () => {
      const params = buildMessageParams(request());
      expect(JSON.stringify(params.system)).not.toContain('cache_control');
    });

    it('does not mutate the caller’s system blocks', () => {
      const original = request({ cacheBreakpoint: 1 });
      buildMessageParams(original);
      expect(original.system[1]).not.toHaveProperty('cache_control');
    });

    it('refuses an out-of-range breakpoint instead of silently not caching', () => {
      expect(() => buildMessageParams(request({ cacheBreakpoint: 2 }))).toThrow(/cacheBreakpoint/);
      expect(() => buildMessageParams(request({ cacheBreakpoint: -1 }))).toThrow(/cacheBreakpoint/);
    });

    it('refuses a system block that placed its own cache_control', () => {
      const smuggled = request({
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      });
      expect(() => buildMessageParams(smuggled)).toThrow(/cache_control/);
    });
  });

  it('refuses a request that could not produce an answer', () => {
    expect(() => buildMessageParams(request({ tools: [] }))).toThrow(/at least one tool/);
    expect(() => buildMessageParams(request({ toolName: 'other' }))).toThrow(/not among the supplied tools/);
    expect(() => buildMessageParams(request({ messages: [] }))).toThrow(/at least one message/);
    expect(() => buildMessageParams(request({ maxTokens: 0 }))).toThrow(/maxTokens/);
  });
});

describe('extractToolOutput', () => {
  it('returns the forced tool call’s input', () => {
    expect(extractToolOutput(message(), 'submit')).toEqual({ ok: true });
  });

  it('treats a truncated response as retryable and names the cause', () => {
    const truncated = message({ stop_reason: 'max_tokens', content: [] });
    expect(() => extractToolOutput(truncated, 'submit')).toThrow(/max_tokens/);
    try {
      extractToolOutput(truncated, 'submit');
    } catch (error) {
      expect((error as ModelCallError).retryable).toBe(true);
    }
  });

  it('treats a refusal as not retryable', () => {
    const refused = message({ stop_reason: 'refusal', content: [] });
    try {
      extractToolOutput(refused, 'submit');
      expect.unreachable();
    } catch (error) {
      expect((error as ModelCallError).retryable).toBe(false);
    }
  });

  it('fails when the model answered in prose instead of calling the tool', () => {
    const prose = message({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sure', citations: null }] });
    expect(() => extractToolOutput(prose, 'submit')).toThrow(/no "submit" tool call/);
  });
});

describe('toTokenUsage', () => {
  it('keeps the cache counters that say whether the breakpoints are working', () => {
    expect(toTokenUsage(message().usage)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 60,
    });
  });

  it('normalises null cache counters to zero so a ledger can sum without guarding', () => {
    const usage = { ...message().usage, cache_creation_input_tokens: null, cache_read_input_tokens: null };
    expect(toTokenUsage(usage)).toMatchObject({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  });
});

describe('AnthropicClient.complete', () => {
  it('sends the built params and returns output, usage and the resolved model', async () => {
    let sent: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const client = new AnthropicClient(
      stubClient((params) => {
        sent = params;
        return Promise.resolve(message());
      }),
    );

    const response = await client.complete(request({ cacheBreakpoint: 0 }));

    expect(sent?.model).toBe(MODEL_ID_HAIKU);
    expect(sent?.tools?.[0]).toMatchObject({ strict: true });
    expect(response.output).toEqual({ ok: true });
    expect(response.model).toBe(MODEL_ID_HAIKU);
    expect(response.usage.cache_read_input_tokens).toBe(60);
  });

  it('classifies a 400 as not retryable — it would fail identically every time', async () => {
    const client = new AnthropicClient(
      stubClient(() => Promise.reject(new AnthropicSDK.BadRequestError(400, undefined, 'bad schema', new Headers()))),
    );

    await expect(client.complete(request())).rejects.toMatchObject({ retryable: false, status: 400 });
  });

  it('classifies auth failure as not retryable', async () => {
    const client = new AnthropicClient(
      stubClient(() => Promise.reject(new AnthropicSDK.AuthenticationError(401, undefined, 'no key', new Headers()))),
    );

    await expect(client.complete(request())).rejects.toMatchObject({ retryable: false, status: 401 });
  });

  it('classifies a rate limit as retryable', async () => {
    const client = new AnthropicClient(
      stubClient(() => Promise.reject(new AnthropicSDK.RateLimitError(429, undefined, 'slow down', new Headers()))),
    );

    await expect(client.complete(request())).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it('classifies a 5xx and a connection failure as retryable', async () => {
    const server = new AnthropicClient(
      stubClient(() => Promise.reject(new AnthropicSDK.InternalServerError(503, undefined, 'down', new Headers()))),
    );
    await expect(server.complete(request())).rejects.toMatchObject({ retryable: true });

    const offline = new AnthropicClient(
      stubClient(() => Promise.reject(new AnthropicSDK.APIConnectionError({ message: 'offline' }))),
    );
    await expect(offline.complete(request())).rejects.toMatchObject({ retryable: true });
  });

  it('never string-matches an error message to classify it', () => {
    // The classifier is driven entirely by the SDK's typed classes; an error that
    // is not one of them is not retried on the strength of its wording.
    const client = new AnthropicClient(stubClient(() => Promise.reject(new Error('rate limit exceeded'))));
    return expect(client.complete(request())).rejects.toMatchObject({ retryable: false });
  });
});
