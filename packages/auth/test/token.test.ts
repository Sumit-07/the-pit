/**
 * `brief §2.1`: "Store **SHA-256 of the token**, never the raw value. 15-minute
 * expiry, single use."
 *
 * The digests below are the published NIST test vectors for SHA-256, written out
 * rather than produced by running `hashToken` and pasting the answer. A test
 * whose expectation came from the implementation proves only that the
 * implementation is consistent with itself, which it would be if it were
 * base64-encoding SHA-1.
 */

import { describe, expect, it } from 'vitest';

import { hashToken, MAGIC_TOKEN_BYTES, MAGIC_TOKEN_TTL_MS, magicTokenExpiry, mintMagicToken } from '../src/index.js';

describe('hashToken', () => {
  it('is SHA-256, lowercase hex — the NIST vector for "abc"', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the published digest of the empty string', () => {
    expect(hashToken('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces the 64 lowercase hex characters the tokens table CHECKs for', () => {
    // `packages/db/src/schema/auth.ts`: check (token_hash ~ '^[0-9a-f]{64}$').
    expect(hashToken(mintMagicToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the input', () => {
    const raw = mintMagicToken();
    expect(hashToken(raw)).not.toBe(raw);
    expect(hashToken(raw)).not.toContain(raw);
  });

  it('is one-way in the only sense that matters here: no two tokens share a digest', () => {
    const digests = new Set(Array.from({ length: 200 }, () => hashToken(mintMagicToken())));
    expect(digests.size).toBe(200);
  });
});

describe('mintMagicToken', () => {
  it('carries 256 bits', () => {
    expect(MAGIC_TOKEN_BYTES).toBe(32);
  });

  it('is 43 unpadded base64url characters — 32 bytes, URL-safe', () => {
    // ceil(32 * 8 / 6) = 43. base64url uses `-` and `_`, never `+`, `/` or `=`,
    // so the token survives a query string and a form field unescaped.
    const token = mintMagicToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, mintMagicToken));
    expect(tokens.size).toBe(500);
  });
});

describe('expiry', () => {
  it('is 15 minutes, in milliseconds', () => {
    expect(MAGIC_TOKEN_TTL_MS).toBe(900_000);
  });

  it('adds exactly that to the issue time', () => {
    const issued = new Date('2026-03-01T12:00:00.000Z');
    expect(magicTokenExpiry(issued).toISOString()).toBe('2026-03-01T12:15:00.000Z');
  });

  it('never returns the issue time itself — the table refuses a token that expires when it is made', () => {
    // `tokens_expiry_after_creation`: expires_at > created_at.
    const issued = new Date('2026-03-01T12:00:00.000Z');
    expect(magicTokenExpiry(issued).getTime()).toBeGreaterThan(issued.getTime());
  });
});
