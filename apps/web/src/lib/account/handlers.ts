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

export interface AccountHandlerDeps {
  readonly keyring: SessionKeyring;
  /** `false` only on `http://localhost`; see `@the-pit/auth`'s cookie module. */
  readonly secureCookies?: boolean;
  /** Absolute origin, for the capability URL the page displays. */
  readonly origin: string;
  readonly reads: AccountReads;
  readonly identities: IdentityStore;
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

  const view = await loadAccountView(verified.session, {
    reads: deps.reads,
    identities: deps.identities,
    origin: deps.origin,
  });

  return html(renderAccountPage(view), 200);
}
