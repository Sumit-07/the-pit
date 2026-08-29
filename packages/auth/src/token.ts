/**
 * The magic-link token: minted here, hashed here, and stored nowhere in this
 * module.
 *
 * `brief §2.1`, verbatim: "Store **SHA-256 of the token**, never the raw value.
 * 15-minute expiry, single use."
 *
 * ## Why the raw value never leaves this file except as a return value
 *
 * The raw token is a bearer credential — whoever holds it becomes the account.
 * It has exactly two legitimate homes: the email that carries it, and the form
 * post that redeems it. Everywhere else it is a liability, and the places it
 * leaks are boring: an application log line, a Sentry breadcrumb, a database
 * backup, a `SELECT *` pasted into a support ticket, an HTTP access log that
 * captured a query string.
 *
 * `packages/db`'s `tokens` table is built so it CANNOT hold one — five columns,
 * none of them able to store a raw token, with `check (token_hash ~
 * '^[0-9a-f]{64}$')` rejecting anything that is not a digest. `hashToken` is the
 * other half of that: the only value this package ever hands a store.
 *
 * ## Why SHA-256 and not bcrypt/argon2
 *
 * Password hashes are slow on purpose because passwords are low-entropy and
 * guessable offline. This token is 256 bits from the OS CSPRNG and lives for 15
 * minutes; there is nothing to brute-force, and a slow hash on the verify path
 * would only be a denial-of-service lever. A fast digest is correct here, and it
 * is what the schema's shape check and `brief §2.1` both specify.
 */

import { createHash, randomBytes } from 'node:crypto';

/** `brief §2.1`: 15-minute expiry. */
export const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * 32 bytes — 256 bits — from `crypto.randomBytes`, which is the OS CSPRNG.
 *
 * Not `Math.random()`, which is seeded per process and predictable from a
 * handful of outputs, and not a UUIDv4, which spends 6 of its 128 bits on
 * version and variant markers and reads to a human like an identifier rather
 * than a secret.
 */
export const MAGIC_TOKEN_BYTES = 32;

/**
 * A fresh token, base64url-encoded.
 *
 * base64url because the token travels in a URL query string on the way out and
 * in a form field on the way back: `+`, `/` and `=` all need escaping in one of
 * those and would survive a round trip only if every hop got it right. 32 bytes
 * encode to 43 unpadded characters.
 */
export function mintMagicToken(): string {
  return randomBytes(MAGIC_TOKEN_BYTES).toString('base64url');
}

/**
 * The only value that may be persisted: lowercase hex SHA-256 of the raw token.
 *
 * Hashed over the token's UTF-8 bytes, which for a base64url string is its ASCII
 * bytes. Lowercase hex is what `createHash(...).digest('hex')` produces and what
 * the `tokens_hash_is_sha256_hex` constraint demands, so the encoding is fixed
 * on both sides and one token can never be stored under two different spellings.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** When a token minted at `issuedAt` stops being redeemable. `brief §2.1`. */
export function magicTokenExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + MAGIC_TOKEN_TTL_MS);
}
