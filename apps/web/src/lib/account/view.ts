/**
 * What `/account` is allowed to know, and where it gets it.
 *
 * `brief §2.1` draws the line in one sentence — "verdict URLs are public;
 * attempt balance and history are behind the session" — and this module is the
 * private half. Every function here takes an account id, and an account id comes
 * from a signed session cookie and from nowhere else: there is no lookup by
 * email, no lookup by slug, and nothing that takes a query parameter.
 *
 * ## Two stores, because they answer to two different owners
 *
 * `AccountReads` is the money and the listings, implemented over `orders`,
 * `attempts` and `products` in `@the-pit/db`. `IdentityStore` is the capability
 * slug and the provider links, and it is the same interface the three sign-in
 * paths already use — the page reads it rather than growing a second one, so
 * "which slug is live" has one answer on the page and in `/a/<slug>`.
 *
 * ## The capability URL is assembled, never stored assembled
 *
 * `capabilityUrl(origin, slug)` is `@the-pit/auth`'s, so the URL the page shows
 * is built by the same function that builds the one on the success page and the
 * one a rotation hands back. A page that concatenated its own would be a third
 * spelling of a bearer credential, and the day the path changes two of them move.
 */

import { capabilityUrl, type AccountIdentity, type IdentityStore, type SessionPayload } from '@the-pit/auth';

/** One purchase. Mirrors `AccountPurchaseRow` in `@the-pit/db`. */
export interface AccountPurchase {
  readonly orderId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly attemptsGranted: number;
  readonly includesFitReport: boolean;
  readonly createdAt: Date;
}

/** One listing, with the verdict it currently points at. Mirrors `AccountListingRow`. */
export interface AccountListing {
  readonly productId: string;
  readonly name: string;
  readonly url: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly verdictSlug: string | null;
  readonly attemptNumber: number | null;
  readonly deliveredAt: Date | null;
}

/** The three private reads. Satisfied by `createPostgresAccountStore`, and in memory by tests. */
export interface AccountReads {
  balance(accountId: string): Promise<number>;
  purchases(accountId: string): Promise<readonly AccountPurchase[]>;
  listings(accountId: string): Promise<readonly AccountListing[]>;
}

/** The GitHub state, as the page needs to render it. */
export type GitHubState =
  | { readonly linked: true; readonly identities: readonly AccountIdentity[] }
  | { readonly linked: false };

export interface AccountView {
  readonly accountId: string;
  readonly email: string;
  readonly balance: number;
  readonly purchases: readonly AccountPurchase[];
  readonly listings: readonly AccountListing[];
  /**
   * Null when the account somehow has no slug.
   *
   * `accounts.capability_slug` is NOT NULL with a CSPRNG default precisely so
   * this cannot happen, and the page still handles it: an account page that threw
   * would take away the balance and the history too, over a URL the customer may
   * not even use.
   */
  readonly capabilityUrl: string | null;
  readonly github: GitHubState;
}

export interface AccountViewDeps {
  readonly reads: AccountReads;
  readonly identities: IdentityStore;
  /** Absolute origin, for the capability URL. */
  readonly origin: string;
}

/**
 * Everything the page renders, for one session.
 *
 * The five reads are fired together. They are independent, none of them writes,
 * and the page cannot render until all five land — so serializing them would only
 * add four round trips to a surface that is already behind a login and therefore
 * already the slowest thing a customer sees.
 */
export async function loadAccountView(
  session: SessionPayload,
  deps: AccountViewDeps,
): Promise<AccountView> {
  const [balance, purchases, listings, slug, identities] = await Promise.all([
    deps.reads.balance(session.accountId),
    deps.reads.purchases(session.accountId),
    deps.reads.listings(session.accountId),
    deps.identities.capabilitySlugFor(session.accountId),
    deps.identities.identitiesFor(session.accountId),
  ]);

  const github: GitHubState =
    identities.length === 0 ? { linked: false } : { linked: true, identities };

  return {
    accountId: session.accountId,
    email: session.email,
    balance,
    purchases,
    listings,
    capabilityUrl: slug === null ? null : capabilityUrl(deps.origin, slug),
    github,
  };
}
