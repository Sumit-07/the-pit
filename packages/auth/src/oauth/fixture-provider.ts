/**
 * An `OAuthProvider` that never opens a socket.
 *
 * There are no GitHub client credentials in this repository, so every test in
 * this package and in `apps/web` runs against this. Same posture as
 * `FixtureMailTransport` and `packages/payments`' `FixtureDodoTransport`: the
 * fake ships in `src` rather than in `test/` because the web app's route tests
 * and local development both need it, and a fake that lives in one package's
 * test folder gets reimplemented — differently — by the next package.
 *
 * ## It is deliberately able to misbehave
 *
 * The interesting properties of this flow are all on failure paths, and a
 * fixture that only succeeds leaves every one of them untested:
 *
 * - `failExchange` / `failIdentity` — the provider being down, the client secret
 *   being revoked, the code being replayed. Each has to render a page rather
 *   than a 500.
 * - The `emails` array takes `verified: false` entries, which is the whole
 *   security boundary. A fixture that could only produce verified addresses
 *   would make the one test that matters unwritable.
 * - `pkce` is a constructor option, so both the S256 path and the `'none'` path
 *   GitHub actually uses are exercised.
 *
 * It also records every call, so a test can assert that the store was never
 * asked about an unverified address rather than only that the outcome was right.
 */

import type {
  AuthorizationRequest,
  CodeExchange,
  OAuthIdentityResult,
  OAuthProvider,
  OAuthTokenResult,
  ProviderEmail,
  ProviderIdentity,
} from './types.js';

export interface FixtureProviderOptions {
  readonly id?: string;
  readonly pkce?: 'S256' | 'none';
  readonly authorizationEndpoint?: string;
  /** Who the provider will say signed in. */
  readonly identity?: ProviderIdentity;
  /** The code the fixture considers valid. Anything else fails the exchange. */
  readonly validCode?: string;
  readonly accessToken?: string;
}

export class FixtureOAuthProvider implements OAuthProvider {
  readonly id: string;
  readonly pkce: 'S256' | 'none';

  /** Every authorization URL this fixture was asked to build. */
  readonly authorizations: AuthorizationRequest[] = [];
  /** Every code exchange attempted, verifier included. */
  readonly exchanges: CodeExchange[] = [];
  /** Every access token an identity was fetched with. */
  readonly identityFetches: string[] = [];

  #identity: ProviderIdentity;
  #failExchange: string | null = null;
  #failIdentity: string | null = null;

  readonly #authorizationEndpoint: string;
  readonly #validCode: string;
  readonly #accessToken: string;

  constructor(options: FixtureProviderOptions = {}) {
    this.id = options.id ?? 'github';
    this.pkce = options.pkce ?? 'none';
    this.#authorizationEndpoint = options.authorizationEndpoint ?? 'https://provider.test/authorize';
    this.#validCode = options.validCode ?? 'good-code';
    this.#accessToken = options.accessToken ?? 'fixture-access-token';
    this.#identity = options.identity ?? { providerUserId: '1', emails: [] };
  }

  /** Point the fixture at a different person. */
  setIdentity(identity: ProviderIdentity): void {
    this.#identity = identity;
  }

  /** Convenience: one user id and a list of addresses. */
  setEmails(providerUserId: string, emails: readonly ProviderEmail[], login?: string): void {
    this.#identity = { providerUserId, emails, ...(login === undefined ? {} : { login }) };
  }

  failExchange(reason = 'fixture provider was told to fail the exchange'): void {
    this.#failExchange = reason;
  }

  failIdentity(reason = 'fixture provider was told to fail the identity fetch'): void {
    this.#failIdentity = reason;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    this.authorizations.push(request);
    const url = new URL(this.#authorizationEndpoint);
    url.searchParams.set('state', request.state);
    url.searchParams.set('redirect_uri', request.redirectUri);
    if (request.codeChallenge !== undefined) {
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  exchangeCode(exchange: CodeExchange): Promise<OAuthTokenResult> {
    this.exchanges.push(exchange);
    if (this.#failExchange !== null) {
      return Promise.resolve({ outcome: 'failed', reason: this.#failExchange });
    }
    if (exchange.code !== this.#validCode) {
      // GitHub's `bad_verification_code`, which is also what a replayed code
      // gets: authorization codes are single-use at the provider.
      return Promise.resolve({ outcome: 'failed', reason: 'bad_verification_code' });
    }
    return Promise.resolve({ outcome: 'token', accessToken: this.#accessToken });
  }

  fetchIdentity(accessToken: string): Promise<OAuthIdentityResult> {
    this.identityFetches.push(accessToken);
    if (this.#failIdentity !== null) {
      return Promise.resolve({ outcome: 'failed', reason: this.#failIdentity });
    }
    return Promise.resolve({ outcome: 'identity', identity: this.#identity });
  }
}

/** A verified address, for readable test setup. */
export function verifiedEmail(email: string, primary = false): ProviderEmail {
  return { email, verified: true, primary };
}

/**
 * An UNVERIFIED address — the one an attacker adds to their own GitHub account
 * without proving anything. Named so that a test using it reads as the attack it
 * describes.
 */
export function unverifiedEmail(email: string, primary = false): ProviderEmail {
  return { email, verified: false, primary };
}
