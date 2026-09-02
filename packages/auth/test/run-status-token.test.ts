/**
 * The signature that lets a guest watch the run they paid for.
 *
 * `brief §2.1` is guest checkout, so the person refreshing the status page has no
 * session, no password and — until the webhook resolves one — no account. This is
 * the only proof they can hold, so what it is worth is exactly what these tests
 * say it is worth.
 */

import { describe, expect, it } from 'vitest';

import { signSessionCookie, verifySessionCookie, type SessionKeyring } from '../src/session/cookie.js';
import {
  mintRunStatusToken,
  RUN_STATUS_TOKEN_PARAM,
  verifyRunStatusToken,
} from '../src/session/run-status-token.js';

const SECRET = 'a-secret-that-is-at-least-32-characters';
const OTHER = 'a-different-secret-of-adequate-length';
const KEYRING: SessionKeyring = [SECRET];

const SUBMISSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SUBMISSION = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('minting and verifying', () => {
  it('opens the submission it was made for', () => {
    expect(verifyRunStatusToken(SUBMISSION, mintRunStatusToken(SUBMISSION, KEYRING), KEYRING)).toBe(true);
  });

  it('is deterministic, so a bookmark keeps working', () => {
    expect(mintRunStatusToken(SUBMISSION, KEYRING)).toBe(mintRunStatusToken(SUBMISSION, KEYRING));
  });

  it('does not open anybody else’s submission', () => {
    const mine = mintRunStatusToken(SUBMISSION, KEYRING);
    expect(verifyRunStatusToken(OTHER_SUBMISSION, mine, KEYRING)).toBe(false);
  });

  it('cannot be produced without the secret', () => {
    expect(verifyRunStatusToken(SUBMISSION, mintRunStatusToken(SUBMISSION, [OTHER]), KEYRING)).toBe(false);
  });

  it('treats a missing or empty token as a refusal, not a throw', () => {
    expect(verifyRunStatusToken(SUBMISSION, undefined, KEYRING)).toBe(false);
    expect(verifyRunStatusToken(SUBMISSION, '', KEYRING)).toBe(false);
  });

  it('refuses a token of the wrong shape without leaking its length', () => {
    expect(verifyRunStatusToken(SUBMISSION, 'short', KEYRING)).toBe(false);
    expect(verifyRunStatusToken(SUBMISSION, 'x'.repeat(500), KEYRING)).toBe(false);
  });

  it('accepts a link minted before a rotation, and stops when the old key is dropped', () => {
    const old = mintRunStatusToken(SUBMISSION, [OTHER]);
    expect(verifyRunStatusToken(SUBMISSION, old, [SECRET, OTHER])).toBe(true);
    expect(verifyRunStatusToken(SUBMISSION, old, [SECRET])).toBe(false);
  });

  it('refuses a keyring whose secret is too short to sign anything', () => {
    expect(() => mintRunStatusToken(SUBMISSION, ['tiny'])).toThrow(RangeError);
  });
});

/**
 * The status token and the session cookie share a keyring and must never share a
 * meaning. One opens a progress bar; the other is a 90-day sign-in.
 */
describe('it is not a session', () => {
  it('does not verify as a session cookie', () => {
    expect(verifySessionCookie(mintRunStatusToken(SUBMISSION, KEYRING), KEYRING, new Date()).valid).toBe(false);
  });

  it('a session cookie does not verify as a status token', () => {
    const cookie = signSessionCookie(
      {
        accountId: '99999999-8888-4777-8666-555555555555',
        email: 'payer@example.com',
        issuedAt: 1,
        expiresAt: 2,
      },
      KEYRING,
    );
    expect(verifyRunStatusToken(SUBMISSION, cookie, KEYRING)).toBe(false);
  });

  it('names the query parameter once, for everybody that reads it', () => {
    expect(RUN_STATUS_TOKEN_PARAM).toBe('t');
  });
});
