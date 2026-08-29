/**
 * The session cookie. `brief §2.1`: "Session cookie, signed, 90 days."
 *
 * ## Signed, not encrypted, and not a database row
 *
 * The cookie carries `{accountId, email, issuedAt, expiresAt}` in the clear with
 * an HMAC-SHA256 over it. Nothing in it is secret — the person holding the
 * cookie is the person whose email it names — so encryption would buy nothing
 * and cost a key-management story. What matters is that it cannot be EDITED, and
 * that is what the MAC is for: change one byte of the payload and verification
 * fails, so `accountId` cannot be swapped for someone else's.
 *
 * A stateless cookie rather than a `sessions` table because the identity schema
 * is another agent's and because a 90-day session that survives a database
 * failover with no row to look up is a feature. The cost is the honest one: a
 * cookie cannot be revoked individually before it expires. Rotating the keyring
 * invalidates every session at once, which is the break-glass control — see the
 * Phase 4 report.
 *
 * ## The format
 *
 * ```
 * v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 * ```
 *
 * The MAC covers `v1.<payload>` — the version prefix included — so a future
 * `v2` with different semantics cannot be downgraded to `v1` by an attacker
 * truncating the string. Verification is constant-time.
 *
 * ## The keyring
 *
 * `verifySessionCookie` accepts several secrets and `signSessionCookie` uses the
 * first. That is how a leaked signing key gets replaced without logging every
 * customer out at once: prepend the new secret, deploy, and drop the old one
 * after 90 days. A single-secret deployment passes a one-element array and pays
 * nothing for the capability.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `__Host-` is not decoration. The prefix is enforced by the browser: a cookie
 * with this name is only accepted when it is `Secure`, has `Path=/`, and carries
 * NO `Domain` attribute — which means a compromised or hostile subdomain cannot
 * set or overwrite it. That closes session fixation via subdomain, which is
 * otherwise wide open on a platform that hands out `*.vercel.app` preview
 * hostnames.
 */
export const SESSION_COOKIE_NAME = '__Host-pit_session';

/**
 * The name used when the cookie cannot be `Secure` — i.e. `http://localhost`.
 * A separate name rather than a relaxed `__Host-` cookie, because a browser
 * silently DROPS a `__Host-` cookie that fails the rules and the resulting bug
 * ("login does nothing locally") is invisible.
 */
export const INSECURE_SESSION_COOKIE_NAME = 'pit_session';

/** `brief §2.1`: 90 days. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Below this a secret is not a secret. 32 bytes of entropy, hex or base64url. */
export const MIN_SESSION_SECRET_LENGTH = 32;

const VERSION = 'v1';

export interface SessionPayload {
  readonly accountId: string;
  readonly email: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. `issuedAt + 90 days`. */
  readonly expiresAt: number;
}

/**
 * Signing keys, newest first. A non-empty tuple, so "no secrets configured"
 * cannot be represented and therefore cannot be a runtime surprise.
 */
export type SessionKeyring = readonly [string, ...string[]];

export type SessionFailureReason = 'missing' | 'malformed' | 'bad_signature' | 'expired';

export type SessionVerification =
  | { readonly valid: true; readonly session: SessionPayload }
  | { readonly valid: false; readonly reason: SessionFailureReason };

export function assertUsableKeyring(keyring: SessionKeyring): void {
  keyring.forEach((secret, index) => {
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new RangeError(
        `session secret at index ${index} is ${secret.length} characters; ` +
          `at least ${MIN_SESSION_SECRET_LENGTH} are required.`,
      );
    }
  });
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function mac(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, and the throw would itself
  // leak the length. Compare lengths first; both branches return the same way.
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function newSessionPayload(input: { accountId: string; email: string; now: Date }): SessionPayload {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  return {
    accountId: input.accountId,
    email: input.email,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_MS / 1000,
  };
}

/** `v1.<payload>.<mac>`, signed with `keyring[0]`. */
export function signSessionCookie(session: SessionPayload, keyring: SessionKeyring): string {
  assertUsableKeyring(keyring);
  const payload = b64url(JSON.stringify(session));
  const signingInput = `${VERSION}.${payload}`;
  return `${signingInput}.${mac(signingInput, keyring[0])}`;
}

/**
 * Verify a cookie value.
 *
 * Order matters: shape, then MAC, then expiry. Checking expiry before the MAC
 * would mean reading `expiresAt` out of an unauthenticated payload — trusting a
 * number an attacker wrote in order to decide whether to check whether the
 * attacker wrote it.
 */
export function verifySessionCookie(
  value: string | undefined,
  keyring: SessionKeyring,
  now: Date,
): SessionVerification {
  if (value === undefined || value === '') {
    return { valid: false, reason: 'missing' };
  }
  assertUsableKeyring(keyring);

  const parts = value.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== VERSION || payload === '' || signature === '') {
    return { valid: false, reason: 'malformed' };
  }

  const signingInput = `${version}.${payload}`;
  const matched = keyring.some((secret) => constantTimeEquals(signature, mac(signingInput, secret)));
  if (!matched) {
    return { valid: false, reason: 'bad_signature' };
  }

  const session = parseSession(payload);
  if (session === null) {
    // Authentic bytes that do not parse means we signed something malformed —
    // a bug on our side, not an attack. Still refused; still not trusted.
    return { valid: false, reason: 'malformed' };
  }

  if (session.expiresAt * 1000 <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, session };
}

function parseSession(payload: string): SessionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const { accountId, email, issuedAt, expiresAt } = candidate;
  if (
    typeof accountId !== 'string' ||
    accountId === '' ||
    typeof email !== 'string' ||
    email === '' ||
    typeof issuedAt !== 'number' ||
    !Number.isFinite(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  return { accountId, email, issuedAt, expiresAt };
}

export interface CookieOptions {
  /**
   * `false` only for `http://localhost`. It also switches the cookie NAME, so a
   * misconfigured production deployment fails loudly (nobody stays signed in)
   * rather than silently shipping a cookie without the `__Host-` guarantees.
   */
  readonly secure?: boolean;
}

export function sessionCookieName(options: CookieOptions = {}): string {
  return options.secure === false ? INSECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/**
 * A `Set-Cookie` value.
 *
 * - `HttpOnly` — script cannot read it, so an XSS bug does not become a
 *   permanent account takeover by exfiltrating a 90-day credential.
 * - `SameSite=Lax` — not `Strict`, because the session is established by
 *   following a link out of an email client and `Strict` would drop the cookie
 *   on that very first navigation. `Lax` still withholds it from cross-site
 *   POSTs, which is where CSRF lives.
 * - `Max-Age` AND the payload's `expiresAt` — the browser forgets it at 90 days
 *   and the server refuses it at 90 days. Only the second one is a security
 *   control; the first is what stops a stale cookie being sent for years.
 */
export function serializeSessionCookie(value: string, options: CookieOptions = {}): string {
  const attributes = [
    `${sessionCookieName(options)}=${value}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure !== false) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** Sign-out: the same attributes with an empty value and `Max-Age=0`. */
export function clearSessionCookie(options: CookieOptions = {}): string {
  const attributes = [`${sessionCookieName(options)}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure !== false) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/**
 * Pull one cookie out of a `Cookie:` header.
 *
 * Written out rather than pulled in because the header is a `; `-separated list
 * whose values may legally contain `=`, which is the one thing a naive
 * `split('=')` gets wrong.
 */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (header === null || header === undefined || header === '') {
    return undefined;
  }
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Read and verify the session on an incoming request's headers. */
export function readSession(input: {
  readonly cookieHeader: string | null | undefined;
  readonly keyring: SessionKeyring;
  readonly now: Date;
  readonly secure?: boolean;
}): SessionVerification {
  const options: CookieOptions = input.secure === undefined ? {} : { secure: input.secure };
  return verifySessionCookie(readCookie(input.cookieHeader, sessionCookieName(options)), input.keyring, input.now);
}
