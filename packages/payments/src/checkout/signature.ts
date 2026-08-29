/**
 * Webhook signature verification — Standard Webhooks, which is the scheme Dodo
 * ships.
 *
 * ## Why this is written out rather than pulled in
 *
 * It is forty lines, and every one of them is on the money path. The three
 * mistakes this file exists to not make:
 *
 * 1. **Signing the parsed body.** The signature covers the exact bytes Dodo
 *    sent. `JSON.parse` then `JSON.stringify` reorders keys, drops whitespace,
 *    and renders numbers differently; a route that hands us `req.body` instead
 *    of the raw text will fail verification, and the tempting fix is to stop
 *    verifying. `verifyWebhookSignature` takes a string and says so.
 * 2. **`===` on the digest.** String comparison short-circuits on the first
 *    differing byte, which leaks the prefix of a valid signature to anyone who
 *    can measure it. `timingSafeEqual`, always, on equal-length buffers.
 * 3. **No timestamp check.** A signature stays valid forever, so a captured
 *    request replays forever. The tolerance window bounds that; the idempotency
 *    key bounds the damage inside the window.
 *
 * A failure returns a reason rather than throwing. The route logs the reason and
 * answers 400; it must never answer 200 to something it could not verify,
 * because 200 tells Dodo to stop retrying.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks header names, lowercased. */
export const HEADER_ID = 'webhook-id';
export const HEADER_TIMESTAMP = 'webhook-timestamp';
export const HEADER_SIGNATURE = 'webhook-signature';

/**
 * How far a webhook's timestamp may be from our clock, in seconds.
 *
 * Five minutes each way, which is the Standard Webhooks default. Both
 * directions: a future timestamp is as suspicious as an old one, and clock skew
 * on our side is the reason the future side is tolerated at all.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Dodo's secrets are handed out with this prefix; the key is what follows it. */
const SECRET_PREFIX = 'whsec_';

const MILLIS_PER_SECOND = 1000;

export type SignatureFailureReason =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'timestamp_outside_tolerance'
  | 'no_matching_signature';

export type SignatureResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: SignatureFailureReason };

export interface VerifyInput {
  /** The request body as received, byte for byte. Never a re-serialized object. */
  readonly rawBody: string;
  /** Request headers. Lookup is case-insensitive; HTTP header names are. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The endpoint secret, with or without its `whsec_` prefix. */
  readonly secret: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

/** The secret is base64 after its prefix; the HMAC key is those raw bytes. */
function secretKey(secret: string): Buffer {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(body, 'base64');
}

/**
 * The signed content: `id.timestamp.body`. Exported because a test that builds a
 * valid signature by hand must build it the same way the verifier reads it, and
 * because the Dodo dashboard's "test send" is easier to debug against a named
 * function than against an inlined template literal.
 */
export function signedPayload(input: { id: string; timestamp: string; rawBody: string }): string {
  return `${input.id}.${input.timestamp}.${input.rawBody}`;
}

/** The base64 HMAC-SHA256 of the signed content. */
export function signWebhook(input: { id: string; timestamp: string; rawBody: string; secret: string }): string {
  return createHmac('sha256', secretKey(input.secret)).update(signedPayload(input)).digest('base64');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. Compare lengths first and return the same way either branch does.
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Verify a Standard Webhooks signature.
 *
 * The signature header may carry several space-separated `v1,<base64>` entries —
 * that is how the scheme rotates secrets, by signing with old and new at once.
 * Every entry is compared; unknown versions are skipped rather than rejected, so
 * a future `v2` alongside a valid `v1` still verifies.
 */
export function verifyWebhookSignature(input: VerifyInput): SignatureResult {
  const id = header(input.headers, HEADER_ID);
  const timestamp = header(input.headers, HEADER_TIMESTAMP);
  const signature = header(input.headers, HEADER_SIGNATURE);

  if (id === undefined || timestamp === undefined || signature === undefined) {
    return { valid: false, reason: 'missing_headers' };
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || !/^-?\d+$/.test(timestamp.trim())) {
    return { valid: false, reason: 'malformed_timestamp' };
  }

  const tolerance = input.toleranceSeconds ?? TIMESTAMP_TOLERANCE_SECONDS;
  const skew = Math.abs(input.now.getTime() / MILLIS_PER_SECOND - seconds);
  if (skew > tolerance) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = signWebhook({ id, timestamp, rawBody: input.rawBody, secret: input.secret });
  for (const candidate of signature.split(' ')) {
    const comma = candidate.indexOf(',');
    if (comma === -1) {
      continue;
    }
    if (candidate.slice(0, comma) !== 'v1') {
      continue;
    }
    if (constantTimeEquals(candidate.slice(comma + 1), expected)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'no_matching_signature' };
}
