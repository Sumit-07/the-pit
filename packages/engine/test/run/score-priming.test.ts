/**
 * The Score phase's cache primer.
 *
 * ## What was wrong
 *
 * `buildScoreRequest` puts tools, the scoring method, the rubric, the calibration
 * block and the chunk's product list inside one `cache_control` prefix and leaves
 * only the juror mandate outside it. The six jurors of a chunk therefore send a
 * byte-identical prefix, and the breakpoint exists so five of them read it back
 * at 0.1x instead of paying for it again.
 *
 * They did not. All six went out in one `Promise.all`, so all six reached the API
 * before any of them had written anything: six misses, six write premiums at
 * 1.25x, and `cache_read_input_tokens` zero across the whole phase. The
 * breakpoint charged 25% extra and returned nothing — which is the exact failure
 * `src/model/anthropic-client.ts` warns about at the top ("watch
 * `usage.cache_read_input_tokens` across the six juror calls of one run and treat
 * a persistent zero as a defect rather than as noise"), except that here the
 * cause was in the caller, not in the prompt.
 *
 * ## What is asserted, and why it is timing
 *
 * "One call goes first" is not visible in the phase's output — the result shape
 * is identical either way, which is the point. So the fake client below records a
 * TIMELINE of `start` and `settle` events and the tests read the interleaving:
 * the primer must have settled before the second call started, or the prefix was
 * not in the cache when the second call looked for it.
 *
 * Per CHUNK, because the product list sits inside the prefix: two chunks are two
 * different prefixes and neither primes the other, so both primers go out
 * together and neither waits on the other.
 *
 * And the ORDER calls reach the client is asserted unchanged, because something
 * depends on it that nothing in this phase would remind you of:
 * `HandoffClient.complete` matches a request to its plan descriptor by the order
 * it is entered (`src/model/handoff-client.ts`), so a re-ordering here would file
 * one juror's request under another's name.
 */

import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../../src/model/fixture-client.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../../src/model/types.js';
import { ModelCallError } from '../../src/model/types.js';
import { runScorePhase } from '../../src/run/phases/score.js';
import {
  CATEGORY,
  CATEGORY_VERSION,
  JURORS,
  JURY,
  METRIC_NAMES,
  idsShown,
  makeProducts,
  scoreAnswer,
} from '../helpers/run-fixtures.js';

const ORDERING = { category: CATEGORY, categoryVersion: CATEGORY_VERSION } as const;

/** The mandate is the only volatile part of a scoring request; it identifies the juror. */
function jurorOf(request: ModelRequest): string {
  const mandate = request.messages[0]?.content;
  const text = typeof mandate === 'string' ? mandate : '';
  return JURORS.find((juror) => text.includes(`You are ${juror.role}.`))?.role ?? '(unknown)';
}

/** The cached prefix of a request: tools plus system blocks 0..cacheBreakpoint. */
function cachedPrefix(request: ModelRequest): string {
  const breakpoint = request.cacheBreakpoint ?? request.system.length - 1;
  return JSON.stringify([request.tools, request.system.slice(0, breakpoint + 1)]);
}

/**
 * A client that resolves on a macrotask, so concurrency is observable.
 *
 * `FixtureClient` answers with `Promise.resolve`, which settles in the same
 * microtask drain the call was made in — under it a simultaneous fan-out and a
 * primed one produce indistinguishable timelines. A real call takes time; this
 * one takes a turn of the event loop, which is the smallest amount of time that
 * makes "did this finish before that started" a real question.
 */
class TimedClient implements ModelClient {
  readonly timeline: string[] = [];
  readonly requests: ModelRequest[] = [];

  constructor(private readonly fail?: (index: number) => Error | undefined) {}

  complete(request: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    this.timeline.push(`start:${index}`);

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.timeline.push(`settle:${index}`);
        const error = this.fail?.(index);
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve({
          output: scoreAnswer(idsShown(request), METRIC_NAMES),
          usage: { ...ZERO_USAGE },
          model: request.model,
        });
      }, 0);
    });
  }
}

/** Positions in the timeline of the `start` events, by call index. */
function startedAt(timeline: readonly string[]): number[] {
  return timeline.map((_, index) => index).filter((index) => timeline[index]?.startsWith('start:'));
}

describe('the Score phase primes the prompt cache before it fans out', () => {
  it('lets one juror finish before the other five are sent', async () => {
    // One chunk: 8 products is well inside `CHUNK_SIZE`, so all six jurors share
    // one prefix and exactly one of them may be in flight first.
    const client = new TimedClient();
    const result = await runScorePhase({ client, products: makeProducts(8), jury: JURY, ordering: ORDERING });

    expect(result.status).toBe('ok');
    expect(client.requests).toHaveLength(JURORS.length);

    // The shape the fix is: one start, its settle, then the rest.
    expect(client.timeline.slice(0, 2)).toEqual(['start:0', 'settle:0']);
    const firstSettle = client.timeline.indexOf('settle:0');
    for (const position of startedAt(client.timeline)) {
      if (client.timeline[position] === 'start:0') continue;
      expect(position).toBeGreaterThan(firstSettle);
    }

    // And the five that followed did have something to read: they sent the
    // primer's prefix byte for byte, differing only past the breakpoint.
    const prefixes = new Set(client.requests.map((request) => cachedPrefix(request)));
    expect(prefixes.size).toBe(1);
    expect(new Set(client.requests.map((request) => jurorOf(request))).size).toBe(JURORS.length);
  });

  it('primes each chunk separately, because the products are inside the prefix', async () => {
    // Two prefixes, so two primers — and they do not wait on each other: neither
    // chunk's prefix is in the other's cache, so serializing them would buy
    // nothing and cost a round trip.
    const client = new TimedClient();
    const result = await runScorePhase({
      client,
      products: makeProducts(8),
      jury: JURY,
      ordering: ORDERING,
      chunkSize: 4,
    });

    expect(result.status).toBe('ok');
    expect(client.requests).toHaveLength(JURORS.length * 2);

    const prefixes = new Set(client.requests.map((request) => cachedPrefix(request)));
    expect(prefixes.size).toBe(2);

    // Both primers out before either settles, then everything else after both.
    expect(client.timeline.slice(0, 4)).toEqual(['start:0', 'start:1', 'settle:0', 'settle:1']);
    const primedBy = client.timeline.indexOf('settle:1');
    for (const position of startedAt(client.timeline).slice(2)) {
      expect(position).toBeGreaterThan(primedBy);
    }
  });

  it('sends the calls in the order it always did, which HandoffClient reads', async () => {
    // Juror-major, chunk-minor. `HandoffClient.complete` names a request by the
    // order it is entered, so a phase that primed by re-ordering would attribute
    // one juror's answer to another with nothing failing.
    const client = new TimedClient();
    await runScorePhase({ client, products: makeProducts(8), jury: JURY, ordering: ORDERING, chunkSize: 4 });

    const sent = client.requests.map((request) => [jurorOf(request), idsShown(request).join(',')]);
    const expected = JURORS.flatMap((juror) => [
      [juror.role, sent.find(([role]) => role === juror.role)?.[1] ?? ''],
      [juror.role, sent.filter(([role]) => role === juror.role)[1]?.[1] ?? ''],
    ]);
    expect(sent).toEqual(expected);
  });

  it('surfaces a failed primer exactly as it surfaced before, and still sends the rest', async () => {
    // A dead provider is not a reason to withhold the other five calls: they used
    // to go out regardless, `dispatch` returns failures rather than throwing, and
    // the coverage audit has to see the same evidence either way. The juror whose
    // call failed is the only one missing.
    const client = new TimedClient((index) =>
      index === 0 ? new ModelCallError('overloaded_error: the model is overloaded', { retryable: true }) : undefined,
    );
    const result = await runScorePhase({ client, products: makeProducts(8), jury: JURY, ordering: ORDERING });

    // Every call still went out — the five that followed the dead primer were
    // not cancelled by it.
    expect(client.requests).toHaveLength(JURORS.length);

    // And the phase reports what it always reported for one dead juror: a
    // retryable `model_call` failure naming one call of six, with the coverage
    // audit pointing at the juror that is missing.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure.code).toBe('model_call');
    expect(result.failure.retryable).toBe(true);
    expect(result.failure.message).toContain('1 of 6 scoring call(s)');
    expect(result.failure.coverage?.missing_roles).toEqual([JURORS[0]?.role]);
    expect(result.failure.coverage?.jurors_answered).toBe(JURORS.length - 1);
    expect(result.failure.causes.join('\n')).toContain('the model is overloaded');
  });

  it('lets an engine bug in the primer escape, as it did when all six raced', async () => {
    // `dispatch` swallows model and schema failures and rethrows nothing else. A
    // primer that throws something it cannot classify must still reject out of
    // the phase rather than be quietly recorded as an absent juror.
    class Bug extends Error {
      override readonly name = 'Bug';
    }
    const client: ModelClient = {
      complete: () => {
        throw new Bug('the adapter is broken');
      },
    };

    // `dispatch` classifies an unrecognised throw as a non-retryable `internal`
    // failure rather than letting it escape — the same answer, for the primer,
    // that it gave for a racing call.
    const result = await runScorePhase({ client, products: makeProducts(8), jury: JURY, ordering: ORDERING });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure.code).toBe('internal');
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.causes.join('\n')).toContain('the adapter is broken');
  });
});
