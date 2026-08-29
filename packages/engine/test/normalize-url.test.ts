import { describe, expect, it } from 'vitest';

import { normalizeUrl } from '../src/ingest/normalize-url.js';

describe('normalizeUrl', () => {
  it('strips the protocol', () => {
    expect(normalizeUrl('https://example.com/pricing')).toBe('example.com/pricing');
    expect(normalizeUrl('http://example.com/pricing')).toBe('example.com/pricing');
  });

  it('strips a www. prefix', () => {
    expect(normalizeUrl('https://www.example.com/pricing')).toBe('example.com/pricing');
  });

  it('keeps a www. that is the whole registrable domain', () => {
    expect(normalizeUrl('https://www.com/a')).toBe('www.com/a');
  });

  it('strips trailing slashes', () => {
    expect(normalizeUrl('https://example.com/')).toBe('example.com');
    expect(normalizeUrl('https://example.com')).toBe('example.com');
    expect(normalizeUrl('https://example.com/pricing/')).toBe('example.com/pricing');
  });

  it('lowercases', () => {
    expect(normalizeUrl('HTTPS://WWW.Example.COM/Pricing')).toBe('example.com/pricing');
  });

  it('drops every query parameter, which is what kills the referral variants', () => {
    const canonical = normalizeUrl('https://example.com/pricing');

    expect(normalizeUrl('https://example.com/pricing?utm_source=x&utm_medium=y')).toBe(canonical);
    expect(normalizeUrl('https://example.com/pricing?ref=affiliate-42')).toBe(canonical);
    expect(normalizeUrl('https://example.com/pricing?')).toBe(canonical);
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/pricing#plans')).toBe('example.com/pricing');
  });

  it('reduces every evasion variant of one page to a single key', () => {
    const variants = [
      'https://www.Example.com/Pricing/?utm_source=twitter#top',
      'http://example.com/pricing?ref=42',
      'HTTPS://WWW.EXAMPLE.COM/PRICING/',
      '  https://example.com/pricing  ',
    ];

    expect(new Set(variants.map(normalizeUrl))).toEqual(new Set(['example.com/pricing']));
  });

  it('reads a scheme-less URL as https', () => {
    expect(normalizeUrl('example.com/pricing')).toBe('example.com/pricing');
    expect(normalizeUrl('www.example.com')).toBe('example.com');
  });

  it('keeps a non-default port, because it is a different service', () => {
    expect(normalizeUrl('https://example.com:8080/a')).toBe('example.com:8080/a');
    expect(normalizeUrl('https://example.com:443/a')).toBe('example.com/a');
  });

  it('drops userinfo', () => {
    expect(normalizeUrl('https://user:secret@example.com/a')).toBe('example.com/a');
  });

  it('punycodes an internationalized host so one domain has one key', () => {
    expect(normalizeUrl('https://exämple.com/a')).toBe('xn--exmple-cua.com/a');
  });

  it('does not resolve a shortener, because nothing in this module performs I/O', () => {
    // The one rule of brief §2.5 that is not implemented HERE. It is implemented
    // in `@the-pit/fetch`'s `resolveProductUrl`, which follows the link through
    // an SSRF-guarded fetcher and then calls this function on the target — so
    // `bit.ly/3xYzAbC` and the page it points at share a key, without this
    // module ever opening a socket.
    expect(normalizeUrl('https://bit.ly/3xYzAbC')).toBe('bit.ly/3xyzabc');
  });

  it('fails loudly on input that is not an http(s) URL', () => {
    expect(() => normalizeUrl('')).toThrow(/empty/i);
    expect(() => normalizeUrl('   ')).toThrow(/empty/i);
    expect(() => normalizeUrl('mailto:sales@example.com')).toThrow(/http/i);
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/http/i);
    expect(() => normalizeUrl('https://')).toThrow();
  });
});
