/**
 * The vote cache — `the-pit-agent-prompts.md` Phase 2: "keyed on
 * `(juror_id, product_id, prompt_version)` so retries are free."
 *
 * The point of the tests is that the cache is a VIEW over the engine's persisted
 * Score phase rather than a second copy of the votes. A second copy could say
 * "hit" for a phase the engine is about to re-run, which would report a retry as
 * free while charging for it twice — so every assertion below reads the cache
 * from a store the pipeline actually wrote, and the version cases check that the
 * cache misses exactly when the engine re-buys.
 *
 * Hand-derived: 6 jurors x 8 products = 48 keys after one delivered run.
 */

import { JUROR_COUNT, ModelCallError } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { buildVoteCache, readVoteCache, voteCacheKey } from '@/lib/pipeline/vote-cache';

import { makeHarness, run, runExpectingFailure } from './helpers/run.js';

describe('the key', () => {
  it('carries all three components the brief names', () => {
    const key = voteCacheKey('Juror 1', 4, 'jury-v1');
    expect(key).toContain('juror=Juror 1');
    expect(key).toContain('product=4');
    expect(key).toContain('prompt=jury-v1');
  });

  it('separates two jurors, two products and two prompt versions', () => {
    const base = voteCacheKey('Juror 1', 4, 'jury-v1');
    expect(voteCacheKey('Juror 2', 4, 'jury-v1')).not.toBe(base);
    expect(voteCacheKey('Juror 1', 5, 'jury-v1')).not.toBe(base);
    expect(voteCacheKey('Juror 1', 4, 'jury-v2')).not.toBe(base);
  });

  it('is built from the version the vote was cast under, not the one being asked for', () => {
    // The invalidation is structural: a bumped rubric produces different keys, so
    // there is no cache-clearing pass to forget to run (`01 §4` Step 2,
    // `brief §1.3`).
    const cache = buildVoteCache([
      { juror_role: 'Juror 1', prompt_version: 'jury-v1', scores: [{ id: 0, metrics: [] }] },
    ]);
    expect(cache.has('Juror 1', 0, 'jury-v1')).toBe(true);
    expect(cache.has('Juror 1', 0, 'jury-v2')).toBe(false);
  });
});

describe('what a run banks', () => {
  it('holds one row per juror per product after a delivered run', async () => {
    const harness = makeHarness();
    await run(harness);

    const cache = await readVoteCache(harness.store, harness.versions);
    expect(cache.size).toBe(JUROR_COUNT * 8);
    expect(cache.get('Juror 1', 0, 'jury-v1')?.id).toBe(0);
  });

  it('banks the merit panel even when a later phase failed', async () => {
    // This is the case the cache exists for. The Six answered and the clustering
    // pass did not; `brief §2.3` calls that a partial success, retries it free,
    // and the retry must not re-buy the six calls that landed.
    const harness = makeHarness({
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });
    await runExpectingFailure(harness);

    const cache = await readVoteCache(harness.store, harness.versions);
    expect(cache.size).toBe(JUROR_COUNT * 8);
  });

  it('reports nothing banked once the prompt version moves', async () => {
    const first = makeHarness();
    await run(first);

    const bumped = makeHarness({ store: first.store, promptVersion: 'jury-v2' });
    // The engine will re-run the Score phase under the new version, so claiming
    // 48 banked votes would be promising a saving that is not going to happen.
    expect((await readVoteCache(first.store, bumped.versions)).size).toBe(0);
  });

  it('reports nothing banked before the first run', async () => {
    const harness = makeHarness();
    expect((await readVoteCache(harness.store, harness.versions)).size).toBe(0);
  });
});
