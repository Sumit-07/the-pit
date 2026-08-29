/**
 * Redemption — the POST half of `brief §2.1`'s two-step verify.
 *
 * > `GET /auth/verify` renders a **button**; a `POST` does the actual
 * > verification. Corporate mail scanners (Outlook Safe Links) follow GET links
 * > and would burn single-use tokens. Do not skip this.
 *
 * ## The split is structural, not a convention
 *
 * There is no `GET` codepath in this module. Nothing here is reachable without a
 * POST, and the GET handler in `apps/web` is given no store at all — it takes a
 * `Request` and returns HTML, and its type signature makes a database call
 * impossible rather than merely discouraged. `apps/web/test/auth-verify.test.ts`
 * asserts the consequence directly: a GET leaves the store's call log empty and
 * the token still redeemable.
 *
 * This matters more than it looks. Outlook Safe Links, Proofpoint URL Defense,
 * Mimecast, Gmail's image proxy and half the antivirus products in existence
 * fetch every URL in an inbound message, usually within seconds and usually from
 * an address nowhere near the recipient. A single-use token behind a GET is
 * spent before the human sees the mail, and the resulting bug — "the link says
 * it already expired, but I only just got it" — reproduces on exactly the
 * corporate mail systems nobody tests against and on none of the consumer ones
 * everybody does.
 *
 * ## Order of operations
 *
 * 1. Reject an empty token without touching anything.
 * 2. Spend the per-IP verify budget. Before the store, so a guessing loop is
 *    rate-limited by the cheapest possible check.
 * 3. Hash, then `consumeToken` — one atomic statement that decides validity and
 *    spends the token together. See `store.ts`.
 * 4. Look the account up. A token whose address has no account is refused here,
 *    which is what makes it safe for `requestMagicLink` to write a token row for
 *    an unknown address in order to keep its database work constant.
 * 5. Mint the session.
 *
 * ## One rejection, several reasons
 *
 * `reason` exists for logs. The route renders the same page for all of them —
 * "expired or already used" — because telling someone holding a stolen, guessed
 * or replayed token *which* of those it was is free reconnaissance.
 */

import { AUTH_RATE_LIMITS, bucketKey, type RateLimiter } from './rate-limit.js';
import {
  newSessionPayload,
  serializeSessionCookie,
  signSessionCookie,
  type SessionKeyring,
  type SessionPayload,
} from './session/cookie.js';
import type { AuthStore } from './store.js';
import { hashToken } from './token.js';

export interface VerifyDeps {
  readonly store: AuthStore;
  readonly limiter: RateLimiter;
  readonly keyring: SessionKeyring;
  /** `false` only on `http://localhost`. See `session/cookie.ts`. */
  readonly secureCookies?: boolean;
}

export interface VerifyInput {
  /** The raw token from the form body. Never from the query string on a POST. */
  readonly token: string;
  readonly ip: string;
  readonly now: Date;
}

/** Log-only. The rendered page must not vary with it. */
export type VerifyRejection =
  | 'missing_token'
  /** Expired, already used, or never existed — the store cannot tell them apart. */
  | 'invalid_token'
  /** A valid token for an address with no account. Should be rare; log it. */
  | 'no_account';

export type VerifyResult =
  | {
      readonly outcome: 'verified';
      readonly session: SessionPayload;
      /** Ready for `Set-Cookie`. */
      readonly setCookie: string;
    }
  | { readonly outcome: 'rejected'; readonly reason: VerifyRejection }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export async function verifyMagicLink(input: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const token = input.token.trim();
  if (token === '') {
    return { outcome: 'rejected', reason: 'missing_token' };
  }

  const byIp = await deps.limiter.consume({
    key: bucketKey('auth:verify:ip', input.ip),
    policy: AUTH_RATE_LIMITS.verifyPerIp,
    now: input.now,
  });
  if (!byIp.allowed) {
    return { outcome: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds };
  }

  const consumed = await deps.store.consumeToken({ tokenHash: hashToken(token), now: input.now });
  if (consumed.outcome === 'rejected') {
    return { outcome: 'rejected', reason: 'invalid_token' };
  }

  // The token is now spent either way — including on this branch. That is the
  // correct direction: a token that failed to produce a session must not be
  // replayable, and `brief §2.1` puts account creation on the Dodo webhook, so
  // there is nothing this path could do except refuse.
  const account = await deps.store.findAccountByEmail(consumed.email);
  if (account === null) {
    return { outcome: 'rejected', reason: 'no_account' };
  }

  const session = newSessionPayload({ accountId: account.accountId, email: account.email, now: input.now });
  const cookieOptions = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };

  return {
    outcome: 'verified',
    session,
    setCookie: serializeSessionCookie(signSessionCookie(session, deps.keyring), cookieOptions),
  };
}
