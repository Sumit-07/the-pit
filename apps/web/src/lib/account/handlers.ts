/**
 * `GET /account` — the private surface, as a pure function of a `Request`.
 *
 * ## The gate is first, and the stores come after it
 *
 * `readSession` runs before any dependency is touched. That ordering is the
 * security property and it is deliberately structural rather than remembered: on
 * the signed-out path this handler has not called `reads.balance`,
 * `reads.purchases`, `reads.listings` or `capabilitySlugFor`, so there is no
 * version of the signed-out page that holds the data and declines to print it.
 * `test/account-page.test.ts` asserts it from the outside, by giving the handler
 * a store that records every call and checking the log is empty.
 *
 * `brief §2.1`: "Attempt balance and history are behind the session. Verdict URLs
 * are public." This is the first surface where both halves of that sentence are
 * true at once — the page is gated, and the verdict links on it are bare.
 *
 * ## 401 and not a redirect
 *
 * A redirect to `/auth/sign-in` would be shorter and would lose the explanation.
 * Someone arriving here with an expired cookie needs to be told which doors
 * exist — in particular that the account link from their receipt still works when
 * email does not, which is the case the capability URL was added for. The status
 * is 401 so a script can tell the difference; the body is a page so a person can.
 */

import { readSession, type IdentityStore, type SessionKeyring } from '@the-pit/auth';

import { renderAccountPage, renderSignedOutPage } from '@/lib/account/page';
import { loadAccountView, type AccountReads } from '@/lib/account/view';

/**
 * The stores the SIGNED-IN page reads, and only it.
 *
 * Every one of these is backed by Postgres in a deployment, and none of them is
 * touched on the signed-out path — so they are resolved behind `stores()` below
 * rather than handed in already open.
 */
export interface AccountStores {
  /** Absolute origin, for the capability URL the page displays. */
  readonly origin: string;
  readonly reads: AccountReads;
  readonly identities: IdentityStore;
}

export interface AccountHandlerDeps {
  readonly keyring: SessionKeyring;
  /** `false` only on `http://localhost`; see `@the-pit/auth`'s cookie module. */
  readonly secureCookies?: boolean;
  /**
   * The stores, resolved only once a session has verified — a THUNK, and that is
   * the whole point.
   *
   * The module header already promised that the signed-out path touches no
   * store. It was true of the handler and false of the route: `accountDeps()`
   * called `capabilityDeps()` and `accountStore()` eagerly, both of which throw
   * without a `DATABASE_URL`, so a logged-out visitor to a deployment with no
   * database got a 500 instead of the 401 page that tells them which doors
   * exist. Rendering the signed-out state is a function of a cookie and nothing
   * else, and now the type says so: on that path this function is never called,
   * so there is no handle to fail to open.
   *
   * It is a deferral and not a weakening. `accountStore()` still throws
   * `PaymentsNotWiredError` on the first signed-in render, which is the first
   * request that actually needs a row — a signed-in page that showed an empty
   * balance because a store was missing would be indistinguishable, to the
   * customer, from a balance of zero.
   */
  readonly stores: () => AccountStores;
}

/**
 * `no-store` is the important one: this page renders a bearer URL in its body,
 * and a CDN or a shared browser cache holding it is the next person's account.
 * `no-referrer` for the same reason — a font request would otherwise carry this
 * page's URL to a third party, and the page after a rotation is one press from
 * carrying the credential itself.
 */
const ACCOUNT_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-type': 'text/html; charset=utf-8',
};

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { ...ACCOUNT_HEADERS } });
}

export async function handleAccountPage(request: Request, deps: AccountHandlerDeps): Promise<Response> {
  const options = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const verified = readSession({
    cookieHeader: request.headers.get('cookie'),
    keyring: deps.keyring,
    now: new Date(),
    ...options,
  });

  if (!verified.valid) {
    // Nothing has been read. One page for an absent cookie, an expired one and a
    // tampered one alike — `verified.reason` is a log field, and rendering it
    // would tell someone holding a forged cookie how close they got.
    return html(renderSignedOutPage(), 401);
  }

  // Past the gate, and only past it: this is the first line in the function that
  // can open a database handle.
  const stores = deps.stores();
  const view = await loadAccountView(verified.session, {
    reads: stores.reads,
    identities: stores.identities,
    origin: stores.origin,
  });

  return html(renderAccountPage(view), 200);
}
