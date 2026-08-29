/**
 * The app really does consume the engine as a library.
 *
 * `PHASE-0.md §3`: "`packages/engine` never imports from `apps/web`. The engine
 * is a library the pipeline calls, so the whole ranking path stays runnable from
 * a local CLI — which is what makes disputes reproducible later."
 *
 * The expectations here are the values the source documents fix, so a test fails
 * if the app ever drifts from the engine OR if the engine drifts from `01` and
 * the brief. Comparing `ENGINE.jurors` to `JUROR_COUNT` would only prove the two
 * agree with each other, which they would even if both were wrong.
 */

import { JUROR_COUNT, MERIT_W, previewCacheKey } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { cacheKeyForPreview, ENGINE } from '@/lib/engine';

describe('the constants the app renders', () => {
  it('has six jurors (DECISIONS.md S1, superseding 01 §4 five)', () => {
    expect(ENGINE.jurors).toBe(6);
  });

  it('blends merit and demand 0.65 / 0.35 (01 §7.1)', () => {
    expect(ENGINE.meritWeight).toBe(0.65);
    expect(ENGINE.demandWeight).toBe(0.35);
    // And they are a blend, not two independent knobs.
    expect(ENGINE.meritWeight + ENGINE.demandWeight).toBe(1);
  });

  it('keeps the bounded scarcity tilt at 0.075 (DECISIONS.md S2)', () => {
    expect(ENGINE.uniquenessLambda).toBe(0.075);
  });

  it('chunks scoring at 40 products (01 §7.2)', () => {
    expect(ENGINE.chunkSize).toBe(40);
  });

  it('reads them from the engine rather than restating them', () => {
    // The values above are the documents' numbers; these two assertions are what
    // catches a copy-paste that would let the app and the engine disagree later.
    expect(ENGINE.jurors).toBe(JUROR_COUNT);
    expect(ENGINE.meritWeight).toBe(MERIT_W);
  });

  it('reports the engine build a stored run would be stamped with', () => {
    expect(ENGINE.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the preview cache key', () => {
  const input = {
    descriptionHash: 'abc123',
    categorySnapshotVersion: 'snap-4',
    promptVersion: 'v2',
    personaVersion: 'v1',
  };

  it('is the engine function, not a reimplementation', () => {
    expect(cacheKeyForPreview(input)).toBe(previewCacheKey(input));
  });

  it('includes all four components brief §1.3 requires', () => {
    // A key on the description hash alone serves a rank that was true against a
    // board that no longer exists — `brief §1.2` moves every z-score on every
    // placement.
    const key = cacheKeyForPreview(input);
    expect(key).toContain('desc=abc123');
    expect(key).toContain('cat=snap-4');
    expect(key).toContain('prompt=v2');
    expect(key).toContain('persona=v1');
  });

  it('changes when the population moves', () => {
    expect(cacheKeyForPreview({ ...input, categorySnapshotVersion: 'snap-5' })).not.toBe(cacheKeyForPreview(input));
  });

  it('refuses a missing version rather than defaulting it to empty', () => {
    expect(() => cacheKeyForPreview({ ...input, personaVersion: '' })).toThrow(/personaVersion/);
  });
});
