/**
 * The offline `ModelClient` every test uses.
 *
 * Global Constraint 5: `pnpm test` passes with no network and no environment
 * variables. This adapter replays recorded JSON in a fixed order and records the
 * requests it was handed, so a test can assert both what the engine *sent* and
 * what it does with what came back — including malformed responses, which is the
 * only way to exercise the schema validators.
 *
 * Deterministic by construction: no clock, no randomness, no I/O. The same script
 * answers the same sequence of calls the same way in every process.
 */

import type { ModelClient, ModelRequest, ModelResponse, TokenUsage } from './types.js';

/** Token usage attributed to a replayed call. Zeros unless a test says otherwise. */
export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

/**
 * One recorded answer. `output` is handed back verbatim as `ModelResponse.output`
 * — unvalidated, exactly as the live adapter hands back a tool call's `input`.
 */
export interface FixtureResponse {
  output: unknown;
  usage?: Partial<TokenUsage>;
  /** Defaults to the tier name, which is enough for tests that only assert routing. */
  model?: string;
}

/**
 * Either a queue of answers, consumed one per call in order, or a function that
 * chooses an answer from the request.
 *
 * The queue is the default because it is the form that cannot drift: a test that
 * expects three calls supplies three answers, and a fourth call fails loudly
 * instead of silently replaying the last one.
 */
export type FixtureScript = readonly FixtureResponse[] | ((request: ModelRequest, index: number) => FixtureResponse);

/** Raised when a fixture script cannot answer a call. Never thrown in production. */
export class FixtureExhaustedError extends Error {
  override readonly name = 'FixtureExhaustedError';
}

export class FixtureClient implements ModelClient {
  private readonly script: FixtureScript;
  private readonly recorded: ModelRequest[] = [];

  constructor(script: FixtureScript) {
    this.script = script;
  }

  /** Every request handed to this client, in call order. */
  get requests(): readonly ModelRequest[] {
    return this.recorded;
  }

  /** How many calls have been served. */
  get callCount(): number {
    return this.recorded.length;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    const index = this.recorded.length;
    this.recorded.push(request);

    const fixture = typeof this.script === 'function' ? this.script(request, index) : this.script[index];
    if (fixture === undefined) {
      const available = typeof this.script === 'function' ? 'a resolver' : `${this.script.length} recorded response(s)`;
      return Promise.reject(
        new FixtureExhaustedError(`FixtureClient: call ${index + 1} has no fixture (script holds ${available})`),
      );
    }

    return Promise.resolve({
      output: fixture.output,
      usage: { ...ZERO_USAGE, ...fixture.usage },
      model: fixture.model ?? request.model,
    });
  }
}
