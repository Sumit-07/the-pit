/**
 * The capability slug is a bearer credential in a URL, so "unguessable" has to
 * be an assertion rather than a claim in a comment.
 *
 * Uniqueness alone proves nothing. `slug = String(counter++)` is unique. So is
 * `sha256(email)`. So is a 43-character string built from `Math.random()`, which
 * would pass a uniqueness test over a million samples and still be fully
 * predictable to anyone who has seen a handful of outputs. The tests below
 * therefore go after the two properties that actually distinguish a secret from
 * an identifier — how many bits it carries, and WHERE those bits came from —
 * and the base64url expectations are hand-derived from the byte values rather
 * than pasted from a run.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CSPRNG,
  CAPABILITY_SLUG_BYTES,
  CAPABILITY_SLUG_LENGTH,
  CAPABILITY_SLUG_MIN_BITS,
  CAPABILITY_SLUG_PATTERN,
  capabilityPath,
  capabilityUrl,
  isCapabilitySlug,
  mintCapabilitySlug,
} from '../src/index.js';

describe('how many bits a slug carries', () => {
  it('meets the 128-bit floor with room to spare — 256 bits', () => {
    expect(CAPABILITY_SLUG_MIN_BITS).toBe(128);
    expect(CAPABILITY_SLUG_BYTES * 8).toBe(256);
    expect(CAPABILITY_SLUG_BYTES * 8).toBeGreaterThanOrEqual(CAPABILITY_SLUG_MIN_BITS);
  });

  it('spends every one of those bits on the wire: 43 base64url characters', () => {
    // ceil(256 / 6) = 43. A shorter string could not carry 256 bits, so the
    // length is a check on the encoding as well as on the source.
    expect(CAPABILITY_SLUG_LENGTH).toBe(43);
    expect(Math.ceil((CAPABILITY_SLUG_BYTES * 8) / 6)).toBe(CAPABILITY_SLUG_LENGTH);
    expect(mintCapabilitySlug()).toHaveLength(43);
  });

  it('draws exactly that many bytes from its source, and no fewer', () => {
    // The assertion that fails if someone "optimizes" the mint down to 16 bytes
    // while leaving every other property — pattern, uniqueness — intact.
    const asked: number[] = [];
    mintCapabilitySlug((size) => {
      asked.push(size);
      return Buffer.alloc(size);
    });
    expect(asked).toEqual([32]);
  });

  it('refuses to mint from a source that short-changes it', () => {
    // A stub, a mock, or a polyfill that returns fewer bytes would otherwise
    // produce a shorter and weaker slug that still matches the pattern for its
    // length. Failing loudly is the only outcome that is not a silent downgrade.
    expect(() => mintCapabilitySlug(() => Buffer.alloc(8))).toThrow(/returned 8 bytes, expected 32/);
  });
});

describe('where the bits come from', () => {
  it('is node:crypto randomBytes — the OS CSPRNG — by identity', () => {
    // THE test. `Math.random()` is a per-process generator whose entire future
    // output is recoverable from a few samples; a slug built on it would still
    // be 43 characters, still match the pattern, and still never repeat in any
    // test. Comparing the function by reference is the only assertion that
    // notices the swap.
    expect(CAPABILITY_CSPRNG).toBe(randomBytes);
  });

  it('encodes its source bytes and nothing else — bytes 0x00..0x1f', () => {
    // Hand-derived. Bytes 0,1,2 are 000000 000000 000100 000010 -> indices
    // 0,0,4,2 -> "AAEC", and so on for ten groups, with the final two bytes
    // (0x1e,0x1f) giving 7,33,60 -> "Hh8". base64url drops the padding.
    const counting = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    expect(mintCapabilitySlug(() => counting)).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  });

  it('uses the URL-safe alphabet: `-` and `_`, never `+`, `/` or `=`', () => {
    // All-ones bytes select index 63 repeatedly, which is `/` in standard
    // base64 and `_` in base64url. The trailing two bytes give 63,63,60 -> "__8".
    // A slug carrying `/` would break the `/a/<slug>` route; one carrying `+`
    // or `=` would survive a link and die in a query string.
    const allOnes = Buffer.alloc(32, 0xff);
    expect(mintCapabilitySlug(() => allOnes)).toBe(`${'_'.repeat(42)}8`);
  });
});

describe('the shape of a real one', () => {
  it('matches the pattern the route and the column both enforce', () => {
    expect(CAPABILITY_SLUG_PATTERN.source).toBe('^[A-Za-z0-9_-]{43}$');
    expect(isCapabilitySlug(mintCapabilitySlug())).toBe(true);
  });

  it('rejects everything that is not one', () => {
    for (const bad of [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(44),
      // Path traversal and separators — the reason the route checks before the store.
      '../../../etc/passwd',
      `${'a'.repeat(42)}/`,
      // Standard-base64 characters that a mis-encoded mint would emit.
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}=`,
    ]) {
      expect(`${JSON.stringify(bad)}: ${isCapabilitySlug(bad)}`).toBe(`${JSON.stringify(bad)}: false`);
    }
  });
});

describe('unguessable in the ways that matter', () => {
  it('does not repeat across a large sample', () => {
    const slugs = new Set(Array.from({ length: 2000 }, () => mintCapabilitySlug()));
    expect(slugs.size).toBe(2000);
  });

  it('reaches every character in the alphabet — a degenerate source would not', () => {
    // 1000 slugs is 43,000 draws over a 64-symbol alphabet. The chance that any
    // one symbol is missing is about 64 * (63/64)^43000, which is smaller than
    // 1e-290: this is deterministic in practice, and it fails immediately for a
    // source stuck on a narrow range of bytes.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      for (const character of mintCapabilitySlug()) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(64);
  });

  it('is not sequential — consecutive slugs share almost no positions', () => {
    // `counter++`, a timestamp, or anything derived from an incrementing value
    // leaves long shared prefixes. Two independent 43-character draws over 64
    // symbols agree in 43/64 ~= 0.67 positions on average; ten or more shared
    // positions is a ~1e-9 event per pair, so this fails loudly on structure
    // and never on chance.
    let previous = mintCapabilitySlug();
    for (let i = 0; i < 200; i += 1) {
      const next = mintCapabilitySlug();
      let shared = 0;
      for (let position = 0; position < CAPABILITY_SLUG_LENGTH; position += 1) {
        if (previous[position] === next[position]) {
          shared += 1;
        }
      }
      expect(shared).toBeLessThan(10);
      previous = next;
    }
  });

  it('is not derived from anything — the mint has no account to derive from', () => {
    // A slug that were `sha256(email)` or a function of `accounts.id` would be
    // guessable by anyone holding the input, and both inputs are things we
    // publish or log.
    //
    // Two facts together rule that out. First, the mint has no REQUIRED
    // parameter — `Function.length` counts arguments before the first default,
    // so zero means there is no account, email or id it could be a function of.
    expect(mintCapabilitySlug.length).toBe(0);

    // Second, its output is a pure function of its byte source and nothing else:
    // the same bytes give the same slug, so no hidden input is mixed in. The
    // encoding test above pins what that function is.
    const fixed = Buffer.from(Array.from({ length: 32 }, () => 7));
    expect(mintCapabilitySlug(() => fixed)).toBe(mintCapabilitySlug(() => fixed));

    // And with the real source, two mints for what would be "the same account"
    // differ — there is no account-derived component to make them agree.
    expect(mintCapabilitySlug()).not.toBe(mintCapabilitySlug());
  });
});

describe('building the URL', () => {
  it('lives at /a/<slug>', () => {
    expect(capabilityPath('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')).toBe(
      '/a/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
  });

  it('does not produce a protocol-relative URL when the origin has a trailing slash', () => {
    // `origin + '/a/' + slug` on `https://thepit.show/` yields `//a/...`, which
    // some proxies read as protocol-relative and send somewhere else entirely.
    const slug = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    expect(capabilityUrl('https://thepit.show/', slug)).toBe(`https://thepit.show/a/${slug}`);
    expect(capabilityUrl('https://thepit.show', slug)).toBe(`https://thepit.show/a/${slug}`);
  });
});
