/**
 * `@the-pit/auth` — the magic link, and nothing else.
 *
 * `brief §2.1` is short and every line of it is a decision:
 *
 * > **No login at submission.** Nothing sits between a visitor and their
 * > purchase. […] Dodo supplies a verified email with the payment, so a magic
 * > link to that address matches the payer with no extra identity system and no
 * > guest-payment claiming flow.
 *
 * So this package is not a signup flow. It is how a returning customer reaches a
 * balance and a history that already exist, created for them server-side by the
 * Dodo webhook. There is no password, no OAuth provider, no account creation,
 * and no way to reach one from here — `AuthStore` has `findAccountByEmail` and
 * deliberately no `createAccount`.
 *
 * | `brief §2.1` | Enforced by |
 * |---|---|
 * | SHA-256 of the token, never the raw value | `hashToken`; `AuthStore.createToken` takes a `tokenHash` and has nowhere to put a token |
 * | 15-minute expiry | `MAGIC_TOKEN_TTL_MS`, `magicTokenExpiry` |
 * | single use | `AuthStore.consumeToken` — one atomic UPDATE, everything in the WHERE |
 * | `POST /auth/request` always answers the same | `requestMagicLink`, `CHECK_YOUR_INBOX`, `padTo` |
 * | `GET /auth/verify` renders a button, `POST` verifies | there is no GET path in `verify.ts`; `apps/web`'s GET handler is given no store |
 * | rate limit per email and per IP | `AUTH_RATE_LIMITS`, `bucketKey` — separate namespaces |
 * | session cookie, signed, 90 days | `signSessionCookie`, `SESSION_TTL_MS`, `__Host-` prefix |
 * | SPF/DKIM/DMARC | **not code.** DNS on the sending domain; see the Phase 4 report |
 *
 * Nothing here performs I/O of its own. The store, the mail transport, the rate
 * limiter, the clock and the sleep are all injected, which is what makes every
 * test in this package run with no network, no database and no API key — the
 * same shape `packages/payments` uses for the money path.
 */

export { isPlausibleEmail, MAX_EMAIL_LENGTH, normalizeEmail } from './email.js';

export type { ClientIpOptions, HeaderReader } from './ip.js';
export { clientIp, UNKNOWN_CLIENT_IP } from './ip.js';

export { hashToken, MAGIC_TOKEN_BYTES, MAGIC_TOKEN_TTL_MS, magicTokenExpiry, mintMagicToken } from './token.js';

export type { AuthAccount, AuthStore, ConsumeTokenResult, NewMagicToken } from './store.js';
export type { AuthStoreCall, StoredToken } from './memory-store.js';
export { MemoryAuthStore } from './memory-store.js';

export type { RateLimitDecision, RateLimiter, RateLimitPolicy, RateLimitScope } from './rate-limit.js';
export { AUTH_RATE_LIMITS, bucketKey, MemoryRateLimiter, UnlimitedRateLimiter } from './rate-limit.js';

export type { MailSendResult, MailTransport, OutboundEmail } from './mail/types.js';
export { FixtureMailTransport, ThrowingMailTransport } from './mail/fixture-transport.js';
export type { MagicLinkMessageInput } from './mail/render.js';
export { escapeHtml, magicLinkUrl, renderMagicLinkEmail } from './mail/render.js';
export type { FetchLike, ResendTransportOptions } from './mail/resend-transport.js';
export { RESEND_ENDPOINT, ResendMailTransport } from './mail/resend-transport.js';

export type {
  CookieOptions,
  SessionFailureReason,
  SessionKeyring,
  SessionPayload,
  SessionVerification,
} from './session/cookie.js';
export {
  assertUsableKeyring,
  clearSessionCookie,
  INSECURE_SESSION_COOKIE_NAME,
  MIN_SESSION_SECRET_LENGTH,
  newSessionPayload,
  readCookie,
  readSession,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionCookieName,
  signSessionCookie,
  verifySessionCookie,
} from './session/cookie.js';

export type { TimingFloor } from './timing.js';
export { DEFAULT_REQUEST_FLOOR_MS, noTimingFloor, padTo, systemTimingFloor } from './timing.js';

export type { AuthRequestDeps, AuthRequestInput, AuthRequestOutcome, AuthRequestResult } from './request.js';
export { CHECK_YOUR_INBOX, INVALID_EMAIL_MESSAGE, RATE_LIMITED_MESSAGE, requestMagicLink } from './request.js';

export type { VerifyDeps, VerifyInput, VerifyRejection, VerifyResult } from './verify.js';
export { verifyMagicLink } from './verify.js';
