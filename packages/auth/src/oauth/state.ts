/**
 * The `state` parameter, the PKCE verifier, and the cookie that carries them.
 *
 * ## What `state` is actually for
 *
 * It is a CSRF token for the callback. Without it, an attacker completes an
 * authorization with THEIR GitHub account, keeps the resulting `?code=`, and
 * then gets a victim's browser to visit our callback with it — a login CSRF, and
 * the victim is now signed in as the attacker. That sounds harmless until you
 * remember what happens next: the victim, believing it is their account, submits
 * a listing or connects their own GitHub, and the attacker (who owns the
 * account) walks off with it.
 *
 * The defence is that the callback only accepts a `state` it can prove it issued
 * to THIS browser. That proof has to be bound to the browser, which means a
 * cookie, and it has to be unforgeable, which means the cookie is signed.
 *
 * ## Why the state lives in a signed cookie and not in a database
 *
 * A `oauth_states` table would work and would let a state be single-use with an
 * atomic consume, as the magic-link token is. It is not worth it here: the state
 * is alive for ten minutes, the whole flow is a round trip in one browser, and
 * the identity schema does not need another table whose only job is to be
 * deleted. The cookie is HMAC'd with the same `SessionKeyring` the session
 * cookie uses (`session/cookie.ts`), carries its own expiry, and is cleared by
 * the callback — so replay costs the attacker a stolen cookie, at which point
 * they have the session cookie too and the state is the least of it.
 *
 * The honest limitation: a signed cookie is not single-use the way a database
 * row is. Within its ten-minute life, a callback replayed with the same cookie
 * and the same code will be re-attempted — and will fail at the provider,
 * because authorization codes ARE single-use at GitHub. That is the layer doing
 * the work, and it is stated here rather than assumed.
 *
 * ## The verifier
 *
 * Present only when the provider declares `pkce: 'S256'` (see `types.ts` —
 * GitHub does not). It rides in the same signed cookie. That is safe for a
 * confidential server-side client: PKCE defends against an attacker who
 * intercepts the authorization CODE in transit — through a redirect leak, a
 * shared device, a referrer — and such an attacker does not have the victim's
 * `HttpOnly` cookie. A public client (a mobile app, a SPA) would have nowhere
 * safe to put a verifier and would need a different arrangement; we are not one.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { RandomBytes } from '../capability/slug.js';
import { readCookie, type SessionKeyring } from '../session/cookie.js';

/**
 * Ten minutes. Long enough to read GitHub's authorization screen, find the
 * account you meant to use, and get through a 2FA prompt on a phone. Short
 * enough that a cookie left on a shared machine is not a standing invitation.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** 32 bytes for the state and, when used, for the verifier. */
export const OAUTH_STATE_BYTES = 32;

/**
 * `__Host-` for the same reason the session cookie has it: the browser refuses
 * to accept one that is not `Secure`, `Path=/` and domain-less, which is what
 * stops a hostile `*.vercel.app` preview host from planting a state.
 */
export const OAUTH_STATE_COOKIE_NAME = '__Host-pit_oauth';
/** The `http://localhost` name. A different name, so a misconfiguration is loud. */
export const INSECURE_OAUTH_STATE_COOKIE_NAME = 'pit_oauth';

const VERSION = 'o1';

export interface OAuthStatePayload {
  readonly provider: string;
  readonly state: string;
  /** `null` unless the provider declared `pkce: 'S256'`. */
  readonly codeVerifier: string | null;
  /**
   * `link` when the flow was started by a signed-in customer connecting a
   * provider to an account they already reached, `sign_in` otherwise. Carried
   * here rather than re-derived at the callback so the callback cannot be
   * tricked into treating one as the other by a manipulated query string.
   */
  readonly intent: 'sign_in' | 'link';
  /** Unix seconds. */
  readonly expiresAt: number;
}

export type OAuthStateVerification =
  | { readonly valid: true; readonly payload: OAuthStatePayload }
  | { readonly valid: false; readonly reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

/** A fresh `state` — 256 bits, base64url, from the same CSPRNG as everything else. */
export function mintOAuthState(random: RandomBytes = randomBytes): string {
  return draw(random);
}

/**
 * A PKCE code verifier.
 *
 * RFC 7636 admits 43-128 characters from an unreserved set; 32 bytes of
 * base64url is 43, the minimum length and the maximum entropy that length can
 * carry.
 */
export function mintCodeVerifier(random: RandomBytes = randomBytes): string {
  return draw(random);
}

/**
 * `S256`: base64url of the SHA-256 of the verifier's ASCII bytes.
 *
 * Never `plain`. A `plain` challenge is the verifier, so an attacker who
 * intercepted the authorization request has everything they need to complete the
 * exchange — the method exists in the RFC for constrained devices and has no
 * business in a server.
 */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function draw(random: RandomBytes): string {
  const bytes = random(OAUTH_STATE_BYTES);
  if (bytes.length !== OAUTH_STATE_BYTES) {
    throw new RangeError(`oauth randomness source returned ${bytes.length} bytes, expected ${OAUTH_STATE_BYTES}`);
  }
  return bytes.toString('base64url');
}

/** `o1.<base64url(JSON)>.<HMAC>`, the same construction as the session cookie. */
export function signOAuthState(payload: OAuthStatePayload, keyring: SessionKeyring): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${VERSION}.${body}`;
  return `${signingInput}.${mac(signingInput, keyring[0])}`;
}

/**
 * Verify a state cookie.
 *
 * Shape, then MAC, then expiry — the same order and the same reason as
 * `verifySessionCookie`: reading `expiresAt` before checking the MAC means
 * trusting a number an attacker wrote in order to decide whether to check
 * whether the attacker wrote it.
 */
export function verifyOAuthState(
  value: string | undefined,
  keyring: SessionKeyring,
  now: Date,
): OAuthStateVerification {
  if (value === undefined || value === '') {
    return { valid: false, reason: 'missing' };
  }
  const parts = value.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  const [version, body, signature] = parts as [string, string, string];
  if (version !== VERSION || body === '' || signature === '') {
    return { valid: false, reason: 'malformed' };
  }

  const signingInput = `${version}.${body}`;
  if (!keyring.some((secret) => constantTimeEquals(signature, mac(signingInput, secret)))) {
    return { valid: false, reason: 'bad_signature' };
  }

  const payload = parseState(body);
  if (payload === null) {
    return { valid: false, reason: 'malformed' };
  }
  if (payload.expiresAt * 1000 <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, payload };
}

/**
 * Compare the `state` from the query string against the one from the cookie.
 *
 * Constant-time, because the comparison is against a secret we issued and a
 * byte-at-a-time early return is a (slow, noisy, but real) oracle for
 * reconstructing it. It costs nothing to do properly.
 */
export function statesMatch(fromQuery: string, fromCookie: string): boolean {
  return constantTimeEquals(fromQuery, fromCookie);
}

export function oauthStateCookieName(options: { secure?: boolean } = {}): string {
  return options.secure === false ? INSECURE_OAUTH_STATE_COOKIE_NAME : OAUTH_STATE_COOKIE_NAME;
}

/**
 * `Set-Cookie` for the state.
 *
 * `SameSite=Lax` and not `Strict`: the callback arrives as a top-level
 * navigation from `github.com`, and `Strict` withholds the cookie on exactly
 * that navigation — the flow would fail every time, for everyone. `Lax` sends it
 * on a top-level GET and still withholds it from cross-site POSTs.
 *
 * `Max-Age` matches the payload's expiry, so the browser forgets it at the same
 * moment the server stops accepting it.
 */
export function serializeOAuthStateCookie(value: string, options: { secure?: boolean } = {}): string {
  const attributes = [
    `${oauthStateCookieName(options)}=${value}`,
    'Path=/',
    `Max-Age=${OAUTH_STATE_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure !== false) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/**
 * Clear it.
 *
 * The callback does this on EVERY outcome, success and failure alike. A state
 * cookie that outlives its flow is a spare CSRF token sitting in a browser.
 */
export function clearOAuthStateCookie(options: { secure?: boolean } = {}): string {
  const attributes = [`${oauthStateCookieName(options)}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure !== false) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** Read and verify the state cookie off an incoming request's headers. */
export function readOAuthState(input: {
  readonly cookieHeader: string | null | undefined;
  readonly keyring: SessionKeyring;
  readonly now: Date;
  readonly secure?: boolean;
}): OAuthStateVerification {
  const name = oauthStateCookieName(input.secure === undefined ? {} : { secure: input.secure });
  return verifyOAuthState(readCookie(input.cookieHeader, name), input.keyring, input.now);
}

function mac(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseState(body: string): OAuthStatePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const { provider, state, codeVerifier, intent, expiresAt } = candidate;
  if (
    typeof provider !== 'string' ||
    provider === '' ||
    typeof state !== 'string' ||
    state === '' ||
    !(codeVerifier === null || (typeof codeVerifier === 'string' && codeVerifier !== '')) ||
    !(intent === 'sign_in' || intent === 'link') ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  return { provider, state, codeVerifier, intent, expiresAt };
}
