/**
 * Chunk balancing — `the-pit-build-brief.md` §1.4.
 *
 * Every expectation is written out as the arithmetic that produces it. The
 * fixtures are chosen to DISCRIMINATE: the whole point of the fix is that
 * `[22, 22]` is right and `[40, 4]` is wrong, so several tests assert the naive
 * `chunkSize: 40` behaviour is not produced. A fixture that passed against the
 * naive splitter would prove nothing.
 */

import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE } from '../../src/config/constants.js';
import { balancedChunks, chunkItems, partitionSizes } from '../../src/rank/chunk.js';

describe('balancedChunks — the cases named in `brief §1.4` and the plan', () => {
  // k = ceil(44/40) = 2;  44 / 2 = 22 exactly  ->  [22, 22]
  it('splits 44 into 22/22, NOT the naive 40/4', () => {
    expect(balancedChunks(44)).toEqual([22, 22]);
  });

  // k = ceil(48/40) = 2;  48 / 2 = 24 exactly  ->  [24, 24]
  it('splits 48 into 24/24, NOT the naive 40/8', () => {
    expect(balancedChunks(48)).toEqual([24, 24]);
  });

  // k = ceil(13/40) = 1;  13 / 1 = 13          ->  [13]
  it('leaves 13 as a single chunk', () => {
    expect(balancedChunks(13)).toEqual([13]);
  });

  // k = ceil(80/40) = 2;  80 / 2 = 40 exactly  ->  [40, 40]
  it('leaves an exact fill exact at 80', () => {
    expect(balancedChunks(80)).toEqual([40, 40]);
  });

  // k = ceil(81/40) = 3;  81 / 3 = 27 exactly  ->  [27, 27, 27]
  it('splits 81 into 27/27/27, NOT the naive 40/40/1', () => {
    expect(balancedChunks(81)).toEqual([27, 27, 27]);
  });
});

describe('balancedChunks — the naive splitter is not what is implemented', () => {
  /**
   * The naive `chunkSize: 40` splitter, written out so the difference is a
   * comparison rather than a claim. This is the DEFECT, kept in the test file as
   * the thing the implementation must not equal.
   */
  function naiveChunks(n: number, maxSize: number): number[] {
    const sizes: number[] = [];
    for (let remaining = n; remaining > 0; remaining -= maxSize) sizes.push(Math.min(maxSize, remaining));
    return sizes;
  }

  it('differs from the naive split on the seeded category that motivated the fix', () => {
    // Health, Fitness & Wellness has 44 usable products (`DECISIONS.md` S4).
    expect(naiveChunks(44, CHUNK_SIZE)).toEqual([40, 4]);
    expect(balancedChunks(44)).not.toEqual([40, 4]);
    expect(balancedChunks(44)).toEqual([22, 22]);
  });

  it('makes the same number of calls as the naive split, for every n', () => {
    // The correction is free: it re-balances the chunks without buying more calls.
    for (let n = 0; n <= 400; n += 1) {
      expect(balancedChunks(n).length).toBe(naiveChunks(n, CHUNK_SIZE).length);
    }
  });

  it('never leaves one chunk scored against a much smaller peer set', () => {
    // The naive split's failure mode: a 40-product chunk beside a 4-product one.
    for (let n = 1; n <= 400; n += 1) {
      const sizes = balancedChunks(n);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe('balancedChunks — decided edge cases', () => {
  it('returns no chunks for n = 0, rather than one empty chunk', () => {
    // ceil(0/40) = 0 calls. `[0]` would book a scoring call with no products.
    expect(balancedChunks(0)).toEqual([]);
  });

  it('returns a single chunk of one for n = 1', () => {
    expect(balancedChunks(1)).toEqual([1]);
  });

  // k = ceil(45/40) = 2; 45/2 is not an integer.
  // base = floor(45/2) = 22, remainder = 45 % 2 = 1  ->  [23, 22], summing to 45.
  it('distributes an indivisible remainder, largest chunk first, summing to n', () => {
    expect(balancedChunks(45)).toEqual([23, 22]);
    expect(balancedChunks(45).reduce((a, b) => a + b, 0)).toBe(45);
    // ceil(45 / 2) = 23 is the LARGEST chunk, not every chunk: [23, 23] would
    // sum to 46 and score one product twice.
    expect(balancedChunks(45)).not.toEqual([23, 23]);
  });

  // k = ceil(83/40) = 3; base = floor(83/3) = 27, remainder = 83 % 3 = 2
  //   -> [28, 28, 27], summing to 83.
  it('spreads a two-unit remainder over the first two chunks', () => {
    expect(balancedChunks(83)).toEqual([28, 28, 27]);
  });

  it('honours an explicit maxSize', () => {
    // k = ceil(10/4) = 3; base = 3, remainder = 1 -> [4, 3, 3]
    expect(balancedChunks(10, 4)).toEqual([4, 3, 3]);
    expect(balancedChunks(10, 10)).toEqual([10]);
    expect(balancedChunks(10, 1)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('defaults maxSize to CHUNK_SIZE', () => {
    expect(balancedChunks(44)).toEqual(balancedChunks(44, CHUNK_SIZE));
  });

  it('refuses inputs that could only produce a wrong call count', () => {
    expect(() => balancedChunks(-1)).toThrow(RangeError);
    expect(() => balancedChunks(2.5)).toThrow(RangeError);
    expect(() => balancedChunks(Number.NaN)).toThrow(RangeError);
    expect(() => balancedChunks(10, 0)).toThrow(RangeError);
    expect(() => balancedChunks(10, -4)).toThrow(RangeError);
    expect(() => balancedChunks(10, 1.5)).toThrow(RangeError);
  });
});

describe('balancedChunks — properties that must hold for every n', () => {
  const MAX_SIZES = [1, 2, 7, 40];

  it('produces sizes that sum to exactly n, so no product is dropped or duplicated', () => {
    for (const maxSize of MAX_SIZES) {
      for (let n = 0; n <= 250; n += 1) {
        const sizes = balancedChunks(n, maxSize);
        expect(sizes.reduce((total, size) => total + size, 0)).toBe(n);
      }
    }
  });

  it('never exceeds maxSize and never emits an empty chunk', () => {
    for (const maxSize of MAX_SIZES) {
      for (let n = 1; n <= 250; n += 1) {
        for (const size of balancedChunks(n, maxSize)) {
          expect(size).toBeGreaterThanOrEqual(1);
          expect(size).toBeLessThanOrEqual(maxSize);
        }
      }
    }
  });

  it('uses the fewest calls that respect the cap: ceil(n / maxSize)', () => {
    for (const maxSize of MAX_SIZES) {
      for (let n = 0; n <= 250; n += 1) {
        expect(balancedChunks(n, maxSize).length).toBe(Math.ceil(n / maxSize));
      }
    }
  });

  it('matches the brief formula: every chunk is ceil(n/k) or floor(n/k)', () => {
    for (let n = 1; n <= 250; n += 1) {
      const k = Math.ceil(n / CHUNK_SIZE);
      const sizes = balancedChunks(n);
      expect(Math.max(...sizes)).toBe(Math.ceil(n / k));
      expect(Math.min(...sizes)).toBe(Math.floor(n / k));
    }
  });
});

describe('partitionSizes', () => {
  it('splits into exactly the requested number of parts', () => {
    expect(partitionSizes(45, 15)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    // base = floor(44/15) = 2, remainder = 44 % 15 = 14 -> fourteen 3s then one 2.
    expect(partitionSizes(44, 15)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2]);
    expect(partitionSizes(44, 15).reduce((a, b) => a + b, 0)).toBe(44);
  });

  it('allows parts larger than n, emitting empty parts', () => {
    // Not reachable from `balancedChunks`; the calibration sampler guards on
    // candidate count before it partitions.
    expect(partitionSizes(2, 5)).toEqual([1, 1, 0, 0, 0]);
  });

  it('splits nothing into no parts, and refuses to split something into none', () => {
    expect(partitionSizes(0, 0)).toEqual([]);
    expect(() => partitionSizes(3, 0)).toThrow(RangeError);
  });

  it('refuses negative or fractional arguments', () => {
    expect(() => partitionSizes(-1, 2)).toThrow(RangeError);
    expect(() => partitionSizes(5, 1.5)).toThrow(RangeError);
  });
});

describe('chunkItems', () => {
  const products = Array.from({ length: 44 }, (_, index) => index);

  it('slices a 44-product category into two 22-product comparison sets', () => {
    const chunks = chunkItems(products);
    expect(chunks.map((chunk) => chunk.length)).toEqual([22, 22]);
    expect(chunks[0]?.[0]).toBe(0);
    expect(chunks[0]?.[21]).toBe(21);
    expect(chunks[1]?.[0]).toBe(22);
    expect(chunks[1]?.[21]).toBe(43);
  });

  it('preserves order and loses nothing, for every n', () => {
    for (let n = 0; n <= 130; n += 1) {
      const items = Array.from({ length: n }, (_, index) => index);
      expect(chunkItems(items, 7).flat()).toEqual(items);
    }
  });

  it('returns no chunks for an empty list', () => {
    expect(chunkItems([])).toEqual([]);
  });
});
