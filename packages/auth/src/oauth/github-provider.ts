/**
 * GitHub, as an `OAuthProvider`.
 *
 * Given its `fetch` rather than reaching for the global one, so it is testable
 * against a stub and so nothing in this package can accidentally perform network
 * I/O — the same arrangement `ResendMailTransport` uses.
 *
 * ## Three things GitHub does that break naive implementations
 *
 * 1. **The token endpoint returns `application/x-www-form-urlencoded` by
 *    default.** `POST /login/oauth/access_token` answers
 *    `access_token=gho_...&scope=&token_type=bearer` unless you send
 *    `Accept: application/json`, so a client that calls `response.json()` gets a
 *    parse error and reports "GitHub is down" for a flow that worked perfectly.
 *    The header is set below and `test/github-provider.test.ts` asserts it.
 *
 * 2. **Failures come back as HTTP 200.** A replayed or expired code produces
 *    `200 OK` with `{"error":"bad_verification_code", ...}` in the body. A client
 *    that checks `response.ok` and moves on will read `access_token` as
 *    `undefined`, send `Authorization: Bearer undefined` to the API, and surface
 *    the failure two steps later as something unrelated. The body is inspected
 *    for `error` BEFORE the token is read.
 *
 * 3. **`/user` does not reliably carry the email.** `user.email` is the public
 *    profile field: it is `null` for anyone who has not made an address public,
 *    and — worse — it can be an address the user never verified. The addresses
 *    that matter come from `GET /user/emails`, which requires the `user:email`
 *    scope and returns the `verified` flag this whole design turns on. This
 *    provider therefore makes two calls, and `user.email` is never read.
 *
 * ## The user id, not the login
 *
 * `providerUserId` is `String(user.id)` — GitHub's numeric id. The login is
 * renameable, and a freed-up login can be registered by somebody else, so a link
 * keyed on it hands an account over to whoever claims the name next. The login is
 * carried for display and matched on by nothing.
 *
 * ## Scopes
 *
 * `read:user user:email`, and no more. `user:email` is what makes `/user/emails`
 * readable; `read:user` is the profile. Notably absent is `repo` — the approved
 * ownership perk needs only public repository metadata, which needs no scope at
 * all, and asking for `repo` on a sign-in screen is asking a stranger for write
 * access to their private source code in exchange for a $5 listing.
 */

import type {
  AuthorizationRequest,
  CodeExchange,
  FetchLike,
  OAuthIdentityResult,
  OAuthProvider,
  OAuthTokenResult,
  ProviderEmail,
  ProviderIdentity,
} from './types.js';

export const GITHUB_AUTHORIZE_ENDPOINT = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
export const GITHUB_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

/** The least GitHub will give us that still answers "is this address verified". */
export const GITHUB_SCOPES = 'read:user user:email';

/** GitHub's API version pin. Unversioned requests get whatever ships that week. */
export const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch: FetchLike;
  /** Overridable for a GitHub Enterprise host or a test double. */
  readonly authorizeEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly userEndpoint?: string;
  readonly emailsEndpoint?: string;
}

export class GitHubOAuthProvider implements OAuthProvider {
  readonly id = 'github';

  /**
   * GitHub's OAuth Apps and GitHub Apps user-to-server flows do not accept
   * `code_challenge`. Declaring `'none'` is the honest answer; see `types.ts`.
   * The CSRF binding is carried by `state` in a signed, `HttpOnly` cookie, and
   * the exchange is authenticated by the client secret.
   */
  readonly pkce = 'none' as const;

  readonly #options: Required<Omit<GitHubProviderOptions, 'fetch'>> & { fetch: FetchLike };

  constructor(options: GitHubProviderOptions) {
    this.#options = {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      fetch: options.fetch,
      authorizeEndpoint: options.authorizeEndpoint ?? GITHUB_AUTHORIZE_ENDPOINT,
      tokenEndpoint: options.tokenEndpoint ?? GITHUB_TOKEN_ENDPOINT,
      userEndpoint: options.userEndpoint ?? GITHUB_USER_ENDPOINT,
      emailsEndpoint: options.emailsEndpoint ?? GITHUB_EMAILS_ENDPOINT,
    };
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(this.#options.authorizeEndpoint);
    url.searchParams.set('client_id', this.#options.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', GITHUB_SCOPES);
    url.searchParams.set('state', request.state);
    // GitHub ignores a challenge, and `pkce: 'none'` means `startOAuthSignIn`
    // never mints one. Forwarded if a caller supplies it anyway so that a
    // GitHub Enterprise host which grows support is a config change.
    if (request.codeChallenge !== undefined) {
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeCode(exchange: CodeExchange): Promise<OAuthTokenResult> {
    const body = new URLSearchParams({
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret,
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
    });
    if (exchange.codeVerifier !== undefined) {
      body.set('code_verifier', exchange.codeVerifier);
    }

    let response: Response;
    try {
      response = await this.#options.fetch(this.#options.tokenEndpoint, {
        method: 'POST',
        headers: {
          // Without this the response is form-encoded. See the header.
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        body: body.toString(),
      });
    } catch (error) {
      return { outcome: 'failed', reason: `token request threw: ${message(error)}` };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { outcome: 'failed', reason: `token response was not JSON (HTTP ${response.status})` };
    }
    if (typeof payload !== 'object' || payload === null) {
      return { outcome: 'failed', reason: `token response was not an object (HTTP ${response.status})` };
    }
    const record = payload as Record<string, unknown>;

    // BEFORE reading the token: GitHub reports a bad or replayed code as 200.
    if (typeof record['error'] === 'string' && record['error'] !== '') {
      return { outcome: 'failed', reason: `github: ${record['error']}` };
    }
    if (!response.ok) {
      return { outcome: 'failed', reason: `token endpoint returned HTTP ${response.status}` };
    }

    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      return { outcome: 'failed', reason: 'token response carried no access_token' };
    }
    return { outcome: 'token', accessToken };
  }

  async fetchIdentity(accessToken: string): Promise<OAuthIdentityResult> {
    const user = await this.#get(this.#options.userEndpoint, accessToken);
    if (user.outcome === 'failed') {
      return user;
    }
    if (typeof user.body !== 'object' || user.body === null) {
      return { outcome: 'failed', reason: '/user did not return an object' };
    }
    const profile = user.body as Record<string, unknown>;

    // The numeric id, never the login. See the header.
    const rawId = profile['id'];
    if (typeof rawId !== 'number' && typeof rawId !== 'string') {
      return { outcome: 'failed', reason: '/user carried no usable id' };
    }
    const providerUserId = String(rawId);
    if (providerUserId === '' || providerUserId === '0') {
      return { outcome: 'failed', reason: '/user carried an empty id' };
    }

    const emails = await this.#get(this.#options.emailsEndpoint, accessToken);
    if (emails.outcome === 'failed') {
      return emails;
    }
    if (!Array.isArray(emails.body)) {
      return { outcome: 'failed', reason: '/user/emails did not return an array' };
    }

    const login = profile['login'];
    const identity: ProviderIdentity = {
      providerUserId,
      emails: parseEmails(emails.body),
      ...(typeof login === 'string' && login !== '' ? { login } : {}),
    };
    return { outcome: 'identity', identity };
  }

  async #get(
    url: string,
    accessToken: string,
  ): Promise<{ outcome: 'ok'; body: unknown } | { outcome: 'failed'; reason: string }> {
    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'x-github-api-version': GITHUB_API_VERSION,
          // GitHub rejects API requests with no user agent.
          'user-agent': 'the-pit',
        },
      });
    } catch (error) {
      return { outcome: 'failed', reason: `${url} threw: ${message(error)}` };
    }
    if (!response.ok) {
      return { outcome: 'failed', reason: `${url} returned HTTP ${response.status}` };
    }
    try {
      return { outcome: 'ok', body: await response.json() };
    } catch {
      return { outcome: 'failed', reason: `${url} did not return JSON` };
    }
  }
}

/**
 * Turn `/user/emails` into `ProviderEmail`s.
 *
 * `verified === true` and `primary === true` are strict identity comparisons,
 * not truthiness. This is the last place the provider's own JSON is read, and a
 * response carrying the string `"true"` — or anything else truthy — must not
 * become a verified address. The actual filtering happens in
 * `verified-emails.ts`; this only transcribes, and it transcribes conservatively.
 */
function parseEmails(rows: readonly unknown[]): readonly ProviderEmail[] {
  const parsed: ProviderEmail[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const email = record['email'];
    if (typeof email !== 'string' || email === '') {
      continue;
    }
    parsed.push({
      email,
      verified: record['verified'] === true,
      primary: record['primary'] === true,
    });
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
