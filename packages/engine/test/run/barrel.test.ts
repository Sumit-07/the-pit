import { describe, expect, it } from 'vitest';

import * as engine from '../../src/index.js';
import * as panels from '../../src/panels/index.js';
import * as rank from '../../src/rank/index.js';
import * as chunk from '../../src/rank/chunk.js';

/**
 * The one invariant on this branch that is enforced by an ABSENCE.
 *
 * `chunkItems` splits a list in the order it arrives. `Product.id` is assigned
 * after sorting by the source sheet's rank (`src/ingest/load-category.ts`), so in
 * id order chunk 1 of a 44-product category is the products ranked 1-22 and
 * chunk 2 is those ranked 23-44. `01 §5.1` scores comparatively — a juror deducts
 * against the field in front of it — so the two halves come back on different
 * scales, and `01 §6.1` then z-normalizes all 44 as one population. That is
 * `brief §1.1`'s isolated-scoring bias reappearing between chunks.
 *
 * A caller that reaches for `chunkItems` and hands the result to
 * `buildScoreRequest` gets prompts that look perfect — `panelOrder` still
 * shuffles the display order INSIDE each wrongly-composed chunk — and a
 * comparison-set bias that nothing downstream would ever report. So the function
 * is not merely discouraged: it is unreachable from any barrel. Every other
 * invariant on this branch is structural; this one is too.
 */

describe('chunkItems is not reachable from a barrel', () => {
  it('is absent from the package index', () => {
    expect('chunkItems' in engine).toBe(false);
  });

  it('is absent from src/rank and src/panels', () => {
    expect('chunkItems' in rank).toBe(false);
    expect('chunkItems' in panels).toBe(false);
  });

  it('still exists in its own module, where orderedChunks calls it', () => {
    // Not deleted — `orderedChunks` is a thin wrapper over it, and the tests that
    // demonstrate the defect need the wrong function to demonstrate it with.
    expect(typeof chunk.chunkItems).toBe('function');
  });

  it('leaves orderedChunks as the only chunking function a caller can find', () => {
    expect(typeof engine.orderedChunks).toBe('function');
    expect(typeof engine.balancedChunks).toBe('function');
    // `balancedChunks` returns SIZES, not slices, so it cannot be mistaken for a
    // way to chunk products in the order they arrived.
    expect(engine.balancedChunks(44)).toEqual([22, 22]);
  });
});
