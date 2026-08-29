/**
 * What this deployment binds for the settle — and the one binding that must never
 * be chosen by accident.
 *
 * Same shape and the same precedence as `lib/payments/config.ts` and
 * `lib/verdict/service.ts`: an explicit `registerDeliveryBindings()` wins, so a
 * test installs an in-memory ledger with no environment variable; otherwise the
 * Postgres stores are resolved from `DATABASE_URL`; with neither, the settle
 * reports `not_settleable` rather than running against something silently inert.
 *
 * ## `null` is a real answer, not a fallback
 *
 * `bindings()` returns `null` when there is no database, and `settleDelivery`
 * turns that into a named result the caller logs and parks. That is the correct
 * behaviour for the two environments that legitimately reach it — `next build`
 * tracing server modules with no connection string, and a local run against
 * `cjr/` with no `jobs` table — and it is the only safe behaviour on the money
 * path, because the alternatives are a connection error thrown after a board was
 * published, or a settle against a store that quietly holds nothing.
 *
 * There is no in-memory fallback for production. A ledger that forgot what it
 * spent is worse than one that refuses to spend.
 */

import {
  createDatabase,
  createPostgresDeliveryStore,
  hasDatabaseUrl,
  type Database,
  type PostgresDeliveryStore,
} from '@the-pit/db';
import { AttemptsLedger } from '@the-pit/payments';

import type { DeliveryBindings } from './settle';

let registered: DeliveryBindings | null | undefined;
let handle: Database | null = null;
let store: PostgresDeliveryStore | null = null;

/** Install bindings directly. Tests use this; production uses the environment. */
export function registerDeliveryBindings(bindings: DeliveryBindings | null): void {
  registered = bindings;
}

/** Drop everything this module memoized. Tests only. */
export function resetDeliveryBindings(): void {
  registered = undefined;
  handle = null;
  store = null;
}

/**
 * One connection per process, opened on first use.
 *
 * Module scope and not import time, for the reason `lib/pipeline/service.ts` and
 * `lib/payments/config.ts` both give: `next build` imports server modules to
 * trace them, so connecting at import turns a missing variable into a build
 * failure and a present one into an idle connection per cold start. `max: 1`
 * because Neon's pooled endpoint multiplexes.
 */
function database(): Database {
  handle ??= createDatabase(undefined, 1).db;
  return handle;
}

function deliveryStore(): PostgresDeliveryStore {
  store ??= createPostgresDeliveryStore(database());
  return store;
}

/**
 * The delivery bindings for this environment, or `null`.
 *
 * The `AttemptsStore` handed to the ledger has a `balance` and an `append` that
 * THROWS. That is deliberate and mirrors `lib/payments/config.ts` doing it the
 * other way round: the webhook's ledger may grant and may never consume, and this
 * one may consume and may never grant. A grant reaching this path would be an
 * attempt created outside a signed webhook (`brief §2.2`), so it fails loudly
 * rather than being written. The consume itself never goes through `append` at
 * all — `AttemptsLedger.deliver` routes it through `DeliveryTx.appendAttemptEntry`
 * inside the transaction, which is the whole point of `brief §2.3`'s "same
 * transaction" clause.
 */
export function deliveryBindings(): DeliveryBindings | null {
  if (registered !== undefined) return registered;
  if (!hasDatabaseUrl()) return null;

  const delivery = deliveryStore();

  return {
    findListing: (input) => delivery.findListing(input),
    ledgerFor: (input) =>
      new AttemptsLedger(
        {
          append: () => {
            throw new Error(
              'the delivery path may consume an attempt and may never grant one (brief §2.2: attempts ' +
                'appear on a signed webhook and nowhere else). A consume goes through DeliveryTx, inside ' +
                'the transaction that writes the verdict.',
            );
          },
          balance: (accountId: string) => delivery.balance(accountId),
        },
        delivery.withDeliveryTx({
          accountId: input.accountId,
          publicSlug: input.publicSlug,
          productCount: input.productCount,
        }),
      ),
  };
}
