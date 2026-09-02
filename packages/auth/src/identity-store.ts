/**
 * The second persistence seam: capability slugs and provider links.
 *
 * `store.ts` has three methods and deliberately no `createAccount`, because the
 * magic-link path must not be able to mint one. That is unchanged. What HAS
 * changed is the rule this file used to state, and `DECISIONS.md` S15 records the
 * change:
 *
 * > **An account is a purchase, OR a confirmed email with a free run.** A row in
 * > `accounts` means somebody paid $5, or somebody proved they hold an inbox and
 * > took the one free throw a product ever gets. There is still no signup, no
 * > invitation, and no "sign in with GitHub to get started".
 *
 * The second arm is `createAccountForEmail`, and it is deliberately on THIS
 * interface rather than on `AuthStore`. `verifyMagicLink` takes an `AuthStore`
 * with three methods and cannot reach past them, so redeeming a sign-in link for
 * an address nobody has ever confirmed still answers `no_account` — the arm below
 * is reachable only from the free-run confirm, which has verified a signature over
 * the address it is creating an account for.
 *
 * A GitHub identity with no matching account is still a person we have never met:
 * `completeOAuthSignIn` answers `no_purchase_found` and does not call the method
 * below, because a verified GitHub address is proof of a GitHub account and not of
 * anybody having thrown anything into the pit.
 *
 * ## Why the link table exists
 *
 * A GitHub sign-in could, in principle, match on the verified email every time
 * and store nothing. It would work until the customer changes their GitHub
 * email, at which point the match fails and their account is unreachable by that
 * path — orphaned by an edit they made on a different website. So the first
 * successful match is recorded as `(account_id, provider, provider_user_id,
 * linked_email)`, keyed on the provider's own immutable user id, and every later
 * sign-in resolves through the link rather than through the address.
 *
 * `linked_email` is kept for support and audit — "which address did this link
 * come in on" — and is refreshed on each sign-in. It is NOT the key, and
 * `linkIdentity` must never move `account_id` on an existing link: see the
 * method's own comment for what that would let an attacker do.
 *
 * ## Linking is not write-once-at-signup
 *
 * The link can be made in two directions, and both are needed:
 *
 * 1. **Sign-in.** No session yet; a verified provider email matches a payment
 *    email; the link is created as a side effect of that match.
 * 2. **Retroactive claim.** The customer paid as a guest on their phone, reached
 *    their account by capability URL, and only later connects GitHub — whose
 *    verified addresses need not include the one they paid with. Here the
 *    SESSION is the proof of account ownership and the OAuth round trip is the
 *    proof of provider ownership, so no email match is required or expected.
 *
 * Direction 2 is the mobile story. Guest checkout stays the default on every
 * device — `brief §2.1`'s "nothing sits between a visitor and their purchase" —
 * and GitHub is an upgrade applied whenever the customer feels like it. A seam
 * that could only link at first sign-in would quietly make GitHub a thing you
 * had to do *before* paying to get any benefit from, which is the funnel this
 * design exists to keep open.
 */

import type { AuthAccount } from './store.js';

/**
 * One provider identity, attached to one account.
 *
 * `providerUserId` is the provider's immutable id — GitHub's numeric `user.id`,
 * never the login. Logins are renameable, and a renamed login that someone else
 * then registers is an account takeover with no attack in it at all.
 */
export interface AccountIdentity {
  readonly accountId: string;
  /** `github` today. Lowercase, `[a-z][a-z0-9_]*` — the table CHECKs the shape. */
  readonly provider: string;
  readonly providerUserId: string;
  /** The verified provider address the link came in on. Normalized, lowercase. */
  readonly linkedEmail: string;
}

/**
 * What `createAccountForEmail` reports.
 *
 * `created` is the whole result. The free-run confirm is retried by a person
 * pressing a button twice and by every mail client that keeps a copy of the page,
 * so "the account is already there" is a SUCCESS and not an error — and the
 * caller needs to be able to tell the two apart for the log, never for the
 * response.
 */
export interface CreatedAccount {
  readonly accountId: string;
  readonly email: string;
  /** `false` when the address already had an account. Not a failure. */
  readonly created: boolean;
}

/** What `rotateCapabilitySlug` reports. There is no partial success. */
export type RotateSlugResult =
  | { readonly outcome: 'rotated' }
  /** No account with that id. Should be impossible behind a valid session; log it. */
  | { readonly outcome: 'unknown_account' };

export interface IdentityStore {
  /**
   * Find or create the account for a CONFIRMED address.
   *
   * The second way an account comes into existence, beside the signed Dodo
   * webhook's `ensureAccount`. `DECISIONS.md` S15 records why it exists: the free
   * first throw is keyed on the product URL and gated on a confirmed email, and a
   * flow that granted an attempt would have nowhere to put it without an account.
   *
   * **The confirmation is the caller's job and it is not optional.** This method
   * takes an address and makes it an account; it cannot tell a confirmed one from
   * a typed one. Exactly one caller may reach it — the free-run confirm POST,
   * after `verifyFreeRunToken` has checked our own signature over that address —
   * and every other path in the product resolves an account it did not create.
   *
   * Idempotent on the address, because the confirm button is pressable twice.
   */
  createAccountForEmail(input: {
    /** Normalized, lowercase. `accounts_email_lowercase` is the same rule in SQL. */
    readonly email: string;
    readonly now: Date;
  }): Promise<CreatedAccount>;

  /**
   * The account a capability slug resolves to, or `null`.
   *
   * Exact match on the stored slug — no prefix, no case folding, no trimming
   * beyond what the route already did. A lookup that normalized would accept
   * slugs the mint never produced and widen the guessing space for free.
   */
  findAccountByCapabilitySlug(slug: string): Promise<AuthAccount | null>;

  /** The current slug for an account, so the success page can show it. */
  capabilitySlugFor(accountId: string): Promise<string | null>;

  /**
   * Replace an account's slug, invalidating the old one.
   *
   * ONE column, overwritten. The old value is gone in the same statement that
   * writes the new one, so there is no window in which both resolve and no way
   * for a bug to leave two live slugs on one account. This is the only
   * revocation a bearer URL has; see `capability/slug.ts`.
   */
  rotateCapabilitySlug(input: {
    readonly accountId: string;
    readonly slug: string;
    readonly now: Date;
  }): Promise<RotateSlugResult>;

  /**
   * The account a provider identity is already linked to, or `null`.
   *
   * Checked BEFORE any email match, which is what makes a later GitHub email
   * change harmless: the link is keyed on the provider's user id, and the id
   * does not change when the address does.
   */
  findAccountByProviderIdentity(input: {
    readonly provider: string;
    readonly providerUserId: string;
  }): Promise<AuthAccount | null>;

  /**
   * Record the link, or refresh the address on one that already exists.
   *
   * Idempotent on `(provider, provider_user_id)`, which is UNIQUE. On conflict
   * it updates `linked_email` and NOTHING ELSE — in particular it must never
   * move `account_id`.
   *
   * That restriction is the whole security of the link table. If a conflicting
   * link could be repointed, then anyone who signed in with GitHub once could
   * later add a customer's address to their GitHub, verify it, sign in again,
   * and have their existing link silently transferred to the customer's account.
   * Refusing the move means the second sign-in resolves through the link to the
   * attacker's own account, which is the correct and boring outcome.
   */
  linkIdentity(input: AccountIdentity & { readonly now: Date }): Promise<void>;

  /** Every provider link on an account. For the account page and for support. */
  identitiesFor(accountId: string): Promise<readonly AccountIdentity[]>;
}

/**
 * The store the OAuth and capability flows want: account lookup by address,
 * plus the four methods above.
 *
 * Written as an intersection rather than by widening `AuthStore` so that the
 * magic-link path keeps its three-method surface exactly as `brief §2.1` left
 * it — `verifyMagicLink` still cannot reach a capability slug, and nothing in
 * this file is reachable from the token flow.
 */
export type AccountStore = import('./store.js').AuthStore & IdentityStore;

/** Re-exported so callers of this module do not need two imports. */
export type { AuthAccount };
