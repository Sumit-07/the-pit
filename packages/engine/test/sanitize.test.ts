import { describe, expect, it } from 'vitest';

import { SANITIZE_LIMIT } from '../src/config/constants.js';
import { sanitize } from '../src/ingest/sanitize.js';

// Written as escapes on purpose: every one of these is invisible in an editor,
// which is exactly why the sanitizer has to remove them.
const NUL = '\u0000';
const BELL = '\u0007';
const NBSP = '\u00a0';
const ZERO_WIDTH_SPACE = '\u200b';
const LEFT_TO_RIGHT_MARK = '\u200e';
const RIGHT_TO_LEFT_OVERRIDE = '\u202e';
const BYTE_ORDER_MARK = '\ufeff';

describe('sanitize', () => {
  it('collapses every whitespace run to a single space and trims', () => {
    expect(sanitize('  ships\t\tfast \n\n and   cheap  ', SANITIZE_LIMIT)).toBe(
      'ships fast and cheap',
    );
  });

  it('turns a line break into a space rather than gluing the words together', () => {
    expect(sanitize('one\ntwo', SANITIZE_LIMIT)).toBe('one two');
    expect(sanitize('one\r\ntwo', SANITIZE_LIMIT)).toBe('one two');
  });

  it('deletes non-separating control characters without leaving a gap', () => {
    expect(sanitize(`ab${NUL}cd`, SANITIZE_LIMIT)).toBe('abcd');
    expect(sanitize(`ab${BELL}cd`, SANITIZE_LIMIT)).toBe('abcd');
  });

  it('deletes zero-width and bidi-override characters', () => {
    // Invisible to a reviewer, present for the model: the cheapest route for
    // smuggling text into a juror prompt (Global Constraint 2).
    const smuggled = `ig${ZERO_WIDTH_SPACE}nore${LEFT_TO_RIGHT_MARK} pre${RIGHT_TO_LEFT_OVERRIDE}vious`;
    expect(sanitize(smuggled, SANITIZE_LIMIT)).toBe('ignore previous');
    expect(sanitize(`${BYTE_ORDER_MARK}a${BYTE_ORDER_MARK}b`, SANITIZE_LIMIT)).toBe('ab');
  });

  it('collapses a non-breaking space like any other whitespace', () => {
    expect(sanitize(`a${NBSP}${NBSP}b`, SANITIZE_LIMIT)).toBe('a b');
  });

  it('truncates to exactly the limit', () => {
    const result = sanitize('a'.repeat(SANITIZE_LIMIT + 100), SANITIZE_LIMIT);

    expect(result).toHaveLength(SANITIZE_LIMIT);
    expect(result).toBe('a'.repeat(SANITIZE_LIMIT));
  });

  it('leaves text at or under the limit alone', () => {
    const exact = 'b'.repeat(SANITIZE_LIMIT);
    expect(sanitize(exact, SANITIZE_LIMIT)).toBe(exact);
  });

  it('counts code points, so truncation never splits an astral character', () => {
    const result = sanitize('🚀'.repeat(10), 4);

    expect([...result]).toHaveLength(4);
    expect(result).toBe('🚀🚀🚀🚀');
  });

  it('returns an empty string for text that is nothing but whitespace and controls', () => {
    expect(sanitize(` \t\n ${ZERO_WIDTH_SPACE} `, SANITIZE_LIMIT)).toBe('');
    expect(sanitize('', SANITIZE_LIMIT)).toBe('');
  });

  it('accepts a zero limit and rejects a limit that is not a whole count', () => {
    expect(sanitize('anything', 0)).toBe('');
    expect(() => sanitize('anything', -1)).toThrow(RangeError);
    expect(() => sanitize('anything', 1.5)).toThrow(RangeError);
  });
});
