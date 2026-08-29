/**
 * The OAuth seam.
 *
 * There are no GitHub client credentials in this repository and there must not
 * be any in a test, so the provider is an interface with three methods and two
 * implementations: `FixtureOAuthProvider`, which answers from arrays, and
 * `GitHubOAuthProvider`, which is handed its `fetch` rather than reaching for
 * the global one. Exactly the shape `mail/types.ts` uses for Resend, and for the
 * same reason — every test in this package runs with no network and no secret.
 *
 * ## Nothing here throws on a provider failure
 *
 * `exchangeCode` and `fetchIdentity` return unions. A network error, a 500, a
 * revoked client secret and a user who pressed "cancel" are all outcomes the
 * callback has to render, and a thrown exception would turn each of them into a
 * 500 on our side — an error page for a person who did nothing wrong, and a
 * pager for us at a time when the only correct action is to say "GitHub said
 * no, try the link in your receipt instead".
 *
 * ## PKCE is declared, not assumed
 *
 * `brief`-adjacent guidance asks for "PKCE where applicable", and for GitHub it
 * is not applicable: GitHub's OAuth Apps and GitHub Apps user-to-server flows do
 * not accept `code_challenge`, and sending one is at best ignored. Pretending
 * otherwise — generating a verifier, putting it in a cookie, and posting it to
 * an endpoint that discards it — would look like a security control in a code
 * review while providing nothing.
 *
 * So a provider DECLARES its support. `pkce: 'S256'` makes `startOAuthSignIn`
 * generate a verifier, put the challenge on the authorization URL and send the
 * verifier at exchange time; `pkce: 'none'` makes it generate no verifier at
 * all, and the CSRF binding is carried entirely by the `state` parameter and the
 * signed cookie it lives in — which is the control that actually matters for a
 * server-side client holding a client secret. `FixtureOAuthProvider` can be
 * either, so both paths are exercised.
 */

/**
 * One address as a provider reports it.
 *
 * `verified` is the only field with security meaning, and it is the reason this
 * type exists rather than a bare `string[]`. See `verified-emails.ts`.
 */
export interface ProviderEmail {
  readonly email: string;
  /** The provider says it proved control of this address. */
  readonly verified: boolean;
  /** The provider's default address. Used only to order candidates. */
  readonly primary: boolean;
}

/**
 * Who the provider says signed in.
 *
 * `providerUserId` must be the provider's IMMUTABLE id — GitHub's numeric
 * `user.id`, not the login. A login is renameable and re-registerable, so a link
 * keyed on one is an account takeover waiting for someone to free up a name.
 */
export interface ProviderIdentity {
  readonly providerUserId: string;
  /** Every address the provider returned, verified or not. Filtered downstream. */
  readonly emails: readonly ProviderEmail[];
  /** Display only — never matched on, never used as a key. */
  readonly login?: string;
}

export type OAuthTokenResult =
  | { readonly outcome: 'token'; readonly accessToken: string }
  /** Anything else: a bad code, a revoked secret, a 500, a dropped socket. */
  | { readonly outcome: 'failed'; readonly reason: string };

export type OAuthIdentityResult =
  | { readonly outcome: 'identity'; readonly identity: ProviderIdentity }
  | { readonly outcome: 'failed'; readonly reason: string };

/** What `startOAuthSignIn` hands a provider to build its authorization URL. */
export interface AuthorizationRequest {
  readonly state: string;
  readonly redirectUri: string;
  /** Present only when the provider declares `pkce: 'S256'`. */
  readonly codeChallenge?: string;
}

export interface CodeExchange {
  readonly code: string;
  readonly redirectUri: string;
  /** Present only when the provider declares `pkce: 'S256'`. */
  readonly codeVerifier?: string;
}

export interface OAuthProvider {
  /**
   * The stable key this provider is stored under in `account_identities`.
   * Lowercase; the table CHECKs `^[a-z][a-z0-9_]{1,31}$`.
   */
  readonly id: string;
  /** Whether to run PKCE. See the header — for GitHub this is `'none'`. */
  readonly pkce: 'S256' | 'none';
  /** Where to send the browser. Pure; performs no I/O. */
  authorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(exchange: CodeExchange): Promise<OAuthTokenResult>;
  fetchIdentity(accessToken: string): Promise<OAuthIdentityResult>;
}

/** The `fetch` shape both the mail and OAuth transports are injected with. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
