/**
 * The security boundary of the whole GitHub path, in one function.
 *
 * ## The attack this closes
 *
 * `GET /user/emails` returns every address on a GitHub account, and anyone can
 * ADD any address to their own GitHub account without proving anything. The
 * address sits there with `"verified": false` until a confirmation link is
 * clicked. Both kinds come back in the same array, in no particular order, and
 * they look identical apart from one boolean.
 *
 * So if a sign-in matched a purchase on any address in that array:
 *
 *   1. Attacker reads a customer's address off their website or their listing.
 *   2. Attacker adds it to their own GitHub account. No confirmation needed to
 *      add it — only to verify it, which they never do.
 *   3. Attacker signs in with GitHub. The unverified address matches the payment
 *      email.
 *   4. Attacker now holds the customer's attempt balance, their history, and the
 *      ability to re-pitch — which means editing the listing the customer paid
 *      for.
 *
 * The entire cost of that attack is typing an address into a settings page. It
 * is not a subtle bug; it is the default behaviour of any implementation that
 * reads `emails.map(e => e.email)`, which is what most of them do.
 *
 * ## Why this is a separate module
 *
 * Because it has to be impossible to skip by accident. `signInWithProvider` does
 * not touch `identity.emails`; it calls this function and matches on what comes
 * back. A future edit that wanted to match on an unverified address would have
 * to delete a call to a function named `verifiedProviderEmails` and reach past
 * it into the raw list, which is a deliberate act that a reviewer will see —
 * rather than a missing `.filter()` nobody notices.
 *
 * `test/oauth-sign-in.test.ts` asserts the consequence from the outside: with an
 * account seeded for an address, and a provider returning that address as
 * UNVERIFIED, the store's call log shows `findAccountByEmail` was never called
 * with it. Removing the filter fails on both the outcome and the call log.
 *
 * ## What else it does, and why each is not optional
 *
 * - **Normalizes.** `accounts.email` is lowercase and the column CHECKs it, so a
 *   provider returning `Payer@Example.com` must be folded before it can match.
 *   Unfolded, the customer who paid simply is not found and the honest-looking
 *   answer is "no purchase for that address" — a silent failure that reads as a
 *   product bug rather than a code one.
 * - **Re-validates the shape.** The addresses arrive from a third party over the
 *   network. `isPlausibleEmail` is the same gate the magic-link path applies, and
 *   it rejects whitespace and control characters, which is what stops a hostile
 *   provider response from reaching a mail header or a log line intact.
 * - **De-duplicates.** GitHub can list the same address twice across
 *   visibilities. Two identical candidates means two identical store lookups, and
 *   the second is pure cost.
 * - **Orders primary first.** Deterministic candidate order, so which account a
 *   multi-address identity resolves to is a property of the data rather than of
 *   the order GitHub happened to serialize its JSON in.
 */

import { isPlausibleEmail, normalizeEmail } from '../email.js';
import type { ProviderEmail, ProviderIdentity } from './types.js';

/**
 * The addresses a purchase may be matched against: verified, normalized,
 * plausible, unique, primary first.
 *
 * Returns strings rather than `ProviderEmail`s on purpose. Once past this
 * function `verified` is universally true and `primary` has no further meaning,
 * and a caller holding the richer type is a caller that can re-derive the wrong
 * answer from it.
 */
export function verifiedProviderEmails(identity: ProviderIdentity): readonly string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  // Primary first, then declaration order — a stable sort over one boolean.
  const ordered = [...identity.emails].sort(byPrimaryFirst);

  for (const entry of ordered) {
    // The one comparison that matters. `=== true` rather than truthiness: a
    // provider that sent `"verified": "false"` — a string, which is truthy —
    // would otherwise pass, and JSON from a third party is exactly where a
    // stringly-typed boolean shows up.
    if (entry.verified !== true) {
      continue;
    }
    const email = normalizeEmail(entry.email);
    if (!isPlausibleEmail(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    candidates.push(email);
  }

  return candidates;
}

/**
 * Every address the provider returned that was NOT usable, normalized the same
 * way.
 *
 * For the "no purchase found" page and for logs — being able to say "we looked
 * at these and none of them had bought anything" is the difference between a
 * customer who understands what happened and one who files a ticket. It is
 * never matched against anything, and it is deliberately a different function
 * with a different name so that no caller can confuse the two lists.
 */
export function unverifiedProviderEmails(identity: ProviderIdentity): readonly string[] {
  const seen = new Set<string>();
  const rejected: string[] = [];

  for (const entry of identity.emails) {
    if (entry.verified === true) {
      continue;
    }
    const email = normalizeEmail(entry.email);
    if (!isPlausibleEmail(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    rejected.push(email);
  }

  return rejected;
}

function byPrimaryFirst(a: ProviderEmail, b: ProviderEmail): number {
  return Number(b.primary) - Number(a.primary);
}
