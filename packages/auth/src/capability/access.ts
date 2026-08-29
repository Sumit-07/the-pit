/**
 * Opening a capability URL, and rotating one.
 *
 * Two functions, and the asymmetry between them is the point:
 *
 * - `openCapabilityUrl` needs no session. The slug IS the credential; requiring
 *   a session to use it would make it useless, since not having one is the
 *   situation it exists for.
 * - `rotateCapability` needs a session and nothing else. Rotation is
 *   destructive — it strands anyone holding the old URL, which after a genuine
 *   leak is exactly what the customer wants and after a mistaken click is a
 *   support ticket — so it is gated on proof of the account, not on possession
 *   of the slug being replaced.
 *
 * ## Rotating from the session rather than from the slug
 *
 * The obvious design is `POST /a/<slug>/rotate`: you hold the slug, you may
 * replace it. It is wrong in the case that matters. A customer who thinks their
 * URL leaked is, by hypothesis, not the only person holding it — and under that
 * design the leaker can rotate too, locking the customer out of their own
 * account with one request. Gating on the session means the person who can prove
 * they are the account wins, and the person who merely read a URL over their
 * shoulder does not.
 *
 * The session can itself have been established by the leaked slug, which sounds
 * circular and is not: the attacker's window is until the customer notices, the
 * same as for any bearer credential, and after rotation the attacker's session
 * cookie remains valid until it expires. That last part is a real limitation and
 * is stated plainly in the report — a stateless 90-day cookie (`session/cookie.ts`)
 * cannot be revoked individually, so rotation stops future entries through the
 * URL and does not terminate a session already established through it.
 *
 * ## One answer for "malformed" and "no such slug"
 *
 * `openCapabilityUrl` reports both as `rejected`, and the route renders one page
 * for them. Distinguishing them would confirm to someone walking the keyspace
 * that a candidate had the right shape — which is the only useful signal a
 * guesser can get, since they already know the shape from any real URL.
 */

import {
  newSessionPayload,
  readSession,
  serializeSessionCookie,
  signSessionCookie,
  type SessionKeyring,
  type SessionPayload,
} from '../session/cookie.js';
import { AUTH_RATE_LIMITS, bucketKey, type RateLimiter } from '../rate-limit.js';
import type { AuthAccount } from '../store.js';
import type { IdentityStore } from '../identity-store.js';
import { capabilityUrl, isCapabilitySlug, mintCapabilitySlug, type RandomBytes } from './slug.js';

export interface CapabilityDeps {
  readonly store: IdentityStore;
  readonly limiter: RateLimiter;
  readonly keyring: SessionKeyring;
  /** `false` only on `http://localhost`. See `session/cookie.ts`. */
  readonly secureCookies?: boolean;
  /** Overridden only by tests that pin the minted value. */
  readonly random?: RandomBytes;
}

export interface OpenCapabilityInput {
  /** The raw path segment. Never trusted, never normalized. */
  readonly slug: string;
  readonly ip: string;
  readonly now: Date;
}

/** Log-only, like `VerifyRejection`. The rendered page must not vary with it. */
export type CapabilityRejection = 'malformed_slug' | 'unknown_slug';

export type OpenCapabilityResult =
  | {
      readonly outcome: 'signed_in';
      readonly account: AuthAccount;
      readonly session: SessionPayload;
      /** Ready for `Set-Cookie`. */
      readonly setCookie: string;
    }
  | { readonly outcome: 'rejected'; readonly reason: CapabilityRejection }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

/**
 * Exchange a slug for a session.
 *
 * Order: shape, then budget, then store. The shape check is free and refuses
 * every path that could not possibly be a slug before it costs a rate-limit
 * slot, so a crawler hitting `/a/favicon.ico` does not consume a real
 * customer's budget on a shared NAT address.
 */
export async function openCapabilityUrl(
  input: OpenCapabilityInput,
  deps: CapabilityDeps,
): Promise<OpenCapabilityResult> {
  if (!isCapabilitySlug(input.slug)) {
    return { outcome: 'rejected', reason: 'malformed_slug' };
  }

  const byIp = await deps.limiter.consume({
    key: bucketKey('auth:capability:ip', input.ip),
    policy: AUTH_RATE_LIMITS.capabilityPerIp,
    now: input.now,
  });
  if (!byIp.allowed) {
    return { outcome: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds };
  }

  const account = await deps.store.findAccountByCapabilitySlug(input.slug);
  if (account === null) {
    return { outcome: 'rejected', reason: 'unknown_slug' };
  }

  return { outcome: 'signed_in', account, ...sessionFor(account, input.now, deps) };
}

export interface RotateCapabilityInput {
  /** The raw `Cookie:` header. The session in it is the authorization. */
  readonly cookieHeader: string | null | undefined;
  /** For building the URL that is handed back. */
  readonly origin: string;
  readonly now: Date;
}

export type RotateCapabilityResult =
  | {
      readonly outcome: 'rotated';
      readonly accountId: string;
      /** The new slug. The old one stopped resolving in the same statement. */
      readonly slug: string;
      readonly url: string;
    }
  /** No valid session. The caller answers 401 and offers the sign-in page. */
  | { readonly outcome: 'rejected'; readonly reason: 'no_session' | 'unknown_account' };

/**
 * Mint a new slug for the session's account and write it over the old one.
 *
 * The new slug is generated here rather than by the store so that the CSPRNG
 * this package asserts (`CAPABILITY_CSPRNG`) is the one that produces every slug
 * a customer is ever handed — including the rotated ones, which is the case
 * where "we already had a generator, close enough" tends to creep in.
 */
export async function rotateCapability(
  input: RotateCapabilityInput,
  deps: CapabilityDeps,
): Promise<RotateCapabilityResult> {
  const options = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const verified = readSession({
    cookieHeader: input.cookieHeader,
    keyring: deps.keyring,
    now: input.now,
    ...options,
  });
  if (!verified.valid) {
    return { outcome: 'rejected', reason: 'no_session' };
  }

  const slug = mintCapabilitySlug(deps.random);
  const written = await deps.store.rotateCapabilitySlug({
    accountId: verified.session.accountId,
    slug,
    now: input.now,
  });
  if (written.outcome === 'unknown_account') {
    // A signed cookie naming an account that no longer exists. Not reachable by
    // an attacker — the MAC held — so this is our bug or a deleted row, and it
    // is reported rather than silently treated as a successful rotation.
    return { outcome: 'rejected', reason: 'unknown_account' };
  }

  return {
    outcome: 'rotated',
    accountId: verified.session.accountId,
    slug,
    url: capabilityUrl(input.origin, slug),
  };
}

/** The one place a session is minted for the capability path. */
function sessionFor(
  account: AuthAccount,
  now: Date,
  deps: CapabilityDeps,
): { session: SessionPayload; setCookie: string } {
  const session = newSessionPayload({ accountId: account.accountId, email: account.email, now });
  const options = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  return { session, setCookie: serializeSessionCookie(signSessionCookie(session, deps.keyring), options) };
}
