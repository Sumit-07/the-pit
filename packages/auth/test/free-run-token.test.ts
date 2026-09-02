/**
 * The free-run token, and the message that carries it.
 *
 * This token is the only thing standing between a mailbox and one free run, so
 * the properties tested here are not conveniences:
 *
 *   1. It cannot be produced without a secret from the keyring.
 *   2. It cannot be moved to another submission or another address.
 *   3. It stops working after a day.
 *   4. It cannot verify as a `run-status` token, and vice versa.
 *
 * Every one of those is a signing-input question, which is why the namespace and
 * the expiry are IN the MAC and not beside it.
 */

import { describe, expect, it } from 'vitest';

import {
  FREE_RUN_TOKEN_TTL_MS,
  mintFreeRunToken,
  verifyFreeRunToken,
} from '../src/session/free-run-token.js';
import { mintRunStatusToken, verifyRunStatusToken } from '../src/session/run-status-token.js';
import { freeRunConfirmUrl, freeRunIdempotencyKey, renderFreeRunEmail } from '../src/mail/free-run-render.js';
import type { SessionKeyring } from '../src/session/cookie.js';

const KEYRING: SessionKeyring = ['a-secret-of-entirely-adequate-length-0123456789'];
const OTHER: SessionKeyring = ['a-different-secret-of-adequate-length-9876543210'];

const SUBMISSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SUBMISSION = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EMAIL = 'founder@example.com';

const AT = new Date('2026-06-01T20:00:00.000Z');
const WITHIN_THE_DAY = new Date(AT.getTime() + FREE_RUN_TOKEN_TTL_MS - 1000);
const AFTER = new Date(AT.getTime() + FREE_RUN_TOKEN_TTL_MS);

function mint(overrides: { submissionId?: string; email?: string; issuedAt?: Date } = {}): string {
  return mintFreeRunToken(
    {
      submissionId: overrides.submissionId ?? SUBMISSION,
      email: overrides.email ?? EMAIL,
      issuedAt: overrides.issuedAt ?? AT,
    },
    KEYRING,
  );
}

describe('the free-run token', () => {
  it('verifies for the submission and address it was minted for', () => {
    const claim = verifyFreeRunToken(SUBMISSION, mint(), KEYRING, AT);

    expect(claim).not.toBeNull();
    expect(claim?.email).toBe(EMAIL);
    expect(claim?.submissionId).toBe(SUBMISSION);
    expect(claim?.expiresAt.toISOString()).toBe(new Date(AT.getTime() + FREE_RUN_TOKEN_TTL_MS).toISOString());
  });

  it('refuses a token minted for another submission', () => {
    expect(verifyFreeRunToken(OTHER_SUBMISSION, mint(), KEYRING, AT)).toBeNull();
  });

  it('refuses a token signed with a secret that is not ours', () => {
    expect(verifyFreeRunToken(SUBMISSION, mintFreeRunToken({ submissionId: SUBMISSION, email: EMAIL, issuedAt: AT }, OTHER), KEYRING, AT)).toBeNull();
  });

  it('refuses an address edited in the URL', () => {
    // The address is inside the MAC, so swapping it for somebody else's — the
    // one edit that would matter, because the account is created from it — does
    // not verify.
    const token = mint();
    const [expiry, , signature] = token.split('.') as [string, string, string];
    const forged = [expiry, Buffer.from('attacker@example.com').toString('base64url'), signature].join('.');

    expect(verifyFreeRunToken(SUBMISSION, forged, KEYRING, AT)).toBeNull();
  });

  it('refuses an expiry pushed forward in the URL', () => {
    const token = mint();
    const [, email, signature] = token.split('.') as [string, string, string];
    const forged = [String(AFTER.getTime() + 86_400_000), email, signature].join('.');

    expect(verifyFreeRunToken(SUBMISSION, forged, KEYRING, AT)).toBeNull();
  });

  it('works for its whole day and not a millisecond past it', () => {
    expect(verifyFreeRunToken(SUBMISSION, mint(), KEYRING, WITHIN_THE_DAY)).not.toBeNull();
    expect(verifyFreeRunToken(SUBMISSION, mint(), KEYRING, AFTER)).toBeNull();
  });

  it('survives a keyring rotation for the rest of its day', () => {
    const token = mint();
    // The new secret is first; yesterday's is still on the ring.
    expect(verifyFreeRunToken(SUBMISSION, token, [OTHER[0] as string, KEYRING[0]], WITHIN_THE_DAY)).not.toBeNull();
  });

  it('refuses nonsense without throwing', () => {
    for (const junk of ['', 'not-a-token', 'a.b', 'a.b.c.d', '1e99.abc.def', '../../etc/passwd']) {
      expect(verifyFreeRunToken(SUBMISSION, junk, KEYRING, AT), junk).toBeNull();
    }
    expect(verifyFreeRunToken(SUBMISSION, undefined, KEYRING, AT)).toBeNull();
  });

  it('cannot be swapped with a run-status token in either direction', () => {
    // Same keyring, different namespace. A status link a customer shared must not
    // be replayable as a grant, and a grant token must not open as a status page
    // for a submission it does not name.
    const free = mint();
    const status = mintRunStatusToken(SUBMISSION, KEYRING);

    expect(verifyRunStatusToken(SUBMISSION, free, KEYRING)).toBe(false);
    expect(verifyFreeRunToken(SUBMISSION, status, KEYRING, AT)).toBeNull();
  });
});

describe('the confirmation email', () => {
  const message = renderFreeRunEmail({
    email: EMAIL,
    from: 'The Pit <no-reply@thepit.show>',
    name: 'Margin',
    confirmUrl: freeRunConfirmUrl('https://thepit.show/free/confirm', SUBMISSION, mint()),
    idempotencyKey: freeRunIdempotencyKey(SUBMISSION),
  });

  it('carries both bodies and one button', () => {
    expect(message.to).toBe(EMAIL);
    expect(message.subject).toBe('Start your verdict');
    expect(message.text).toContain('Start your verdict');
    expect(message.html).toContain('Start my verdict');
    // One action. A second link in this message is a second thing to press wrong.
    expect([...message.html.matchAll(/<a href=/g)]).toHaveLength(1);
  });

  it('links to a page that starts nothing, and says so', () => {
    // The Outlook Safe Links defence, in the copy: "press" is the instruction
    // because the GET renders a button and the POST does the work.
    expect(message.text).toContain('Press the button.');
    expect(message.html).toContain('https://thepit.show/free/confirm?s=');
    expect(message.html).toContain('&amp;t=');
  });

  it('keeps every sentence under twenty words', () => {
    const sentences = message.text
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((part) => part.trim())
      .filter((part) => part !== '' && !part.startsWith('https://'));

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/u).filter((word) => /[A-Za-z]{2,}/u.test(word)).length;
      expect(words, sentence).toBeLessThanOrEqual(20);
    }
  });

  it('names the product, escaped', () => {
    const hostile = renderFreeRunEmail({
      email: EMAIL,
      from: 'The Pit <no-reply@thepit.show>',
      name: '<script>alert(1)</script>',
      confirmUrl: 'https://thepit.show/free/confirm?s=x&t=y',
      idempotencyKey: 'free-run:x',
    });

    expect(hostile.html).not.toContain('<script>alert');
    expect(hostile.html).toContain('&lt;script&gt;');
    // The URL is escaped too — `&` in a query string is an entity in HTML.
    expect(hostile.html).toContain('s=x&amp;t=y');
  });

  it('keys the send on the submission and never on the token', () => {
    const key = freeRunIdempotencyKey(SUBMISSION);

    expect(key).toMatch(/^free-run:[0-9a-f]{32}$/);
    expect(key).not.toContain(SUBMISSION);
    // An idempotency key is displayed in a provider dashboard, a delivery log and
    // a bounce report. A bearer credential must not be in any of the three.
    expect(message.idempotencyKey).not.toContain(mint());
  });
});
