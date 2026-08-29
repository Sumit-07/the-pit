/**
 * The address is the account key (`brief §2.1`), so these assertions are about
 * identity, not formatting.
 */

import { describe, expect, it } from 'vitest';

import { isPlausibleEmail, MAX_EMAIL_LENGTH, normalizeEmail } from '../src/index.js';

describe('normalizeEmail', () => {
  it('lowercases, because the tokens table CHECKs email = lower(email)', () => {
    expect(normalizeEmail('Alice@Example.COM')).toBe('alice@example.com');
  });

  it('trims, so a pasted address with a trailing space is the same account', () => {
    expect(normalizeEmail('  alice@example.com \n')).toBe('alice@example.com');
  });

  it('does NOT strip Gmail dots — that would merge two paying customers', () => {
    // Same inbox at Gmail; different addresses almost everywhere else. Nothing
    // here can tell which, and getting it wrong is silent and unrecoverable.
    expect(normalizeEmail('a.b@gmail.com')).toBe('a.b@gmail.com');
    expect(normalizeEmail('a.b@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
  });

  it('does NOT strip plus tags — people use them to keep accounts apart', () => {
    expect(normalizeEmail('alice+pit@example.com')).toBe('alice+pit@example.com');
  });
});

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const address of [
      'alice@example.com',
      'alice+pit@example.co.uk',
      "o'brien@example.com",
      'a_b-c.d@sub.example.io',
    ]) {
      expect(isPlausibleEmail(address), address).toBe(true);
    }
  });

  it('rejects what cannot be an address at all', () => {
    for (const address of ['', 'alice', 'alice@', '@example.com', 'alice@example', 'a@@b.com']) {
      expect(isPlausibleEmail(address), JSON.stringify(address)).toBe(false);
    }
  });

  it('rejects an embedded newline — this string reaches a mail transport', () => {
    // Header injection: `To: a@b.com\nBcc: victim@x.com`.
    expect(isPlausibleEmail('a@b.com\nbcc: victim@example.com')).toBe(false);
    expect(isPlausibleEmail('a@b.com\r\nbcc: victim@example.com')).toBe(false);
  });

  it('rejects address-list and header punctuation', () => {
    for (const address of ['a@b.com,c@d.com', 'a@b.com;c@d.com', '<a@b.com>', 'a b@c.com']) {
      expect(isPlausibleEmail(address), address).toBe(false);
    }
  });

  it('rejects anything longer than RFC 5321 allows', () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    const long = `${'a'.repeat(250)}@example.com`;
    expect(long.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
    expect(isPlausibleEmail(long)).toBe(false);
  });
});
