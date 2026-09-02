/**
 * `@the-pit/auth` — three ways into one account.
 *
 * ## What changed, and what did not
 *
 * The magic link below is unchanged: same tables, same SHA-256 hashes, same
 * single-use atomic consume, same no-enumeration posture, same button-then-POST
 * verify that stops a mail scanner burning a token. Nothing in this section has
 * been relaxed and nothing new can reach it — `verifyMagicLink` still takes an
 * `AuthStore` with three methods and no way to reach a capability slug or a
 * provider link.
 *
 * What it gained is two siblings, because a single path that depends on email
 * delivery is a single point of failure with a one-to-two-week lead time on it.
 * SPF, DKIM and DMARC want `p=none` for a fortnight before anything tightens,
 * plus reputation warm-up on a new domain, and until that is done "check your
 * inbox" is a promise the infrastructure cannot keep — worst of all for the
 * corporate addresses most likely to have paid.
 *
 * | Path | Depends on | Reached by |
 * |---|---|---|
 * | Magic link | email delivering | `requestMagicLink` → `verifyMagicLink` |
 * | Capability URL | nothing | `openCapabilityUrl`, shown at `capabilityHandoff` |
 * | GitHub | GitHub being up | `startOAuthSignIn` → `completeOAuthSignIn` |
 *
 * All three end at the same `accounts` row. None of them creates it: `AuthStore`
 * has no `createAccount`, and `completeOAuthSignIn` answers `no_purchase_found`
 * rather than inventing an account for a stranger.
 *
 * `IdentityStore` now has exactly one method that can — `createAccountForEmail`,
 * `DECISIONS.md` S15-free's free-run arm — and it is deliberately NOT on
 * `AuthStore`, so `verifyMagicLink` still takes three methods and still answers
 * `no_account` for an address nobody has ever confirmed. See
 * `identity-store.ts` for the precondition its one legitimate caller supplies.
 *
 * `brief §2.1` says "No GitHub, no Google", and it says it as the answer to
 * *"what identifies the payer"*. That answer is unchanged: the payment email
 * still is, GitHub matches against it and never replaces it, and a GitHub
 * identity that matches no purchase gets no account. What §2.1 rules out —
 * an identity system that could mint accounts, and a guest-payment claiming
 * flow — is still ruled out here.
 *
 * GitHub is also never on the buying path. Guest checkout stays the default on
 * every device; OAuth is an upgrade a customer applies before or after paying,
 * and both orders converge on the same row. See `oauth/sign-in.ts`.
 *
 * ---
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

export {
  mintRunStatusToken,
  RUN_STATUS_TOKEN_PARAM,
  verifyRunStatusToken,
} from './session/run-status-token.js';

export type { FreeRunClaim } from './session/free-run-token.js';
export {
  FREE_RUN_SUBMISSION_PARAM,
  FREE_RUN_TOKEN_PARAM,
  FREE_RUN_TOKEN_TTL_MS,
  mintFreeRunToken,
  verifyFreeRunToken,
} from './session/free-run-token.js';

export type { TimingFloor } from './timing.js';
export { DEFAULT_REQUEST_FLOOR_MS, noTimingFloor, padTo, systemTimingFloor } from './timing.js';

export type { AuthRequestDeps, AuthRequestInput, AuthRequestOutcome, AuthRequestResult } from './request.js';
export { CHECK_YOUR_INBOX, INVALID_EMAIL_MESSAGE, RATE_LIMITED_MESSAGE, requestMagicLink } from './request.js';

export type { VerifyDeps, VerifyInput, VerifyRejection, VerifyResult } from './verify.js';
export { verifyMagicLink } from './verify.js';

// --- Path 2: the capability URL, which depends on nothing being delivered ---

export type { RandomBytes } from './capability/slug.js';
export {
  CAPABILITY_CSPRNG,
  CAPABILITY_SLUG_BYTES,
  CAPABILITY_SLUG_LENGTH,
  CAPABILITY_SLUG_MIN_BITS,
  CAPABILITY_SLUG_PATTERN,
  capabilityPath,
  capabilityUrl,
  isCapabilitySlug,
  mintCapabilitySlug,
} from './capability/slug.js';

export type {
  CapabilityDeps,
  CapabilityRejection,
  OpenCapabilityInput,
  OpenCapabilityResult,
  RotateCapabilityInput,
  RotateCapabilityResult,
} from './capability/access.js';
export { openCapabilityUrl, rotateCapability } from './capability/access.js';

export type { HandoffDeps, HandoffInput, HandoffResult, HandoffStore } from './capability/handoff.js';
export { capabilityHandoff, HANDOFF_WINDOW_MS } from './capability/handoff.js';

export type { CapabilityMessageInput } from './mail/capability-render.js';
export { capabilityIdempotencyKey, renderCapabilityEmail } from './mail/capability-render.js';

// --- The free first throw: one confirmed address, one product, one run ---

export type { FreeRunMessageInput } from './mail/free-run-render.js';
export { freeRunConfirmUrl, freeRunIdempotencyKey, renderFreeRunEmail } from './mail/free-run-render.js';

// --- The one email that is not about signing in: a delivered verdict ---

export type { VerdictMessageInput, VerdictSharpestCut } from './mail/verdict-render.js';
export { renderVerdictEmail, verdictCutsLine, verdictIdempotencyKey } from './mail/verdict-render.js';

// --- The second store seam: slugs and provider links ---

export type {
  AccountIdentity,
  AccountStore,
  CreatedAccount,
  IdentityStore,
  RotateSlugResult,
} from './identity-store.js';

// --- Path 3: GitHub, an upgrade and never a gate ---

export type {
  AuthorizationRequest,
  CodeExchange,
  FetchLike as OAuthFetchLike,
  OAuthIdentityResult,
  OAuthProvider,
  OAuthTokenResult,
  ProviderEmail,
  ProviderIdentity,
} from './oauth/types.js';

export { unverifiedProviderEmails, verifiedProviderEmails } from './oauth/verified-emails.js';

export type { OAuthStatePayload, OAuthStateVerification } from './oauth/state.js';
export {
  clearOAuthStateCookie,
  codeChallengeFor,
  INSECURE_OAUTH_STATE_COOKIE_NAME,
  mintCodeVerifier,
  mintOAuthState,
  OAUTH_STATE_BYTES,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  oauthStateCookieName,
  readOAuthState,
  serializeOAuthStateCookie,
  signOAuthState,
  statesMatch,
  verifyOAuthState,
} from './oauth/state.js';

export type {
  CompleteOAuthInput,
  CompleteOAuthResult,
  OAuthDeps,
  OAuthRejection,
  StartOAuthInput,
  StartOAuthResult,
} from './oauth/sign-in.js';
export { completeOAuthSignIn, startOAuthSignIn } from './oauth/sign-in.js';

export type { FixtureProviderOptions } from './oauth/fixture-provider.js';
export { FixtureOAuthProvider, unverifiedEmail, verifiedEmail } from './oauth/fixture-provider.js';

export type { GitHubProviderOptions } from './oauth/github-provider.js';
export {
  GITHUB_API_VERSION,
  GITHUB_AUTHORIZE_ENDPOINT,
  GITHUB_EMAILS_ENDPOINT,
  GITHUB_SCOPES,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_ENDPOINT,
  GitHubOAuthProvider,
} from './oauth/github-provider.js';
