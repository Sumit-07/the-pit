import { describe, expect, it } from 'vitest';

import { FixtureClient, FixtureExhaustedError } from '../../src/model/index.js';
import type { ModelRequest } from '../../src/model/index.js';

const REQUEST: ModelRequest = {
  model: 'haiku',
  system: [{ type: 'text', text: 'prefix' }],
  messages: [{ role: 'user', content: 'go' }],
  tools: [{ name: 'submit', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  toolName: 'submit',
  maxTokens: 100,
};

describe('FixtureClient', () => {
  it('replays recorded responses in order', async () => {
    const client = new FixtureClient([{ output: { a: 1 } }, { output: { a: 2 } }]);

    expect((await client.complete(REQUEST)).output).toEqual({ a: 1 });
    expect((await client.complete(REQUEST)).output).toEqual({ a: 2 });
  });

  it('records every request so a test can assert what was sent', async () => {
    const client = new FixtureClient([{ output: {} }]);
    await client.complete(REQUEST);

    expect(client.callCount).toBe(1);
    expect(client.requests[0]).toBe(REQUEST);
  });

  it('defaults usage to zeros and merges overrides', async () => {
    const client = new FixtureClient([{ output: {}, usage: { input_tokens: 12, cache_read_input_tokens: 5 } }]);

    expect((await client.complete(REQUEST)).usage).toEqual({
      input_tokens: 12,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5,
    });
  });

  it('fails loudly when the script runs out rather than replaying the last answer', async () => {
    const client = new FixtureClient([{ output: {} }]);
    await client.complete(REQUEST);

    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(FixtureExhaustedError);
  });

  it('can answer from the request, for tests that fan out over jurors', async () => {
    const client = new FixtureClient((request, index) => ({ output: { tier: request.model, index } }));

    expect((await client.complete(REQUEST)).output).toEqual({ tier: 'haiku', index: 0 });
    expect((await client.complete({ ...REQUEST, model: 'sonnet' })).output).toEqual({ tier: 'sonnet', index: 1 });
  });

  it('needs no network, no API key and no environment', async () => {
    // Nothing in this file touches process.env or constructs the SDK client.
    const client = new FixtureClient([{ output: { fine: true } }]);
    expect((await client.complete(REQUEST)).model).toBe('haiku');
  });
});
