import { describe, expect, it } from 'vitest';

import { MAX_TOKENS_UNIQUENESS } from '../../src/config/constants.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import { ModelCallError } from '../../src/model/types.js';
import type { ModelRequest } from '../../src/model/types.js';
import { SchemaValidationError, UNIQ_SCHEMA, UNIQ_TOOL_NAME } from '../../src/panels/schemas.js';
import { dispatch } from '../../src/run/dispatch.js';
import { PhaseLedger } from '../../src/run/ledger.js';

/**
 * `dispatch` is the single seam between the orchestrator and a model. Two things
 * are load-bearing: every call is billed whatever happens to it, and a
 * `max_tokens` truncation is demoted to a TERMINAL failure so a phase retry loop
 * cannot burn `brief §2.3`'s three free retries on a deterministic failure.
 */

const REQUEST: ModelRequest = {
  model: 'sonnet',
  system: [{ type: 'text', text: 'system' }],
  messages: [{ role: 'user', content: 'go' }],
  tools: [UNIQ_SCHEMA],
  toolName: UNIQ_TOOL_NAME,
  maxTokens: MAX_TOKENS_UNIQUENESS,
};

const throwing = (error: Error): FixtureClient =>
  new FixtureClient(() => {
    throw error;
  });

describe('dispatch — billing', () => {
  it('bills a successful call to the phase ledger', async () => {
    const ledger = new PhaseLedger();
    const client = new FixtureClient([
      { output: { ok: true }, usage: { input_tokens: 500, output_tokens: 50 }, model: 'claude-sonnet-5' },
    ]);

    const result = await dispatch(client, REQUEST, 'test call', ledger, (output) => output);

    expect(result.ok).toBe(true);
    expect(ledger.total().calls).toBe(1);
    expect(ledger.total().cost_usd).toBeGreaterThan(0);
  });

  it('bills a FAILED call as a call — the provider charged for the input either way', async () => {
    const ledger = new PhaseLedger();
    const client = throwing(new ModelCallError('rate limited', { retryable: true, status: 429 }));

    await dispatch(client, REQUEST, 'test call', ledger, (output) => output);

    expect(ledger.total().calls).toBe(1);
  });
});

describe('dispatch — classification', () => {
  it('passes a retryable provider failure through as retryable', async () => {
    const client = throwing(new ModelCallError('upstream 503', { retryable: true, status: 503 }));
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), (output) => output);

    expect(result).toMatchObject({ ok: false, code: 'model_call', retryable: true });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('clustering pass');
  });

  it('keeps a non-retryable provider failure non-retryable', async () => {
    const client = throwing(new ModelCallError('bad request', { retryable: false, status: 400 }));
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), (output) => output);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('DEMOTES a max_tokens truncation to terminal, whatever the adapter said', async () => {
    // `anthropic-client.ts` classifies a truncation retryable — correct there,
    // where a shorter answer next time is plausible. Here it is wrong: the prompt
    // is deterministic, so a category that overflows MAX_TOKENS_UNIQUENESS
    // overflows it on every attempt, and three free retries would be spent
    // reproducing it.
    const client = throwing(new ModelCallError('truncated at max_tokens', { retryable: true, code: 'max_tokens' }));
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), (output) => output);

    expect(result).toMatchObject({ ok: false, code: 'truncated', retryable: false });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('MAX_TOKENS_');
    expect(result.message).toContain('every retry will truncate identically');
  });

  it('keys the demotion on the code, not on the error’s wording', async () => {
    // Same message, no code: it stays whatever the adapter classified it as. The
    // wording of an error is not a contract.
    const client = throwing(new ModelCallError('truncated at max_tokens', { retryable: true }));
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), (output) => output);
    expect(result).toMatchObject({ ok: false, code: 'model_call', retryable: true });
  });

  it('classifies a schema violation as retryable, and names the call', async () => {
    const client = new FixtureClient([{ output: { nonsense: true } }]);
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), () => {
      throw new SchemaValidationError('uniqueness response.clusters: expected an array');
    });

    expect(result).toMatchObject({ ok: false, code: 'schema', retryable: true });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('clustering pass');
    expect(result.message).toContain('expected an array');
  });

  it('treats an unrecognised throw as terminal rather than retrying a bug', async () => {
    const client = throwing(new TypeError('cannot read properties of undefined'));
    const result = await dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), (output) => output);
    expect(result).toMatchObject({ ok: false, code: 'internal', retryable: false });
  });

  it('lets a non-schema validator bug escape rather than swallowing it', async () => {
    const client = new FixtureClient([{ output: {} }]);
    await expect(
      dispatch(client, REQUEST, 'clustering pass', new PhaseLedger(), () => {
        throw new RangeError('an engine bug, not a bad response');
      }),
    ).rejects.toThrow(RangeError);
  });
});
