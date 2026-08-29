import { describe, expect, it } from 'vitest';

import { materialChange, normalizeDescription, tokenize } from '../../src/submission/material-change.js';

const ORIGINAL = 'A fast Rust web server for edge deploys';

describe('materialChange (brief §2.4: require materially changed description text)', () => {
  it('rejects the identical description', () => {
    const result = materialChange(ORIGINAL, ORIGINAL);
    expect(result).toEqual({ material: false, similarity: 1, tokenDelta: 0, identical: true });
  });

  it('rejects a description that differs only in case and punctuation', () => {
    const result = materialChange(ORIGINAL, 'a fast rust web server, for edge deploys.');
    expect(result.identical).toBe(true);
    expect(result.material).toBe(false);
  });

  it('rejects the same words in a different order', () => {
    // The case a string comparison would let through and an edit-distance
    // measure would call a large change. Shuffling a sentence is not a re-pitch.
    const result = materialChange(ORIGINAL, 'deploys edge for server web Rust fast a');
    expect(result.identical).toBe(false);
    expect(result.similarity).toBe(1);
    expect(result.tokenDelta).toBe(0);
    expect(result.material).toBe(false);
  });

  it('rejects a one-word swap', () => {
    // before = {a,fast,rust,web,server,for,edge,deploys}      (8)
    // after  = {a,fast,rust,web,server,for,edge,deployments}  (8)
    // intersection 7, union 9 -> similarity 7/9, tokenDelta 2.
    const result = materialChange(ORIGINAL, 'A fast Rust web server for edge deployments');
    expect(result.similarity).toBeCloseTo(7 / 9, 12);
    expect(result.tokenDelta).toBe(2);
    // Under the 0.8 similarity ceiling, but under the 3-token floor as well —
    // both conditions must hold, which is what stops a short description being
    // "rewritten" by touching one word.
    expect(result.material).toBe(false);
  });

  it('accepts a genuine rewrite', () => {
    // after = {a,slow,python,api,gateway,for,cloud,teams} (8)
    // intersection {a,for} = 2, union 14 -> similarity 1/7, tokenDelta 12.
    const result = materialChange(ORIGINAL, 'A slow Python API gateway for cloud teams');
    expect(result.similarity).toBeCloseTo(1 / 7, 12);
    expect(result.tokenDelta).toBe(12);
    expect(result.material).toBe(true);
  });

  it('accepts a rewrite that keeps the subject but changes the claim', () => {
    // before 8 tokens; after = {rust,edge,server,that,cold,starts,in,under,one,millisecond} (10)
    // intersection {rust,edge,server} = 3, union 15 -> similarity 0.2, delta 12.
    const result = materialChange(ORIGINAL, 'Rust edge server that cold starts in under one millisecond');
    expect(result.similarity).toBeCloseTo(0.2, 12);
    expect(result.tokenDelta).toBe(12);
    expect(result.material).toBe(true);
  });

  it('treats a changed number as a changed claim', () => {
    const result = materialChange('Ships builds 10x faster than webpack for large monorepos', 'Ships builds 100x faster than webpack for tiny monorepos');
    // {10x, large} out, {100x, tiny} in: intersection 7, union 11 -> 7/11, delta 4.
    expect(result.tokenDelta).toBe(4);
    expect(result.similarity).toBeCloseTo(7 / 11, 12);
    expect(result.material).toBe(true);
  });

  it('honours a caller-supplied threshold, so the rule is enforced rather than incidental', () => {
    const strict = materialChange(ORIGINAL, 'A slow Python API gateway for cloud teams', { maxSimilarity: 0.1 });
    expect(strict.material).toBe(false);
    const loose = materialChange(ORIGINAL, 'A fast Rust web server for edge deployments', { minTokenDelta: 2 });
    expect(loose.material).toBe(true);
  });

  it('does not fall over on empty text', () => {
    expect(materialChange('', '')).toEqual({ material: false, similarity: 1, tokenDelta: 0, identical: true });
  });
});

describe('tokenize', () => {
  it('drops punctuation and keeps digits', () => {
    expect(tokenize('State-of-the-art: 10x faster!')).toEqual(['state', 'of', 'the', 'art', '10x', 'faster']);
  });

  it('keeps non-ASCII letters', () => {
    expect(tokenize('Café für Entwickler')).toEqual(['café', 'für', 'entwickler']);
  });
});

describe('normalizeDescription', () => {
  it('is what the description hash is taken over', () => {
    expect(normalizeDescription('  A fast Rust web server.  ')).toBe('a fast rust web server');
  });
});
