/**
 * Where the webhook route gets its dependencies at runtime.
 *
 * Same seam and the same precedence as `lib/auth/config.ts`: an explicit
 * `registerDodoWebhookDeps()` wins, so a test installs in-memory stores with no
 * environment variable; otherwise the Postgres stores are resolved from
 * `DATABASE_URL`, and with neither the route throws a named error rather than
 * running with something silently inert.
 *
 * ## The secret has no default and never will
 *
 * `DODO_WEBHOOK_SECRET` missing is a hard failure at the first request, and that
 * is the correct behaviour: a webhook endpoint with an empty secret verifies
 * every body signed with an empty key, which is a body anyone can produce. There
 * is no development fallback, because the one that would be convenient here is
 * the one that would ship.
 *
 * ## Product ids beat the amount
 *
 * `tierForPayment` prefers a mapped Dodo product id and falls back to the amount.
 * Mapping them is optional and worth doing: a discount code changes the amount
 * and does not change what was sold, and an unmapped discounted $4 payment is
 * `needs_review` rather than an attempt. Unset, the amount alone still prices the
 * one tier exactly.
 */

import { mintCapabilitySlug } from '@the-pit/auth';
import {
  createDatabase,
  createPostgresAccountStore,
  createPostgresAttemptsStore,
  createPostgresSubmissionStore,
  createPostgresWebhookStore,
  hasDatabaseUrl,
  type Database,
  type PostgresAccountStore,
} from '@the-pit/db';
import { AttemptsLedger, seededCategoryClassifier, type DodoConfig, type PriceTierId } from '@the-pit/payments';

import { candidateCategories, listingLookup, submissionUrlResolver } from '@/lib/checkout/bindings';
import type { DodoWebhookDeps } from '@/lib/payments/webhook-handlers';
import type { PendingSubmission, PlacementEnqueueDeps, PlacementQueue } from '@/lib/payments/enqueue';
import { inngest, PLACEMENT_REQUESTED } from '@/lib/pipeline/inngest';
import { defaultBindings } from '@/lib/pipeline/service';

export class PaymentsNotWiredError extends Error {
  constructor(missing: string) {
    super(
      `The Dodo webhook cannot be served in this environment: ${missing}. ` +
        'Set it, or call registerDodoWebhookDeps() with an implementation ' +
        '(see @the-pit/payments WebhookStore and AttemptsStore).',
    );
    this.name = 'PaymentsNotWiredError';
  }
}

let registered: DodoWebhookDeps | null = null;
let handle: Database | null = null;
let accounts: PostgresAccountStore | null = null;

/** Install dependencies directly. Tests use this; production uses the environment. */
export function registerDodoWebhookDeps(deps: DodoWebhookDeps): void {
  registered = deps;
}

/** Drop everything this module memoized. Tests only. */
export function resetPaymentsWiring(): void {
  registered = null;
  handle = null;
  accounts = null;
}

/**
 * One pool for every store in this process, opened on first use.
 *
 * Module scope and not import time: `createDatabase()` reads `DATABASE_URL` and
 * `next build` imports server modules to trace them, so connecting at import
 * would turn a missing variable into a build failure. `max: 1` because Neon's
 * pooled endpoint multiplexes and a large per-lambda pool exhausts it — the same
 * reasoning, and the same number, as `lib/auth/store.ts`.
 */
function database(): Database {
  handle ??= createDatabase(undefined, 1).db;
  return handle;
}

/** The tier mapping, from whichever Dodo product ids this deployment was given. */
function productIds(): Record<string, PriceTierId> {
  const map: Record<string, PriceTierId> = {};
  const single = process.env['DODO_PRODUCT_SINGLE'];
  if (single !== undefined && single !== '') map[single] = 'single';
  return map;
}

export function dodoConfig(): DodoConfig {
  const webhookSecret = process.env['DODO_WEBHOOK_SECRET'];
  if (webhookSecret === undefined || webhookSecret === '') {
    throw new PaymentsNotWiredError('DODO_WEBHOOK_SECRET is not set');
  }

  const origin = process.env['APP_ORIGIN'] ?? 'https://thepit.show';
  return {
    // `live` only when something says so out loud. `createCheckoutSession`
    // refuses a live checkout without `acknowledgeLiveMode` for the same reason.
    mode: process.env['DODO_MODE'] === 'live' ? 'live' : 'test',
    webhookSecret,
    productIds: productIds(),
    returnUrl: new URL('/checkout/success', origin).toString(),
  };
}

/** `inngest.send`, as the one-method seam the enqueue site is written against. */
export function inngestPlacementQueue(): PlacementQueue {
  return {
    async send(event): Promise<void> {
      await inngest.send({ name: PLACEMENT_REQUESTED, data: event });
    },
  };
}

/**
 * The placement side of the webhook.
 *
 * `defaultBindings()` throws when the environment cannot be bound durably —
 * `service.ts` refuses a filesystem store in production, because a run whose
 * phases landed on two different lambdas re-buys a phase it already paid for. A
 * webhook that could not enqueue is still a webhook that must grant, so the
 * failure is caught here and turned into `null`: the money lands, and the missing
 * run reaches the review queue instead of vanishing.
 */
export function placementDeps(): PlacementEnqueueDeps | null {
  try {
    const db = database();
    const submissions = createPostgresSubmissionStore(db);
    return {
      categories: defaultBindings().categories,
      queue: inngestPlacementQueue(),
      submissions: {
        async find(submissionId: string): Promise<PendingSubmission | null> {
          return await submissions.find(submissionId);
        },
      },
      // `brief §2.4`'s authoritative check. The same three dependencies the
      // checkout route uses — one listing lookup, one classifier, one roster —
      // resolved from `lib/checkout/bindings.ts` rather than assembled a second
      // time, because two answers to "what is on the board at this URL" is how
      // the pre-payment and pre-enqueue checks start disagreeing.
      guards: {
        listings: listingLookup(db),
        // Held, not used: this path passes the key banked at checkout. See
        // `lib/checkout/bindings.ts`.
        resolveUrl: submissionUrlResolver,
        classifier: seededCategoryClassifier,
        candidateCategories,
      },
    };
  } catch (error) {
    console.error(`[dodo] no placement queue is available: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function dodoWebhookDeps(): DodoWebhookDeps {
  if (registered !== null) return registered;
  if (!hasDatabaseUrl()) throw new PaymentsNotWiredError('DATABASE_URL is not set');

  const db = database();

  return {
    config: dodoConfig(),
    // `mintCapabilitySlug` is passed in, not defaulted to the column's SQL
    // default: every slug a customer is handed comes from `CAPABILITY_CSPRNG`,
    // and the DEFAULT on `accounts.capability_slug` is a floor that exists so an
    // account can never be created without one.
    store: createPostgresWebhookStore(db, { mintSlug: mintCapabilitySlug }),
    ledgerFor: (rawBody: string) =>
      new AttemptsLedger(createPostgresAttemptsStore(db, { rawEvent: rawBody }), () => {
        // The delivery transaction belongs to the pipeline, not to the webhook.
        // A ledger built here that could consume would be a webhook that could
        // deliver a verdict, and `brief §2.3` puts the decrement inside the
        // transaction that writes one.
        throw new Error('the Dodo webhook may grant attempts and may never consume one (brief §2.3)');
      }),
    placement: placementDeps(),
  };
}

/** The reads behind `/account`, over the same connection. */
export function accountStore(): PostgresAccountStore {
  if (!hasDatabaseUrl()) throw new PaymentsNotWiredError('DATABASE_URL is not set');
  accounts ??= createPostgresAccountStore(database());
  return accounts;
}
