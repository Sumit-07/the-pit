/**
 * The token that lets a guest watch the run they just paid for.
 *
 * ## Why a token and not a session
 *
 * `brief §2.1` is guest checkout: there is no login at submission, and there is
 * no account until the Dodo webhook resolves one from the address Dodo verified.
 * The buyer watching the progress bar on a phone has no cookie, no password and
 * no identity we could check — and `submissions` carries no account id, so there
 * is nothing on the row to compare a session against even if one existed.
 *
 * So the proof travels in the URL. It is minted once, server-side, at the moment
 * the submission is CREATED — the one instant at which we know the person asking
 * is the person who typed it — and it rides the Dodo return URL back. Nothing on
 * the return path mints one: a `/checkout/success` that signed whatever
 * `submission_id` it was handed would be a token vending machine, and the token
 * would be worth exactly as much as the id it was made from.
 *
 * ## Why it is not the session cookie's signer
 *
 * Same keyring, different namespace. `signSessionCookie` signs
 * `v1.<base64url payload>`; this signs `run-status.v1.<submission id>`. A
 * value produced by one can never verify as the other, so a status token cannot
 * be replayed as a 90-day session for an account it does not name, and the
 * rotation story is already written — `SESSION_SECRET_PREVIOUS` keeps yesterday's
 * links working for exactly as long as it keeps yesterday's sessions working.
 *
 * ## What it does not carry
 *
 * No expiry. A run takes minutes and a verdict URL is permanent (`brief` Part 6),
 * so a status link that stopped working would strand the customer who bookmarked
 * it rather than protect anything: what it opens is the progress of one
 * submission, which its holder paid for. Nothing here grants an attempt, spends
 * one, or signs anybody in.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertUsableKeyring, type SessionKeyring } from './cookie.js';

/**
 * The namespace. Present in every signing input, so a signature made for one
 * purpose cannot verify for another.
 */
const PURPOSE = 'run-status.v1';

/** The query parameter the token travels in, everywhere it travels. */
export const RUN_STATUS_TOKEN_PARAM = 't';

function mac(submissionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${PURPOSE}:${submissionId}`, 'utf8').digest('base64url');
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

/** Sign one submission id with the newest secret in the keyring. */
export function mintRunStatusToken(submissionId: string, keyring: SessionKeyring): string {
  assertUsableKeyring(keyring);
  return mac(submissionId, keyring[0]);
}

/**
 * Does this token belong to this submission?
 *
 * Every secret in the keyring is tried, so a link minted before a rotation still
 * opens. A missing or empty token is `false` and never a throw — it arrives from
 * a query string, and a query string is attacker-controlled by definition.
 */
export function verifyRunStatusToken(
  submissionId: string,
  token: string | undefined,
  keyring: SessionKeyring,
): boolean {
  if (token === undefined || token === '') return false;
  assertUsableKeyring(keyring);
  return keyring.some((secret) => constantTimeEquals(token, mac(submissionId, secret)));
}
