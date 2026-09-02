/**
 * Where the auth handlers get their dependencies at runtime.
 *
 * ## The store is registered, and there is now something to register
 *
 * `@the-pit/auth` needs three methods — `findAccountByEmail`, `createToken`,
 * `consumeToken`. The Postgres implementation lives in `@the-pit/db`
 * (`src/auth-store.ts`), because every one of the three is a claim about a
 * table's shape and belongs where the schema tests can execute it against a real
 * Postgres. `@/lib/auth/store` memoizes one handle over it.
 *
 * The seam is unchanged: `registerAuthStore()` still takes precedence, which is
 * what lets a test install a `MemoryAuthStore` without an environment variable.
 * `resolveStore()` falls back to the Postgres store only when `DATABASE_URL` is
 * configured and nothing was registered — the deployment case, where requiring a
 * startup hook to name the single implementation that exists would fail at
 * runtime, in production, on the first sign-in. With no `DATABASE_URL` and no
 * registration it still throws `AuthNotWiredError`, which names the three
 * methods — a loud, specific failure rather than a silent fallback that would
 * let a broken deployment look healthy.
 *
 * `AUTH_DEV_MEMORY_STORE=1` swaps in `MemoryAuthStore` so the whole flow is
 * clickable locally with no database. It is refused in production, because a
 * memory store there means sessions that work until the next cold start and
 * tokens that vanish between the request and the click.
 *
 * ## The rate limiter is a process-local map, and that is a known gap
 *
 * `MemoryRateLimiter` is correct in one long-lived process. On Vercel every
 * invocation may be a fresh instance with an empty map, which makes the limit
 * per-instance rather than per-email — weaker than `brief §2.1` asks for. The
 * seam is the `RateLimiter` interface; the fix is Upstash Redis or a
 * `select count(*) from tokens where email = $1 and created_at > now() -
 * interval '15 minutes'`, which is what `tokens_email_idx` was indexed for. See
 * the Phase 4 report.
 *
 * That query now exists and is tested: `tokenRequestsInWindow` in `@the-pit/db`,
 * with a plan assertion that it is answered from `tokens_email_idx`. The
 * limiter itself is still `MemoryRateLimiter` — choosing between the shared
 * `tokens` count and Upstash is this file's decision, not the schema's, and
 * swapping it no longer also requires designing an index.
 */

import {
  GitHubOAuthProvider,
  MemoryAuthStore,
  MemoryRateLimiter,
  FixtureMailTransport,
  ResendMailTransport,
  assertUsableKeyring,
  systemTimingFloor,
  type AccountStore,
  type AuthStore,
  type HandoffStore,
  type IdentityStore,
  type MailTransport,
  type OAuthProvider,
  type SessionKeyring,
} from '@the-pit/auth';

import { hasDatabaseUrl } from '@the-pit/db';

import type { CapabilityHandlerDeps } from '@/lib/auth/capability-handlers';
import type { HandoffHandlerDeps } from '@/lib/auth/handoff-handlers';
import type { AuthHandlerDeps } from '@/lib/auth/handlers';
import type { OAuthHandlerDeps } from '@/lib/auth/oauth-handlers';
import { postgresAuthStore, postgresIdentityStore } from '@/lib/auth/store';

export class AuthNotWiredError extends Error {
  constructor() {
    super(
      'No AuthStore is registered. The identity schema owner must call registerAuthStore() with an ' +
        'implementation of findAccountByEmail / createToken / consumeToken (see @the-pit/auth AuthStore), ' +
        'or set AUTH_DEV_MEMORY_STORE=1 outside production.',
    );
    this.name = 'AuthNotWiredError';
  }
}

export class MissingSessionSecretError extends Error {
  constructor() {
    super('SESSION_SECRET is not set. The session cookie cannot be signed without it.');
    this.name = 'MissingSessionSecretError';
  }
}

let registeredStore: AuthStore | null = null;
let registeredIdentityStore: (IdentityStore & HandoffStore) | null = null;
let registeredProvider: OAuthProvider | null = null;
let limiter: MemoryRateLimiter | null = null;

/** Called once at startup by whoever owns the identity schema. */
export function registerAuthStore(store: AuthStore): void {
  registeredStore = store;
}

/**
 * The same seam for the capability and GitHub paths.
 *
 * Separate from `registerAuthStore` so a test can install a `MemoryAuthStore` —
 * which implements both — for one, the other, or both, and so the magic-link
 * path keeps a three-method surface it cannot reach past.
 */
export function registerIdentityStore(store: IdentityStore & HandoffStore): void {
  registeredIdentityStore = store;
}

/** Test and local-development escape hatch. */
export function resetAuthWiring(): void {
  registeredStore = null;
  registeredIdentityStore = null;
  limiter = null;
  registeredProvider = null;
}

function resolveStore(): AuthStore {
  if (registeredStore !== null) {
    return registeredStore;
  }
  if (process.env['AUTH_DEV_MEMORY_STORE'] === '1' && process.env['NODE_ENV'] !== 'production') {
    registeredStore = new MemoryAuthStore();
    return registeredStore;
  }
  if (hasDatabaseUrl()) {
    // The deployment path. Registered through the same slot an explicit
    // `registerAuthStore()` writes to, so the seam and its precedence are
    // unchanged and `resetAuthWiring()` still clears it.
    const store: AuthStore = postgresAuthStore();
    registeredStore = store;
    return store;
  }
  throw new AuthNotWiredError();
}

/**
 * Newest secret first. `SESSION_SECRET_PREVIOUS` is optional and exists so a
 * leaked key can be replaced without logging every customer out on the same
 * deploy — prepend the new one, ship, drop the old after 90 days.
 */
export function sessionKeyring(): SessionKeyring {
  const current = process.env['SESSION_SECRET'];
  if (current === undefined || current === '') {
    throw new MissingSessionSecretError();
  }
  const previous = process.env['SESSION_SECRET_PREVIOUS'];
  const keyring: SessionKeyring =
    previous === undefined || previous === '' ? [current] : [current, previous];
  assertUsableKeyring(keyring);
  return keyring;
}

/**
 * Resend when there is a key, the fixture transport when there is not.
 *
 * The fallback logs the magic link instead of sending it, which is what makes
 * the flow work locally. It is deliberately noisy about what it is doing: a
 * production deployment that silently stopped sending mail because a key went
 * missing is the failure this warning exists to make visible in the logs.
 */
export function mailTransport(): MailTransport {
  const apiKey = process.env['RESEND_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    console.warn('[auth] RESEND_API_KEY is not set — magic links are being logged, not sent.');
    return new FixtureMailTransport((message) => {
      console.info(`[auth] magic link for ${message.to}:\n${message.text}`);
    });
  }
  return new ResendMailTransport({ apiKey, fetch: (url, init) => fetch(url, init) });
}

/** `From:` on every message this app sends. One answer, so the three cannot drift. */
export function mailFrom(): string {
  return process.env['AUTH_MAIL_FROM'] ?? 'The Pit <no-reply@thepit.show>';
}

/** `https://thepit.show` in production; whatever `APP_ORIGIN` says elsewhere. */
export function appOrigin(): string {
  return process.env['APP_ORIGIN'] ?? 'https://thepit.show';
}

/**
 * `false` only when explicitly told, and never in production — a session cookie
 * without `Secure` is a session cookie an attacker on the network can read.
 */
export function secureCookies(): boolean {
  return !(process.env['AUTH_INSECURE_COOKIES'] === '1' && process.env['NODE_ENV'] !== 'production');
}

/**
 * The identity store, by the same precedence rules as `resolveStore`.
 *
 * `MemoryAuthStore` implements `AuthStore` AND `IdentityStore`, so the
 * development fallback is the same object — which is what makes all three paths
 * converge on one account locally, exactly as they do against Postgres.
 */
function resolveIdentityStore(): IdentityStore & HandoffStore {
  if (registeredIdentityStore !== null) {
    return registeredIdentityStore;
  }
  if (process.env['AUTH_DEV_MEMORY_STORE'] === '1' && process.env['NODE_ENV'] !== 'production') {
    // Share the one memory store, so a slug minted for an account seeded through
    // the magic-link path resolves here too.
    const shared = resolveStore();
    if (shared instanceof MemoryAuthStore) {
      registeredIdentityStore = shared;
      return shared;
    }
  }
  if (hasDatabaseUrl()) {
    const store = postgresIdentityStore();
    registeredIdentityStore = store;
    return store;
  }
  throw new AuthNotWiredError();
}

/**
 * GitHub, or nothing.
 *
 * `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` do not exist in this repository
 * and are not expected to. When they are absent this returns `null` and the
 * routes render "GitHub sign-in is not available" — a plain page rather than a
 * 500, because the other two paths are unaffected and the customer should be
 * told which door to use rather than shown a stack trace.
 */

/** Install a provider directly. Tests use the fixture; production uses env. */
export function registerOAuthProvider(provider: OAuthProvider): void {
  registeredProvider = provider;
}

export function githubProvider(): OAuthProvider | null {
  if (registeredProvider !== null) {
    return registeredProvider;
  }
  const clientId = process.env['GITHUB_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_CLIENT_SECRET'];
  if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') {
    return null;
  }
  return new GitHubOAuthProvider({ clientId, clientSecret, fetch: (url, init) => fetch(url, init) });
}

/**
 * An account's CURRENT capability slug, or `null`, by the same precedence as
 * every other resolver here.
 *
 * A one-method window onto `IdentityStore` for the callers that need the account
 * URL and nothing else — the delivery email is the only one today. Deliberately
 * not the store itself: `rotateCapabilitySlug` and `linkIdentity` have no
 * business on a path that sends mail.
 */
export function capabilitySlugFor(accountId: string): Promise<string | null> {
  return resolveIdentityStore().capabilitySlugFor(accountId);
}

/** The capability path's dependencies. */
export function capabilityDeps(): CapabilityHandlerDeps {
  limiter ??= new MemoryRateLimiter();
  return {
    origin: appOrigin(),
    capability: {
      store: resolveIdentityStore(),
      limiter,
      keyring: sessionKeyring(),
      secureCookies: secureCookies(),
      // `random` is deliberately not passed: the default is `CAPABILITY_CSPRNG`,
      // and every slug a customer is ever handed — rotated ones included — comes
      // from it. See `capability/slug.ts`.
    },
  };
}

/**
 * One object with both interfaces on it, by DELEGATION rather than by spreading.
 *
 * `{ ...auth, ...identity }` looks equivalent and is not: `MemoryAuthStore` and
 * the Postgres stores keep their methods on a prototype or close over a
 * connection, and a spread copies neither — it would produce an object whose
 * methods are missing or unbound, and the failure would be a `TypeError` in a
 * request path rather than a type error at build time.
 */
function composeAccountStore(auth: AuthStore, identity: IdentityStore): AccountStore {
  return {
    findAccountByEmail: (email) => auth.findAccountByEmail(email),
    createAccountForEmail: (input) => identity.createAccountForEmail(input),
    createToken: (token) => auth.createToken(token),
    consumeToken: (input) => auth.consumeToken(input),
    findAccountByCapabilitySlug: (slug) => identity.findAccountByCapabilitySlug(slug),
    capabilitySlugFor: (accountId) => identity.capabilitySlugFor(accountId),
    rotateCapabilitySlug: (input) => identity.rotateCapabilitySlug(input),
    findAccountByProviderIdentity: (input) => identity.findAccountByProviderIdentity(input),
    linkIdentity: (input) => identity.linkIdentity(input),
    identitiesFor: (accountId) => identity.identitiesFor(accountId),
  };
}

/**
 * The GitHub path's dependencies, or `null` when it is not configured.
 *
 * `store` needs BOTH interfaces here — `findAccountByEmail` to match a purchase
 * and the link methods to record one — so the two resolvers are intersected. In
 * every wiring that exists they are the same object.
 */
export function oauthDeps(): OAuthHandlerDeps | null {
  const provider = githubProvider();
  if (provider === null) {
    return null;
  }
  limiter ??= new MemoryRateLimiter();
  const store = composeAccountStore(resolveStore(), resolveIdentityStore());

  return {
    redirectUri: new URL('/auth/github/callback', appOrigin()).toString(),
    oauth: {
      provider,
      store,
      limiter,
      keyring: sessionKeyring(),
      secureCookies: secureCookies(),
    },
  };
}

/** The success page's dependencies. */
export function handoffDeps(): HandoffHandlerDeps {
  limiter ??= new MemoryRateLimiter();
  return {
    origin: appOrigin(),
    provider: process.env['PAYMENTS_PROVIDER'] ?? 'dodo',
    handoff: { store: resolveIdentityStore(), limiter },
  };
}

export function authDeps(): AuthHandlerDeps {
  const store = resolveStore();
  const keyring = sessionKeyring();
  limiter ??= new MemoryRateLimiter();
  const secure = secureCookies();

  return {
    keyring,
    secureCookies: secure,
    request: {
      store,
      limiter,
      mail: mailTransport(),
      mailFrom: mailFrom(),
      verifyUrl: new URL('/auth/verify', appOrigin()).toString(),
      // The response-time floor that closes the enumeration oracle an identical
      // body leaves open. See `@the-pit/auth`'s `timing.ts`.
      timingFloor: systemTimingFloor(),
    },
    verify: { store, limiter, keyring, secureCookies: secure },
  };
}
