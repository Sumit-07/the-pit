/**
 * The second persistence seam: capability slugs and provider links.
 *
 * `store.ts` has three methods and deliberately no `createAccount`, because
 * `brief §2.1` creates an account in exactly one place — the signed Dodo
 * webhook, from the email the provider verified. Nothing here changes that.
 * Every method below either READS an account that the webhook already made or
 * attaches something to it; none of them can bring one into existence.
 *
 * That is the property the whole design rests on, so it is worth stating as a
 * rule rather than as an accident of the current method list:
 *
 * > **An account is a purchase.** A row in `accounts` means someone paid. There
 * > is no signup, no invitation, and no "sign in with GitHub to get started".
 * > A GitHub identity with no matching purchase is a person we have never met,
 * > and the honest answer is to say so — not to open an empty account for them.
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

/** What `rotateCapabilitySlug` reports. There is no partial success. */
export type RotateSlugResult =
  | { readonly outcome: 'rotated' }
  /** No account with that id. Should be impossible behind a valid session; log it. */
  | { readonly outcome: 'unknown_account' };

export interface IdentityStore {
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
