/**
 * Where the free-run handlers get their dependencies at runtime.
 *
 * The same seam and the same precedence as `lib/checkout/config.ts` and
 * `lib/payments/config.ts`: an explicit `registerFreeRunDeps()` wins, so a test
 * installs in-memory stores and a fixture transport with no environment
 * variable; otherwise everything is resolved from the environment, and with
 * nothing to resolve from the route throws a named error rather than running
 * with something silently inert.
 *
 * ## The two halves are resolved separately, and that is the guarantee
 *
 * `freeCreateDeps()` returns no ledger and no account store. `freeConfirmDeps()`
 * returns both. They are two functions rather than one object with everything on
 * it for the reason `lib/checkout/handlers.ts` gives about the checkout route
 * holding no `AttemptsLedger`: the absence of a dependency is a stronger
 * statement than a rule about not using it, and the form POST — which anybody on
 * the internet can reach, unauthenticated, as many times as they like — must not
 * be holding the one object in this application that can move an attempt.
 *
 * ## The bindings are borrowed, never rebuilt
 *
 * The guards come from `lib/checkout/bindings.ts` and the placement side from
 * `lib/payments/config.ts`'s `placementDeps()` — the same objects the paid path
 * uses. Two answers to "what is on the board at this URL" is exactly how the
 * pre-payment and pre-enqueue checks start disagreeing, and a free path with its
 * own copy of the guards would be a third.
 */

import { mintCapabilitySlug, type MailTransport } from '@the-pit/auth';
import {
  createDatabase,
  createPostgresFreeRunGrants,
  createPostgresAttemptsStore,
  createPostgresIdentityStore,
  createPostgresAuthStore,
  createPostgresSubmissionStore,
  hasDatabaseUrl,
  type Database,
} from '@the-pit/db';
import { seededCategoryClassifier } from '@the-pit/payments';

import { appOrigin, mailFrom, mailTransport, secureCookies, sessionKeyring } from '@/lib/auth/config';
import { candidateCategories, listingLookup, submissionUrlResolver } from '@/lib/checkout/bindings';
import type { FreeRunConfirmDeps, FreeRunCreateDeps } from '@/lib/free/handlers';
import { freeRunPolicy } from '@/lib/free/policy';
import { PaymentsNotWiredError, placementDeps } from '@/lib/payments/config';
import type { SubmissionGuardDeps } from '@/lib/checkout/guards';

/** Everything a test can install directly, in one object. */
export interface FreeRunDeps {
  readonly create: FreeRunCreateDeps;
  readonly confirm: FreeRunConfirmDeps;
}

let registered: FreeRunDeps | null = null;
let handle: Database | null = null;

/** Install dependencies directly. Tests use this; production uses the environment. */
export function registerFreeRunDeps(deps: FreeRunDeps): void {
  registered = deps;
}

/** Drop everything this module memoized. Tests only. */
export function resetFreeRunWiring(): void {
  registered = null;
  handle = null;
}

/** One pool per process, opened on first use. See `lib/payments/config.ts`. */
function database(): Database {
  handle ??= createDatabase(undefined, 1).db;
  return handle;
}

/** The guards, bound once — the same three the checkout route resolves. */
function guards(db: Database): SubmissionGuardDeps {
  return {
    listings: listingLookup(db),
    resolveUrl: submissionUrlResolver,
    classifier: seededCategoryClassifier,
    candidateCategories,
  };
}

/** The transport, and the address it sends from. Shared with the auth path. */
function mail(): { mail: MailTransport; mailFrom: string } {
  return { mail: mailTransport(), mailFrom: mailFrom() };
}

/**
 * How many proxies we control sit in front of this process.
 *
 * Read once, here, so the form POST and the confirm POST bucket a caller the same
 * way — a policy whose per-IP window saw two different addresses for one request
 * would be a window that never closes.
 */
function trustedProxyHops(): number | undefined {
  const raw = process.env['TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw === '') return undefined;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : undefined;
}

function withHops<T extends object>(deps: T): T & { trustedProxyHops?: number } {
  const hops = trustedProxyHops();
  return hops === undefined ? deps : { ...deps, trustedProxyHops: hops };
}

/** `POST /api/free`. Holds no ledger and no account store — see the header. */
export function freeCreateDeps(): FreeRunCreateDeps {
  if (registered !== null) return registered.create;
  if (!hasDatabaseUrl()) throw new PaymentsNotWiredError('DATABASE_URL is not set');

  const db = database();
  const submissions = createPostgresSubmissionStore(db);

  return withHops({
    submissions: { create: (draft) => submissions.create(draft) },
    guards: guards(db),
    policy: freeRunPolicy(),
    ...mail(),
    confirmUrl: new URL('/free/confirm', appOrigin()).toString(),
    keyring: sessionKeyring(),
  });
}

/** `POST /free/confirm`. The one place a free attempt can be granted. */
export function freeConfirmDeps(): FreeRunConfirmDeps {
  if (registered !== null) return registered.confirm;
  if (!hasDatabaseUrl()) throw new PaymentsNotWiredError('DATABASE_URL is not set');

  const db = database();
  const submissions = createPostgresSubmissionStore(db);
  const identities = createPostgresIdentityStore(db, { mintSlug: mintCapabilitySlug });
  const auth = createPostgresAuthStore(db);
  // No `rawEvent`: this store may only append an ADJUSTMENT, and
  // `createPostgresAttemptsStore` refuses a grant without the verified payload a
  // dispute is argued from. A free run has no payload, because it has no payment.
  const attempts = createPostgresAttemptsStore(db);
  const grants = createPostgresFreeRunGrants(db);

  return withHops({
    submissions: { find: (submissionId) => submissions.find(submissionId) },
    accounts: {
      findAccountByEmail: (email) => auth.findAccountByEmail(email),
      createAccountForEmail: (input) => identities.createAccountForEmail(input),
    },
    ledger: {
      append: (entry) => attempts.append(entry),
      holderOf: (key) => grants.holderOf(key),
    },
    policy: freeRunPolicy(),
    guards: guards(db),
    placement: placementDeps(),
    keyring: sessionKeyring(),
    secureCookies: secureCookies(),
  });
}
