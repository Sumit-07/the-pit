/**
 * `brief §2.1`: "Session cookie, signed, 90 days."
 *
 * The tampering tests are the reason this file exists. A signed cookie that
 * verifies a payload nobody checked is a cookie that lets anyone type
 * `accountId` and become that account, and the failure is completely silent —
 * everything works, for everyone, including the attacker.
 *
 * The signature expectations are re-derived here from the FORMAT (`HMAC-SHA256`
 * over `v1.<payload>`, base64url) using `node:crypto` directly, rather than
 * copied out of a run of `signSessionCookie`. That way a change to what is
 * signed fails a test instead of updating one.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  INSECURE_SESSION_COOKIE_NAME,
  MIN_SESSION_SECRET_LENGTH,
  newSessionPayload,
  readCookie,
  readSession,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signSessionCookie,
  verifySessionCookie,
  type SessionKeyring,
} from '../src/index.js';
import { TEST_SECRET, TEST_SECRET_OLD } from './helpers/fixtures.js';

const KEYRING: SessionKeyring = [TEST_SECRET];
const NOW = new Date('2026-03-01T12:00:00.000Z');
const SESSION = newSessionPayload({ accountId: 'acct_7', email: 'alice@example.com', now: NOW });

describe('the session payload', () => {
  it('lasts 90 days', () => {
    expect(SESSION_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
    // 2026-03-01 + 90 days = 2026-05-30 (March 31 + April 30 + May 30 = 91... so
    // 30 days of March remaining after the 1st, then 30 April, then 30 May).
    expect(new Date(SESSION.expiresAt * 1000).toISOString()).toBe('2026-05-30T12:00:00.000Z');
  });

  it('carries the account and the address, and nothing else', () => {
    expect(Object.keys(SESSION).sort()).toEqual(['accountId', 'email', 'expiresAt', 'issuedAt']);
  });
});

describe('signing', () => {
  it('is HMAC-SHA256 over `v1.<payload>`, base64url', () => {
    const cookie = signSessionCookie(SESSION, KEYRING);
    const [version, payload, signature] = cookie.split('.');

    expect(version).toBe('v1');
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toEqual(SESSION);
    expect(signature).toBe(
      createHmac('sha256', TEST_SECRET).update(`v1.${payload ?? ''}`, 'utf8').digest('base64url'),
    );
  });

  it('covers the version prefix, so a v2 cookie cannot be downgraded to v1', () => {
    const cookie = signSessionCookie(SESSION, KEYRING);
    const [, payload, signature] = cookie.split('.');
    const withoutVersion = createHmac('sha256', TEST_SECRET).update(payload ?? '', 'utf8').digest('base64url');

    expect(signature).not.toBe(withoutVersion);
  });

  it('refuses a secret short enough to guess', () => {
    expect(MIN_SESSION_SECRET_LENGTH).toBe(32);
    expect(() => signSessionCookie(SESSION, ['hunter2'])).toThrow(/at least 32/);
  });
});

describe('verifying', () => {
  it('accepts what it signed', () => {
    const result = verifySessionCookie(signSessionCookie(SESSION, KEYRING), KEYRING, NOW);
    expect(result).toEqual({ valid: true, session: SESSION });
  });

  it('rejects a tampered payload — the whole point of the signature', () => {
    const cookie = signSessionCookie(SESSION, KEYRING);
    const [version, , signature] = cookie.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...SESSION, accountId: 'acct_somebody_else' }),
      'utf8',
    ).toString('base64url');

    const result = verifySessionCookie(`${version ?? ''}.${forged}.${signature ?? ''}`, KEYRING, NOW);
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered signature', () => {
    const cookie = signSessionCookie(SESSION, KEYRING);
    const flipped = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');

    expect(cookie).not.toBe(flipped);
    expect(verifySessionCookie(flipped, KEYRING, NOW)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a payload extended with an expiry a hundred years out', () => {
    // The greedy version of the attack: keep the identity, move the clock.
    const forged = Buffer.from(
      JSON.stringify({ ...SESSION, expiresAt: SESSION.expiresAt + 100 * 365 * 24 * 3600 }),
      'utf8',
    ).toString('base64url');
    const signature = signSessionCookie(SESSION, KEYRING).split('.')[2] ?? '';

    expect(verifySessionCookie(`v1.${forged}.${signature}`, KEYRING, NOW)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSessionCookie(SESSION, [TEST_SECRET_OLD]);
    expect(verifySessionCookie(cookie, KEYRING, NOW)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a cookie with no signature at all', () => {
    const [version, payload] = signSessionCookie(SESSION, KEYRING).split('.');
    expect(verifySessionCookie(`${version ?? ''}.${payload ?? ''}`, KEYRING, NOW)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects an unsigned "alg: none" shaped cookie', () => {
    const payload = Buffer.from(JSON.stringify(SESSION), 'utf8').toString('base64url');
    expect(verifySessionCookie(`v1.${payload}.`, KEYRING, NOW)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects an expired session, at the second it expires', () => {
    const cookie = signSessionCookie(SESSION, KEYRING);
    const expiry = new Date(SESSION.expiresAt * 1000);

    expect(verifySessionCookie(cookie, KEYRING, new Date(expiry.getTime() - 1000)).valid).toBe(true);
    expect(verifySessionCookie(cookie, KEYRING, expiry)).toEqual({ valid: false, reason: 'expired' });
  });

  it('reports a missing cookie as missing, not as an attack', () => {
    expect(verifySessionCookie(undefined, KEYRING, NOW)).toEqual({ valid: false, reason: 'missing' });
    expect(verifySessionCookie('', KEYRING, NOW)).toEqual({ valid: false, reason: 'missing' });
  });

  it('checks the signature BEFORE reading the expiry out of the payload', () => {
    // An expiry read from an unverified payload is a number the attacker wrote.
    // A forged, long-expired cookie must come back `bad_signature` — if it came
    // back `expired`, the implementation trusted the payload first.
    const forged = Buffer.from(JSON.stringify({ ...SESSION, expiresAt: 0 }), 'utf8').toString('base64url');
    expect(verifySessionCookie(`v1.${forged}.notasignature`, KEYRING, NOW)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });
});

describe('key rotation', () => {
  it('signs with the newest secret and still accepts the old one', () => {
    const rotated: SessionKeyring = [TEST_SECRET, TEST_SECRET_OLD];
    const oldCookie = signSessionCookie(SESSION, [TEST_SECRET_OLD]);
    const newCookie = signSessionCookie(SESSION, rotated);

    expect(newCookie).not.toBe(oldCookie);
    expect(verifySessionCookie(oldCookie, rotated, NOW).valid).toBe(true);
    expect(verifySessionCookie(newCookie, rotated, NOW).valid).toBe(true);
  });

  it('logs everyone out when the old secret is dropped — the break-glass control', () => {
    const oldCookie = signSessionCookie(SESSION, [TEST_SECRET_OLD]);
    expect(verifySessionCookie(oldCookie, [TEST_SECRET], NOW).valid).toBe(false);
  });
});

describe('the Set-Cookie header', () => {
  const cookie = serializeSessionCookie('v1.payload.signature');

  it('uses the __Host- prefix, which the browser enforces', () => {
    // A __Host- cookie is only accepted with Secure, Path=/ and no Domain, so a
    // hostile *.vercel.app preview cannot set or overwrite the session.
    expect(SESSION_COOKIE_NAME).toBe('__Host-pit_session');
    expect(cookie.startsWith('__Host-pit_session=v1.payload.signature;')).toBe(true);
  });

  it('is HttpOnly, so an XSS bug cannot exfiltrate a 90-day credential', () => {
    expect(cookie).toContain('HttpOnly');
  });

  it('is Secure and Path=/, which __Host- requires', () => {
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });

  it('is SameSite=Lax, not Strict — the session begins by following a mail link', () => {
    // Strict would withhold the cookie on the very navigation that sets it up.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=Strict');
  });

  it('expires in the browser at 90 days too', () => {
    expect(cookie).toContain('Max-Age=7776000');
  });

  it('drops both the Secure flag and the __Host- name on plain http', () => {
    // A __Host- cookie without Secure is silently discarded by the browser, so
    // the local-development variant has to change its name as well as its flags.
    const local = serializeSessionCookie('v1.payload.signature', { secure: false });
    expect(local.startsWith(`${INSECURE_SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(local).not.toContain('Secure');
  });

  it('clears with an empty value and Max-Age=0', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
    expect(clearSessionCookie()).toContain('__Host-pit_session=;');
  });
});

describe('reading the cookie off a request', () => {
  it('picks the right one out of a list', () => {
    const header = `other=1; ${SESSION_COOKIE_NAME}=abc.def.ghi; another=2`;
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe('abc.def.ghi');
  });

  it('keeps `=` inside the value, which base64url padding can produce', () => {
    expect(readCookie('x=a=b=c', 'x')).toBe('a=b=c');
  });

  it('returns undefined for a header that does not carry it', () => {
    expect(readCookie('other=1', SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('verifies end to end from a Cookie header', () => {
    const value = signSessionCookie(SESSION, KEYRING);
    const result = readSession({
      cookieHeader: `${SESSION_COOKIE_NAME}=${value}`,
      keyring: KEYRING,
      now: NOW,
    });
    expect(result).toEqual({ valid: true, session: SESSION });
  });

  it('does not read the insecure cookie name when Secure cookies are expected', () => {
    // Otherwise an attacker on a subdomain sets `pit_session` over plain http and
    // the server accepts it in place of the __Host- one.
    const value = signSessionCookie(SESSION, KEYRING);
    const result = readSession({
      cookieHeader: `${INSECURE_SESSION_COOKIE_NAME}=${value}`,
      keyring: KEYRING,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'missing' });
  });
});
