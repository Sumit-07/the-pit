/**
 * The token that turns a confirmed email into one free run.
 *
 * ## Why it looks like `run-status-token.ts` and is not that token
 *
 * Same keyring, same HMAC, different namespace. `mintRunStatusToken` signs
 * `run-status.v1:<submission id>` and opens a page; this signs
 * `free-run.v1:<submission id>` and, once, grants an attempt. A value produced by
 * one can never verify as the other, so a status link a customer shared cannot be
 * replayed as a grant — which is the whole reason the namespace is in the signing
 * input rather than beside it.
 *
 * ## Why it expires and the status token does not
 *
 * A status link is a permanent view of something already bought. This one moves
 * money's worth: it is a promise that whoever holds the mailbox may take a free
 * run, and a promise like that should not still be redeemable a year later out of
 * an old inbox. Twenty-four hours is long enough for somebody who read the mail on
 * a phone and finished at a desk.
 *
 * The expiry is IN the signed material and travels in the clear beside the
 * signature, so the token is self-describing and nothing has to be stored to
 * verify it. Editing the visible half invalidates the MAC.
 *
 * ## Why the address rides along
 *
 * The account this token grants against does not exist yet — that is the point of
 * the flow — and a `submissions` row carries no address, so at confirm time there
 * is nothing to resolve one from. The alternative is a table whose only job is to
 * remember, for a day, which address asked; a signed value costs nothing, cannot
 * be edited, and reaches exactly one inbox: the one that typed it.
 *
 * The address is base64url on the wire so it survives a query string intact, and
 * because it is inside the MAC it cannot be swapped for somebody else's.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertUsableKeyring, type SessionKeyring } from './cookie.js';

/** Present in every signing input, so a signature made here verifies nowhere else. */
const PURPOSE = 'free-run.v1';

/** The query parameters the confirm link travels in. */
export const FREE_RUN_TOKEN_PARAM = 't';
export const FREE_RUN_SUBMISSION_PARAM = 's';

/** Long enough for a phone-then-desk round trip; short enough not to be an heirloom. */
export const FREE_RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** What a token says once its signature has been checked. */
export interface FreeRunClaim {
  readonly submissionId: string;
  /** The address the confirmation was sent to, normalized before it was signed. */
  readonly email: string;
  readonly expiresAt: Date;
}

function mac(submissionId: string, email: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${PURPOSE}:${submissionId}:${email}:${expiresAtMs}`, 'utf8')
    .digest('base64url');
}

/** Compares two ASCII strings without leaking where they diverged. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, and the throw would itself
  // leak the length. Compare lengths first; both branches return the same way.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Sign one submission and one address with the newest secret in the keyring.
 *
 * `email` is signed exactly as given, so the caller must normalize it first —
 * `a@B.com` and `a@b.com` are one person and must not become two tokens that both
 * verify.
 */
export function mintFreeRunToken(
  input: { readonly submissionId: string; readonly email: string; readonly issuedAt: Date },
  keyring: SessionKeyring,
): string {
  assertUsableKeyring(keyring);
  const expiresAtMs = input.issuedAt.getTime() + FREE_RUN_TOKEN_TTL_MS;
  const encodedEmail = Buffer.from(input.email, 'utf8').toString('base64url');
  return [
    String(expiresAtMs),
    encodedEmail,
    mac(input.submissionId, input.email, expiresAtMs, keyring[0]),
  ].join('.');
}

/**
 * The claim this token makes about this submission, or `null`.
 *
 * Every secret in the keyring is tried, so a link minted before a rotation still
 * works for the rest of its day. A missing, malformed or expired token is `null`
 * and never a throw — it arrives from a form body, and a form body is
 * attacker-controlled by definition.
 */
export function verifyFreeRunToken(
  submissionId: string,
  token: string | undefined,
  keyring: SessionKeyring,
  now: Date,
): FreeRunClaim | null {
  if (token === undefined || token === '') return null;
  assertUsableKeyring(keyring);

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawExpiry, encodedEmail, signature] = parts as [string, string, string];

  // `Number` on a string of digits, and nothing else: `1e99` and `0x10` both
  // parse to a number and neither is a timestamp anybody minted.
  if (!/^[0-9]{1,15}$/.test(rawExpiry)) return null;
  const expiresAtMs = Number(rawExpiry);

  let email: string;
  try {
    email = Buffer.from(encodedEmail, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // base64url decoding is forgiving — several spellings decode to one string — so
  // the round trip is checked. A token that re-encodes differently is not the
  // token that was signed, whatever its MAC says about the decoded value.
  if (Buffer.from(email, 'utf8').toString('base64url') !== encodedEmail) return null;

  const signed = keyring.some((secret) =>
    constantTimeEquals(signature, mac(submissionId, email, expiresAtMs, secret)),
  );
  if (!signed) return null;

  // Expiry is checked AFTER the signature, so an unsigned guess learns nothing
  // from how long the answer took or from which refusal it got. Both refusals are
  // `null` anyway; this keeps them indistinguishable in the code as well.
  if (now.getTime() >= expiresAtMs) return null;

  return { submissionId, email, expiresAt: new Date(expiresAtMs) };
}
