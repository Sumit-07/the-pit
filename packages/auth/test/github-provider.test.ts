/**
 * `GitHubOAuthProvider` against a stub `fetch`. No network, no client secret
 * that means anything, no GitHub account.
 *
 * The tests worth having here are the ones about GitHub's specific behaviour
 * rather than about OAuth in general, because those are the ones that pass code
 * review and fail in production:
 *
 * - the token endpoint answers form-encoded unless asked for JSON;
 * - it reports a bad or replayed code as **HTTP 200** with an `error` key;
 * - `/user` does not reliably carry a usable email, and the one it carries may
 *   be unverified — so the addresses come from `/user/emails` or not at all.
 */

import { describe, expect, it } from 'vitest';

import {
  GITHUB_API_VERSION,
  GITHUB_EMAILS_ENDPOINT,
  GITHUB_SCOPES,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_ENDPOINT,
  GitHubOAuthProvider,
  verifiedProviderEmails,
} from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers from a map of URL to response, and records calls. */
function stubFetch(routes: Record<string, () => Response>): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const route = routes[url];
      if (route === undefined) {
        return Promise.resolve(new Response('not stubbed', { status: 404 }));
      }
      return Promise.resolve(route());
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function provider(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): GitHubOAuthProvider {
  return new GitHubOAuthProvider({ clientId: 'client-id', clientSecret: 'client-secret', fetch: fetchImpl });
}

describe('the authorization URL', () => {
  it('asks for the least that still answers "is this address verified"', () => {
    const url = new URL(
      provider(() => Promise.resolve(new Response())).authorizationUrl({
        state: 'the-state',
        redirectUri: 'https://thepit.show/auth/github/callback',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('redirect_uri')).toBe('https://thepit.show/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
  });

  it('never asks for repo access', () => {
    // Asking a stranger for write access to their private source code in
    // exchange for a $5 listing. Public repository metadata — which is what the
    // approved ownership perk needs — requires no scope at all.
    expect(GITHUB_SCOPES).not.toContain('repo');
    expect(GITHUB_SCOPES.split(' ').sort()).toEqual(['read:user', 'user:email']);
  });

  it('declares that GitHub does not do PKCE, rather than pretending', () => {
    // A verifier posted to an endpoint that discards it is a control that
    // exists in the diff and nowhere else.
    expect(provider(() => Promise.resolve(new Response())).pkce).toBe('none');
  });
});

describe('the token exchange', () => {
  it('asks for JSON, because the endpoint answers form-encoded by default', () => {
    // Without `Accept: application/json` the body is
    // `access_token=gho_...&scope=&token_type=bearer`, `response.json()` throws,
    // and a working flow is reported as "GitHub is down".
    const stub = stubFetch({ [GITHUB_TOKEN_ENDPOINT]: () => json({ access_token: 'gho_token' }) });
    return provider(stub.fetch)
      .exchangeCode({ code: 'c', redirectUri: 'https://thepit.show/auth/github/callback' })
      .then((result) => {
        expect(result).toEqual({ outcome: 'token', accessToken: 'gho_token' });
        const headers = stub.calls[0]?.init?.headers as Record<string, string>;
        expect(headers['accept']).toBe('application/json');
        expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
      });
  });

  it('sends the client secret in the body, never in the query string', async () => {
    const stub = stubFetch({ [GITHUB_TOKEN_ENDPOINT]: () => json({ access_token: 'gho_token' }) });
    await provider(stub.fetch).exchangeCode({ code: 'c', redirectUri: 'https://thepit.show/cb' });

    expect(stub.calls[0]?.url).toBe(GITHUB_TOKEN_ENDPOINT);
    expect(stub.calls[0]?.url).not.toContain('client_secret');
    const body = new URLSearchParams(String(stub.calls[0]?.init?.body));
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('code')).toBe('c');
    expect(body.get('redirect_uri')).toBe('https://thepit.show/cb');
  });

  it('treats a 200 carrying an error as a failure — the replayed-code case', async () => {
    // GitHub answers a bad, expired or already-used code with HTTP 200 and
    // `{"error":"bad_verification_code"}`. A client that checks `response.ok`
    // reads `access_token` as undefined and sends `Bearer undefined` to the API,
    // surfacing the failure two steps later as something unrelated.
    const stub = stubFetch({
      [GITHUB_TOKEN_ENDPOINT]: () =>
        json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }),
    });

    const result = await provider(stub.fetch).exchangeCode({ code: 'replayed', redirectUri: 'https://thepit.show/cb' });
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toBe('github: bad_verification_code');
  });

  it('fails rather than returning an empty token when access_token is missing', async () => {
    const stub = stubFetch({ [GITHUB_TOKEN_ENDPOINT]: () => json({ scope: '', token_type: 'bearer' }) });
    const result = await provider(stub.fetch).exchangeCode({ code: 'c', redirectUri: 'https://thepit.show/cb' });
    expect(result.outcome === 'failed' && result.reason).toBe('token response carried no access_token');
  });

  it('returns a failure rather than throwing when the socket drops', async () => {
    // A thrown exception here is a 500 for a person who did nothing wrong.
    const result = await provider(() => Promise.reject(new Error('ECONNRESET'))).exchangeCode({
      code: 'c',
      redirectUri: 'https://thepit.show/cb',
    });
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toContain('ECONNRESET');
  });

  it('returns a failure rather than throwing when the body is not JSON', async () => {
    const stub = stubFetch({ [GITHUB_TOKEN_ENDPOINT]: () => new Response('<html>502</html>', { status: 502 }) });
    const result = await provider(stub.fetch).exchangeCode({ code: 'c', redirectUri: 'https://thepit.show/cb' });
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toContain('not JSON');
  });

  it('sends a code_verifier only when one is supplied', async () => {
    const stub = stubFetch({ [GITHUB_TOKEN_ENDPOINT]: () => json({ access_token: 'gho_token' }) });
    await provider(stub.fetch).exchangeCode({ code: 'c', redirectUri: 'https://thepit.show/cb' });
    expect(new URLSearchParams(String(stub.calls[0]?.init?.body)).has('code_verifier')).toBe(false);
  });
});

describe('the identity', () => {
  const userAndEmails = (user: unknown, emails: unknown): Record<string, () => Response> => ({
    [GITHUB_USER_ENDPOINT]: () => json(user),
    [GITHUB_EMAILS_ENDPOINT]: () => json(emails),
  });

  it('keys on the numeric id and never on the login', async () => {
    // A login is renameable, and a freed-up login can be registered by somebody
    // else — a link keyed on one hands the account to whoever claims the name.
    const stub = stubFetch(
      userAndEmails({ id: 583231, login: 'octocat' }, [{ email: 'octocat@github.com', primary: true, verified: true }]),
    );

    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    expect(result.outcome).toBe('identity');
    if (result.outcome !== 'identity') return;
    expect(result.identity.providerUserId).toBe('583231');
    expect(result.identity.login).toBe('octocat');
  });

  it('reads addresses from /user/emails and ignores the profile`s email field', async () => {
    // `user.email` is the PUBLIC profile field. It is null for most people and
    // can be an address they never verified.
    const stub = stubFetch(
      userAndEmails({ id: 1, login: 'x', email: 'public-but-unverified@example.com' }, [
        { email: 'real@example.com', primary: true, verified: true },
      ]),
    );

    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    expect(result.outcome).toBe('identity');
    if (result.outcome !== 'identity') return;
    expect(result.identity.emails.map((entry) => entry.email)).toEqual(['real@example.com']);
    expect(result.identity.emails.map((entry) => entry.email)).not.toContain('public-but-unverified@example.com');
  });

  it('carries the verified flag through faithfully, including false', async () => {
    const stub = stubFetch(
      userAndEmails({ id: 1, login: 'x' }, [
        { email: 'yes@example.com', primary: true, verified: true },
        { email: 'no@example.com', primary: false, verified: false },
      ]),
    );

    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    if (result.outcome !== 'identity') throw new Error('unreachable');
    expect(result.identity.emails).toEqual([
      { email: 'yes@example.com', verified: true, primary: true },
      { email: 'no@example.com', verified: false, primary: false },
    ]);
    // And the filter downstream keeps only the first.
    expect(verifiedProviderEmails(result.identity)).toEqual(['yes@example.com']);
  });

  it('treats a non-boolean verified as false', async () => {
    // GitHub sends a real boolean. A proxy, a mock, or a future change might
    // not, and `"false"` is truthy.
    const stub = stubFetch(
      userAndEmails({ id: 1 }, [{ email: 'sneaky@example.com', primary: true, verified: 'true' }]),
    );
    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    if (result.outcome !== 'identity') throw new Error('unreachable');
    expect(result.identity.emails[0]?.verified).toBe(false);
    expect(verifiedProviderEmails(result.identity)).toEqual([]);
  });

  it('sends the bearer token and a user agent, which GitHub requires', async () => {
    const stub = stubFetch(userAndEmails({ id: 1 }, []));
    await provider(stub.fetch).fetchIdentity('gho_token');

    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer gho_token');
    expect(headers['user-agent']).toBe('the-pit');
    expect(headers['accept']).toBe('application/vnd.github+json');
    expect(headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
  });

  it('fails when /user carries no usable id', async () => {
    const stub = stubFetch(userAndEmails({ login: 'no-id' }, []));
    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    expect(result.outcome === 'failed' && result.reason).toBe('/user carried no usable id');
  });

  it('fails when /user/emails is refused — the scope was not granted', async () => {
    const stub = stubFetch({
      [GITHUB_USER_ENDPOINT]: () => json({ id: 1, login: 'x' }),
      [GITHUB_EMAILS_ENDPOINT]: () => json({ message: 'Requires authentication' }, 403),
    });
    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toContain('HTTP 403');
  });

  it('skips malformed rows rather than failing the whole sign-in', async () => {
    const stub = stubFetch(
      userAndEmails({ id: 1 }, [
        null,
        'not-an-object',
        { primary: true, verified: true },
        { email: '', verified: true },
        { email: 'good@example.com', primary: true, verified: true },
      ]),
    );
    const result = await provider(stub.fetch).fetchIdentity('gho_token');
    if (result.outcome !== 'identity') throw new Error('unreachable');
    expect(result.identity.emails).toEqual([{ email: 'good@example.com', verified: true, primary: true }]);
  });
});
