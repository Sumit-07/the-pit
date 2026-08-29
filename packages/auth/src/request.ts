/**
 * `POST /auth/request` — the half of `brief §2.1` that must never say anything
 * different.
 *
 * > `POST /auth/request` → always respond "check your inbox" regardless of
 * > whether the email exists (no account enumeration)
 *
 * ## What "always" costs, and why it is paid here rather than in the route
 *
 * The naive implementation branches: look the account up, and if it is missing,
 * return early. Every observable consequence of that branch is a leak.
 *
 * 1. **The body.** Closed by returning one constant. `CHECK_YOUR_INBOX` is a
 *    frozen literal so no caller can interpolate an address into it.
 * 2. **The status.** Closed by returning 200 on both paths.
 * 3. **The database work.** An early return performs one query for an unknown
 *    address and two for a known one. So this function performs the SAME store
 *    calls in the SAME order either way: `createToken` then
 *    `findAccountByEmail`, unconditionally. The token row is written before we
 *    know whether an account exists, and that is deliberate.
 * 4. **The wall clock.** The remaining difference is the mail send — an entire
 *    network round trip, and by far the loudest of the four. Closed by
 *    `padTo`: see `src/timing.ts`.
 * 5. **The rate limiter.** Both budgets are spent BEFORE the account lookup, so
 *    an attacker cannot probe existence by watching which of their buckets
 *    moved. This is easy to get wrong by "optimising" the limiter to only count
 *    real sends.
 * 6. **The failure path.** A transport that throws must not become a 500 next to
 *    a 200 — that is the same oracle with an error page on it. Every send is
 *    wrapped, and both a returned failure and a thrown one produce the identical
 *    success response.
 *
 * ## The token row for an address with no account
 *
 * Point 3 means this function writes a `tokens` row for an address that may have
 * no account. That is safe and it is checked on the other side: `verifyMagicLink`
 * looks the account up AFTER consuming and refuses when there is none, so a
 * token can never bring an account into existence. `brief §2.1` puts account
 * creation on the signed Dodo webhook and nowhere else.
 *
 * The cost is unbounded rows for addresses nobody owns, which is why the rate
 * limits are per email AND per IP, and why `tokens_expires_at_idx` exists for
 * the sweeper. See the Phase 4 report.
 */

import { isPlausibleEmail, normalizeEmail } from './email.js';
import { renderMagicLinkEmail } from './mail/render.js';
import type { MailTransport } from './mail/types.js';
import { AUTH_RATE_LIMITS, bucketKey, type RateLimiter } from './rate-limit.js';
import type { AuthStore } from './store.js';
import { hashToken, magicTokenExpiry, mintMagicToken } from './token.js';
import { noTimingFloor, padTo, type TimingFloor } from './timing.js';

/**
 * The one sentence. Frozen, exported, and asserted on by the enumeration test,
 * so a future edit that personalises it ("we've sent a link to alice@…") fails
 * a test instead of shipping.
 */
export const CHECK_YOUR_INBOX = 'If that address has an account, a sign-in link is on its way. Check your inbox.';

export interface AuthRequestDeps {
  readonly store: AuthStore;
  readonly mail: MailTransport;
  readonly limiter: RateLimiter;
  /** `From:` header, e.g. `The Pit <no-reply@thepit.show>`. */
  readonly mailFrom: string;
  /** Absolute URL of the verify page, e.g. `https://thepit.show/auth/verify`. */
  readonly verifyUrl: string;
  /** Injected so a test can pin the token. Defaults to the CSPRNG. */
  readonly mintToken?: () => string;
  /** Defaults to no floor; the route supplies `systemTimingFloor()`. */
  readonly timingFloor?: TimingFloor;
}

export interface AuthRequestInput {
  /** As typed. Normalized here, so the caller cannot forget to. */
  readonly email: string;
  /** The client address, for the per-IP budget. `unknown` when unresolvable. */
  readonly ip: string;
  readonly now: Date;
}

/**
 * Never rendered. This is the log line — the reason the response says nothing is
 * precisely that someone still has to be able to see what happened, and that
 * someone is an operator reading structured logs, not the requester.
 */
export type AuthRequestOutcome =
  | 'sent'
  /** A well-formed address with no account. Same response as `sent`. */
  | 'suppressed'
  /** Delivery failed or threw. Same response as `sent`. Alarm on this one. */
  | 'delivery_failed'
  | 'invalid_email'
  | 'rate_limited_email'
  | 'rate_limited_ip';

export interface AuthRequestResult {
  /** 200 for everything that reached the account lookup. */
  readonly httpStatus: 200 | 400 | 429;
  readonly message: string;
  /** Present only on 429, for the `Retry-After` header. */
  readonly retryAfterSeconds?: number;
  /** Logs and metrics. Must not reach the response. */
  readonly outcome: AuthRequestOutcome;
}

/** Shown for a syntactically impossible address. Reveals nothing about accounts. */
export const INVALID_EMAIL_MESSAGE = 'That does not look like an email address.';

/** Shown when a budget is spent. Depends on the caller, not on any account. */
export const RATE_LIMITED_MESSAGE = 'Too many sign-in requests. Try again shortly.';

export async function requestMagicLink(
  input: AuthRequestInput,
  deps: AuthRequestDeps,
): Promise<AuthRequestResult> {
  const email = normalizeEmail(input.email);

  // Syntax is something the caller can determine without asking us, so saying so
  // leaks nothing. Note this happens BEFORE the limiter: a malformed address is
  // not a sign-in attempt and must not spend a real address's budget.
  if (!isPlausibleEmail(email)) {
    return { httpStatus: 400, message: INVALID_EMAIL_MESSAGE, outcome: 'invalid_email' };
  }

  // IP first, then email. Both are spent before anything looks at an account, so
  // neither budget's movement can be read as an answer about account existence.
  const byIp = await deps.limiter.consume({
    key: bucketKey('auth:request:ip', input.ip),
    policy: AUTH_RATE_LIMITS.requestPerIp,
    now: input.now,
  });
  if (!byIp.allowed) {
    return {
      httpStatus: 429,
      message: RATE_LIMITED_MESSAGE,
      retryAfterSeconds: byIp.retryAfterSeconds,
      outcome: 'rate_limited_ip',
    };
  }

  const byEmail = await deps.limiter.consume({
    key: bucketKey('auth:request:email', email),
    policy: AUTH_RATE_LIMITS.requestPerEmail,
    now: input.now,
  });
  if (!byEmail.allowed) {
    return {
      httpStatus: 429,
      message: RATE_LIMITED_MESSAGE,
      retryAfterSeconds: byEmail.retryAfterSeconds,
      outcome: 'rate_limited_email',
    };
  }

  const floor = deps.timingFloor ?? noTimingFloor();
  const startedAt = floor.monotonicNow();

  const rawToken = (deps.mintToken ?? mintMagicToken)();
  const tokenHash = hashToken(rawToken);

  // Unconditional, and before the account lookup. See point 3 above.
  await deps.store.createToken({
    tokenHash,
    email,
    expiresAt: magicTokenExpiry(input.now),
    createdAt: input.now,
  });

  const account = await deps.store.findAccountByEmail(email);

  let outcome: AuthRequestOutcome = 'suppressed';
  if (account !== null) {
    outcome = await deliver({ email, rawToken, tokenHash }, deps);
  }

  await padTo(floor, startedAt);

  return { httpStatus: 200, message: CHECK_YOUR_INBOX, outcome };
}

/**
 * Send, and turn every possible failure into a log-only outcome.
 *
 * The `try` is the point of the function. `MailTransport.send` is documented to
 * return failures rather than throw, but a real client can still reject — DNS,
 * an aborted socket, an SDK that decided a 500 deserves an exception — and an
 * unhandled rejection here becomes a 500 for known addresses and a 200 for
 * unknown ones, which is exactly the leak the rest of this file is built to
 * prevent.
 */
async function deliver(
  token: { email: string; rawToken: string; tokenHash: string },
  deps: AuthRequestDeps,
): Promise<AuthRequestOutcome> {
  try {
    const result = await deps.mail.send(
      renderMagicLinkEmail({
        email: token.email,
        from: deps.mailFrom,
        verifyUrl: deps.verifyUrl,
        rawToken: token.rawToken,
        // Derived from the HASH, never the token: this value reaches provider
        // logs and our own, and neither is a place for a bearer credential.
        idempotencyKey: `magic-link:${token.tokenHash}`,
      }),
    );
    return result.outcome === 'sent' ? 'sent' : 'delivery_failed';
  } catch {
    return 'delivery_failed';
  }
}
