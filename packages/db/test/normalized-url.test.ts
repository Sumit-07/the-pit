/**
 * `normalized_url` is produced by the engine's function and by nothing else.
 *
 * `brief §2.5` keys the per-product submission cap on the normalized URL. A
 * second implementation of the rules is a documented bypass: anywhere the two
 * disagree, one page has two identities and the cap does not apply. The first
 * test here is therefore an identity check, not a behavioural one — behaviour can
 * agree today and drift tomorrow.
 */

import { normalizeUrl as engineNormalizeUrl } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { normalizeUrl } from '../src/normalized-url.js';

describe('the package re-exports rather than reimplements', () => {
  it('is the very same function object as the engine exports', () => {
    // The only assertion that survives someone writing a "small compatible
    // helper" here later.
    expect(normalizeUrl).toBe(engineNormalizeUrl);
  });
});

describe('the §2.5 rules the cap depends on', () => {
  /** Each case names the evasion the rule closes. */
  const cases: [name: string, input: string, expected: string][] = [
    ['lowercases', 'HTTPS://Example.COM/Path', 'example.com/path'],
    ['strips the protocol', 'https://example.com', 'example.com'],
    ['strips www.', 'https://www.example.com', 'example.com'],
    ['strips the trailing slash', 'https://example.com/', 'example.com'],
    ['drops a UTM tail', 'https://example.com/a?utm_source=x&utm_campaign=y', 'example.com/a'],
    ['drops an affiliate parameter', 'https://example.com/a?ref=partner123', 'example.com/a'],
    ['drops the fragment', 'https://example.com/a#pricing', 'example.com/a'],
    ['reads a bare host as https', 'example.com/a', 'example.com/a'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('collapses every variant of one page onto one identity', () => {
    // The point of the column: these are the same submission, and the cap must
    // see them as one.
    const variants = [
      'https://www.Example.com/pricing/',
      'http://example.com/pricing?utm_source=hn',
      'example.com/pricing#top',
    ];
    expect(new Set(variants.map(normalizeUrl))).toEqual(new Set(['example.com/pricing']));
  });

  it('keeps genuinely different pages apart', () => {
    // The cap is per product, not per domain (`brief §2.4`: "Someone with four
    // side projects should be able to submit all four tonight").
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/b'));
  });
});

describe('shortener resolution is deferred, and visibly so', () => {
  it('leaves a shortened URL as the shortener', () => {
    // `brief §2.5` also asks for shorteners to be resolved to their target. That
    // needs an SSRF-guarded fetcher and is Phase 3 work; `src/normalized-url.ts`
    // documents exactly why and what the guard has to do. Until then a shortened
    // URL and its target are two identities, which `§2.5` softens by making
    // evasion a flag-for-review rather than a hard block.
    expect(normalizeUrl('https://bit.ly/3xYzAbC')).toBe('bit.ly/3xyzabc');
  });

  it('performs no I/O', () => {
    // Synchronous by signature, so it cannot be quietly turned into a fetch
    // without every caller changing.
    expect(normalizeUrl('https://bit.ly/x')).not.toBeInstanceOf(Promise);
  });
});

describe('refusals', () => {
  it('refuses a non-http scheme rather than normalizing it to something misleading', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/expected an http\(s\) URL/);
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/expected an http\(s\) URL/);
  });

  it('refuses an empty URL', () => {
    expect(() => normalizeUrl('   ')).toThrow(/is empty/);
  });
});
