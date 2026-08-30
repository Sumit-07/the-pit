/**
 * Where the checkout route gets its dependencies at runtime.
 *
 * Same seam and the same precedence as `lib/auth/config.ts` and
 * `lib/payments/config.ts`: an explicit `registerCheckoutDeps()` wins, so a test
 * installs in-memory stores and a fixture transport with no environment
 * variable; otherwise everything is resolved from the environment, and with
 * nothing to resolve from the route throws a named error rather than running
 * with something silently inert.
 *
 * ## The transport is chosen, never defaulted into production
 *
 * `HttpDodoTransport` needs `DODO_API_KEY`. Without one:
 *
 * - **outside production** we fall back to `FixtureDodoTransport` and say so on
 *   stderr, because the whole point of that class living in `src` rather than in
 *   `test` is that the purchase flow is clickable locally with no Dodo account;
 * - **in production** we refuse. A production deployment that quietly handed
 *   buyers `https://test.checkout.dodopayments.com/...` would be a checkout that
 *   takes no money and looks like it works, which is the worst of the available
 *   failures.
 *
 * The same rule `lib/auth/config.ts` applies to `AUTH_DEV_MEMORY_STORE`, for the
 * same reason: the convenient fallback is the one that ships if it is allowed to.
 *
 * ## The guards' own inputs live in `bindings.ts`
 *
 * `listingLookup` and `candidateCategories` are shared with
 * `lib/payments/config.ts`, which binds the same guards to the pre-enqueue check.
 * They sit in a third module so both configs point at one answer — and so neither
 * config has to import the other.
 */

import {
  createDatabase,
  createPostgresSubmissionStore,
  hasDatabaseUrl,
  type Database,
} from '@the-pit/db';
import { FixtureDodoTransport, seededCategoryClassifier, type DodoTransport } from '@the-pit/payments';

import { capabilityDeps, secureCookies, sessionKeyring } from '@/lib/auth/config';
import { candidateCategories, listingLookup, submissionUrlResolver } from '@/lib/checkout/bindings';
import { submitPageDepsFrom, type CheckoutHandlerDeps, type SubmitPageDeps } from '@/lib/checkout/handlers';
import { HttpDodoTransport } from '@/lib/checkout/transport';
import { dodoConfig, PaymentsNotWiredError } from '@/lib/payments/config';

let registered: CheckoutHandlerDeps | null = null;
let handle: Database | null = null;
let transport: DodoTransport | null = null;

/** Install dependencies directly. Tests use this; production uses the environment. */
export function registerCheckoutDeps(deps: CheckoutHandlerDeps): void {
  registered = deps;
}

/** Drop everything this module memoized. Tests only. */
export function resetCheckoutWiring(): void {
  registered = null;
  handle = null;
  transport = null;
}

/** One pool per process, opened on first use. See `lib/payments/config.ts`. */
function database(): Database {
  handle ??= createDatabase(undefined, 1).db;
  return handle;
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * The Dodo client. Real when there is a key, a fixture when there is not and we
 * are not in production, and an error otherwise.
 */
export function dodoTransport(): DodoTransport {
  if (transport !== null) return transport;

  const apiKey = process.env['DODO_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    if (isProduction()) {
      throw new PaymentsNotWiredError('DODO_API_KEY is not set');
    }
    console.warn(
      '[checkout] DODO_API_KEY is not set — opening FIXTURE checkout sessions. ' +
        'No money will move and the payment link goes nowhere real.',
    );
    transport = new FixtureDodoTransport();
    return transport;
  }

  transport = new HttpDodoTransport({ apiKey, mode: dodoConfig().mode });
  return transport;
}

/**
 * The session keyring, or nothing, for a page that is not gated on one.
 *
 * `sessionKeyring()` throws when `SESSION_SECRET` is unset, and on `/submit`
 * that is not an error: with no secret nobody can hold a valid session, which is
 * precisely the guest checkout `brief §2.1` specifies. Swallowed here rather
 * than in `submitterAccountId`, so the handler keeps taking a keyring it can
 * trust and the "is this an error?" judgement is made once, at the seam that
 * knows which page is asking.
 *
 * `POST /api/checkout` does NOT go through this. It resolves its keyring from
 * `capabilityDeps()` below, and a broken one there still throws.
 */
function optionalKeyring(): Pick<SubmitPageDeps, 'keyring' | 'secureCookies'> {
  try {
    return { keyring: sessionKeyring(), secureCookies: secureCookies() };
  } catch {
    return {};
  }
}

/**
 * `GET /submit` — resolved from NOTHING.
 *
 * No `hasDatabaseUrl()` check, no `database()`, no `dodoConfig()`, no
 * `dodoTransport()`. The form is a static document and the category roster is
 * read from the snapshot sink, so the correct number of environment variables
 * required to render the page that takes someone's money is zero. `/boards` was
 * moved off the database for exactly this reason; this is the same fault on the
 * highest-value read path in the product.
 *
 * `registerCheckoutDeps()` still wins, so a test that installed a full set of
 * checkout dependencies sees the roster it installed rather than the real one.
 *
 * None of this weakens `PaymentsNotWiredError`: `checkoutDeps()` below is
 * unchanged and still throws on a missing `DATABASE_URL` at the first `POST`,
 * and `instrumentation.ts` still fails the boot on an unbindable pipeline. The
 * only thing that moved is which requests have to pay for that wiring.
 */
export function submitPageDeps(): SubmitPageDeps {
  if (registered !== null) return submitPageDepsFrom(registered);
  return { candidateCategories, ...optionalKeyring() };
}

export function checkoutDeps(): CheckoutHandlerDeps {
  if (registered !== null) return registered;
  if (!hasDatabaseUrl()) throw new PaymentsNotWiredError('DATABASE_URL is not set');

  const db = database();
  const submissions = createPostgresSubmissionStore(db);

  return {
    config: dodoConfig(),
    transport: dodoTransport(),
    submissions: {
      create: (draft) => submissions.create(draft),
    },
    guards: {
      listings: listingLookup(db),
      // `brief §2.5`: the URL a visitor typed becomes the cap key only after it
      // has been followed to where it points.
      resolveUrl: submissionUrlResolver,
      // `DECISIONS.md` S12's classifier. Nearest centroid over the 1028 labelled
      // products, not a model call: this runs pre-payment on an unauthenticated
      // route, so it must cost nothing to invoke and must not need a key.
      classifier: seededCategoryClassifier,
      candidateCategories,
    },
    // Read only to upgrade an ownership conflict from a post-payment hold to a
    // pre-payment refusal. It gates nothing — see `handlers.ts`.
    keyring: capabilityDeps().capability.keyring,
    secureCookies: capabilityDeps().capability.secureCookies,
  };
}
