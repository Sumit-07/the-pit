/**
 * The OAuth flow: starting it, and completing it.
 *
 * ## GitHub is an upgrade, never a gate
 *
 * `brief §2.1` is unchanged and binding: **no login at submission.** Guest
 * checkout takes a URL, a name, a description and a payment, and nothing sits
 * between a visitor and their purchase. Nothing in this file is reachable from
 * the buying path, and that is a requirement rather than a coincidence — on a
 * phone, without the GitHub app installed, OAuth means typing a password and a
 * 2FA code into a mobile browser for a $5 impulse purchase, which is where a
 * funnel goes to die.
 *
 * So the ordering is the customer's choice and both orders end in the same
 * place. Pay first and the success page hands over a capability URL
 * (`capability/`); connect GitHub later and it links to that same account
 * (`intent: 'link'`). Connect GitHub first and a verified address that matches a
 * purchase signs in to the account that purchase already made. There is no
 * order of operations that produces a second account, and
 * `test/oauth-sign-in.test.ts` asserts that from both directions.
 *
 * ## The two intents
 *
 * `sign_in` — no session. The only way to reach an account is for a VERIFIED
 * provider address to match a payment email, or for this provider identity to
 * have been linked before. No match means no account, and no account means we
 * say so: `brief §2.1`'s design is that the payment email is the identity, and
 * an account with no purchase behind it is a fiction that would then have to be
 * merged with the real one when the customer eventually paid.
 *
 * `link` — a session already exists, established by a magic link or a capability
 * URL. Here the session is the proof of account ownership and the OAuth round
 * trip is the proof of provider ownership, so NO email match is required and
 * none is looked for. This is retroactive claiming, and it is the reason the
 * mobile story works: pay as a guest, bookmark the URL, connect GitHub whenever.
 *
 * Which one is running is decided when the flow STARTS and travels in the signed
 * state cookie. It is never re-derived at the callback from a query parameter,
 * because a callback that could be told which mode to run in is a callback an
 * attacker can tell to run in the mode that skips the email check.
 *
 * ## Order of operations at the callback
 *
 * 1. Spend the per-IP budget. Before anything that costs an outbound request.
 * 2. Refuse a provider-reported error (`?error=access_denied`) without touching
 *    the store.
 * 3. Verify the state cookie, then compare it to `?state=` in constant time.
 *    Before the code exchange, so a CSRF attempt never reaches GitHub.
 * 4. Exchange the code; fetch the identity.
 * 5. **Filter to verified addresses.** `verified-emails.ts`. This is the boundary.
 * 6. Resolve: existing link first, then verified-email match. Never create.
 * 7. Link, then mint the session.
 *
 * Step 6's ordering is what keeps a customer's account reachable after they
 * change their GitHub email — the link is keyed on GitHub's immutable numeric
 * id, and an address change does not move it.
 */

import { AUTH_RATE_LIMITS, bucketKey, type RateLimiter } from '../rate-limit.js';
import {
  newSessionPayload,
  readSession,
  serializeSessionCookie,
  signSessionCookie,
  type SessionKeyring,
  type SessionPayload,
} from '../session/cookie.js';
import type { AccountStore } from '../identity-store.js';
import type { RandomBytes } from '../capability/slug.js';
import {
  clearOAuthStateCookie,
  codeChallengeFor,
  mintCodeVerifier,
  mintOAuthState,
  OAUTH_STATE_TTL_MS,
  readOAuthState,
  serializeOAuthStateCookie,
  signOAuthState,
  statesMatch,
  type OAuthStatePayload,
} from './state.js';
import type { OAuthProvider } from './types.js';
import { unverifiedProviderEmails, verifiedProviderEmails } from './verified-emails.js';

export interface OAuthDeps {
  readonly provider: OAuthProvider;
  readonly store: AccountStore;
  readonly limiter: RateLimiter;
  readonly keyring: SessionKeyring;
  /** `false` only on `http://localhost`. */
  readonly secureCookies?: boolean;
  /** Overridden only by tests that pin the state and verifier. */
  readonly random?: RandomBytes;
}

export interface StartOAuthInput {
  /** Where GitHub sends the browser back. Must match the app's registration. */
  readonly redirectUri: string;
  readonly now: Date;
  /**
   * The raw `Cookie:` header. Read ONLY to decide the intent — a valid session
   * means the customer is connecting a provider to an account they already
   * hold, and the callback must not then go looking for an email match.
   */
  readonly cookieHeader?: string | null | undefined;
}

export interface StartOAuthResult {
  /** Send the browser here. */
  readonly authorizationUrl: string;
  /** `Set-Cookie` for the signed state. */
  readonly setCookie: string;
  readonly intent: 'sign_in' | 'link';
}

/**
 * Begin the flow.
 *
 * Performs no I/O: it mints two random values, asks the provider to format a
 * URL, and signs a cookie. Everything that can fail happens at the callback.
 */
export function startOAuthSignIn(input: StartOAuthInput, deps: OAuthDeps): StartOAuthResult {
  const cookieOptions = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };

  const session = readSession({
    cookieHeader: input.cookieHeader ?? null,
    keyring: deps.keyring,
    now: input.now,
    ...cookieOptions,
  });
  const intent: 'sign_in' | 'link' = session.valid ? 'link' : 'sign_in';

  const state = mintOAuthState(deps.random);
  // Only when the provider actually honours it. See `types.ts`: sending a
  // challenge to an endpoint that ignores it is a control that exists in the
  // diff and nowhere else.
  const codeVerifier = deps.provider.pkce === 'S256' ? mintCodeVerifier(deps.random) : null;

  const payload: OAuthStatePayload = {
    provider: deps.provider.id,
    state,
    codeVerifier,
    intent,
    expiresAt: Math.floor((input.now.getTime() + OAUTH_STATE_TTL_MS) / 1000),
  };

  const authorizationUrl = deps.provider.authorizationUrl({
    state,
    redirectUri: input.redirectUri,
    ...(codeVerifier === null ? {} : { codeChallenge: codeChallengeFor(codeVerifier) }),
  });

  return {
    authorizationUrl,
    setCookie: serializeOAuthStateCookie(signOAuthState(payload, deps.keyring), cookieOptions),
    intent,
  };
}

export interface CompleteOAuthInput {
  /** `?code=`, `?state=`, `?error=` as the callback received them. */
  readonly code: string | null;
  readonly state: string | null;
  readonly error: string | null;
  readonly redirectUri: string;
  readonly cookieHeader: string | null | undefined;
  readonly ip: string;
  readonly now: Date;
}

/** Log-only. Several of these render one page; see the route. */
export type OAuthRejection =
  | 'provider_denied'
  | 'missing_code'
  | 'state_missing'
  | 'state_expired'
  | 'state_mismatch'
  | 'provider_mismatch'
  | 'exchange_failed'
  | 'identity_failed'
  /** `intent: 'link'` but the session went away mid-flow. */
  | 'session_expired';

export type CompleteOAuthResult =
  | {
      readonly outcome: 'signed_in';
      readonly accountId: string;
      readonly email: string;
      readonly session: SessionPayload;
      /** The session cookie, then the cleared state cookie. Both must be sent. */
      readonly setCookies: readonly string[];
      /** `link` when this attached a provider to an account already in session. */
      readonly intent: 'sign_in' | 'link';
      /** True when this sign-in created the `account_identities` row. */
      readonly linked: boolean;
    }
  | {
      /**
       * GitHub did not get them in — either none of their verified addresses
       * has bought anything, or (when `verifiedEmails` is empty) GitHub had no
       * verified address to offer.
       *
       * NOT an error and NOT an account. The page names the addresses we looked
       * at and points at the capability URL from the receipt — see
       * `identity-store.ts`'s "an account is a purchase". Both lists are carried
       * so the copy can distinguish the two cases without this type having to.
       */
      readonly outcome: 'no_purchase_found';
      readonly verifiedEmails: readonly string[];
      /** Shown as "we ignored these, they are unverified". Never matched on. */
      readonly ignoredEmails: readonly string[];
      readonly setCookies: readonly string[];
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: OAuthRejection;
      readonly setCookies: readonly string[];
    }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export async function completeOAuthSignIn(
  input: CompleteOAuthInput,
  deps: OAuthDeps,
): Promise<CompleteOAuthResult> {
  const cookieOptions = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  // Cleared on every path below, success and failure alike.
  const cleared = [clearOAuthStateCookie(cookieOptions)];
  const reject = (reason: OAuthRejection): CompleteOAuthResult => ({
    outcome: 'rejected',
    reason,
    setCookies: cleared,
  });

  const byIp = await deps.limiter.consume({
    key: bucketKey('auth:oauth:ip', input.ip),
    policy: AUTH_RATE_LIMITS.oauthPerIp,
    now: input.now,
  });
  if (!byIp.allowed) {
    return { outcome: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds };
  }

  // The customer pressed "Cancel" on GitHub's screen, or GitHub refused. Not a
  // failure worth a stack trace; the page says so and offers the other two paths.
  if (input.error !== null && input.error !== '') {
    return reject('provider_denied');
  }

  const stateCookie = readOAuthState({
    cookieHeader: input.cookieHeader,
    keyring: deps.keyring,
    now: input.now,
    ...cookieOptions,
  });
  if (!stateCookie.valid) {
    return reject(stateCookie.reason === 'expired' ? 'state_expired' : 'state_missing');
  }
  if (input.state === null || input.state === '' || !statesMatch(input.state, stateCookie.payload.state)) {
    return reject('state_mismatch');
  }
  // A state issued for one provider must not complete another's callback.
  if (stateCookie.payload.provider !== deps.provider.id) {
    return reject('provider_mismatch');
  }
  if (input.code === null || input.code === '') {
    return reject('missing_code');
  }

  const token = await deps.provider.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
    ...(stateCookie.payload.codeVerifier === null ? {} : { codeVerifier: stateCookie.payload.codeVerifier }),
  });
  if (token.outcome === 'failed') {
    return reject('exchange_failed');
  }

  const fetched = await deps.provider.fetchIdentity(token.accessToken);
  if (fetched.outcome === 'failed') {
    return reject('identity_failed');
  }
  const identity = fetched.identity;

  // THE BOUNDARY. Everything below matches against `verified` and nothing else.
  const verifiedEmails = verifiedProviderEmails(identity);

  if (stateCookie.payload.intent === 'link') {
    return await linkToSession(input, deps, cleared, identity.providerUserId, verifiedEmails);
  }

  // --- sign_in ---

  // The link first, so a customer who changed their GitHub address since last
  // time still lands on their own account.
  let account = await deps.store.findAccountByProviderIdentity({
    provider: deps.provider.id,
    providerUserId: identity.providerUserId,
  });

  if (account === null) {
    // An identity with no verified address simply has nothing to match, so the
    // loop runs zero times and falls through to `no_purchase_found` below. That
    // is deliberate rather than a special case: "GitHub gave us no verified
    // address" and "none of these addresses bought anything" are the same
    // outcome to the customer — GitHub did not get them in — and the result
    // carries both lists, so the page can be specific about which it was
    // without this function needing a third answer or a rejection page for
    // something that is not an error.
    for (const email of verifiedEmails) {
      const found = await deps.store.findAccountByEmail(email);
      if (found !== null) {
        account = found;
        break;
      }
    }
  }

  if (account === null) {
    // The whole point. No `createAccount` is called, and `AccountStore` has no
    // method that could.
    return {
      outcome: 'no_purchase_found',
      verifiedEmails,
      ignoredEmails: unverifiedProviderEmails(identity),
      setCookies: cleared,
    };
  }

  // `linkedEmail` records which address brought them in. For a match by link
  // rather than by address, the first verified address is the current best
  // answer and refreshes what the row held.
  const linkedEmail = verifiedEmails[0] ?? account.email;
  await deps.store.linkIdentity({
    accountId: account.accountId,
    provider: deps.provider.id,
    providerUserId: identity.providerUserId,
    linkedEmail,
    now: input.now,
  });

  return {
    outcome: 'signed_in',
    accountId: account.accountId,
    email: account.email,
    intent: 'sign_in',
    linked: true,
    ...sessionFor(account.accountId, account.email, input.now, deps, cleared),
  };
}

/**
 * `intent: 'link'` — attach this provider identity to the account already in
 * session.
 *
 * No email match is attempted and none is required. The customer paid with a
 * work address and their GitHub carries a personal one; demanding they agree
 * would make retroactive claiming impossible for most of the people who need it.
 *
 * The session is re-read HERE rather than trusted from the start of the flow,
 * because the round trip through GitHub takes real time and a session can expire
 * inside it. Re-reading also means the account being linked to is the one the
 * browser can prove right now, not the one it could prove ten minutes ago.
 */
async function linkToSession(
  input: CompleteOAuthInput,
  deps: OAuthDeps,
  cleared: readonly string[],
  providerUserId: string,
  verifiedEmails: readonly string[],
): Promise<CompleteOAuthResult> {
  const cookieOptions = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const session = readSession({
    cookieHeader: input.cookieHeader,
    keyring: deps.keyring,
    now: input.now,
    ...cookieOptions,
  });
  if (!session.valid) {
    return { outcome: 'rejected', reason: 'session_expired', setCookies: cleared };
  }

  await deps.store.linkIdentity({
    accountId: session.session.accountId,
    provider: deps.provider.id,
    providerUserId,
    linkedEmail: verifiedEmails[0] ?? session.session.email,
    now: input.now,
  });

  return {
    outcome: 'signed_in',
    accountId: session.session.accountId,
    email: session.session.email,
    intent: 'link',
    linked: true,
    ...sessionFor(session.session.accountId, session.session.email, input.now, deps, cleared),
  };
}

/**
 * Mint a fresh session and pair it with the cleared state cookie.
 *
 * Fresh even on the `link` path: the customer just re-proved who they are, so
 * restarting the 90 days is correct, and issuing a new cookie means the flow has
 * exactly one exit shape instead of two.
 */
function sessionFor(
  accountId: string,
  email: string,
  now: Date,
  deps: OAuthDeps,
  cleared: readonly string[],
): { session: SessionPayload; setCookies: readonly string[] } {
  const session = newSessionPayload({ accountId, email, now });
  const options = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const sessionCookie = serializeSessionCookie(signSessionCookie(session, deps.keyring), options);
  return { session, setCookies: [sessionCookie, ...cleared] };
}
