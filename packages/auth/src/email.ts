/**
 * The address is the account key, so normalizing it is an identity decision
 * rather than a formatting one.
 *
 * `brief §2.1`: "Dodo supplies a verified email with the payment, so a magic
 * link to that address matches the payer with no extra identity system." There
 * is no username, no provider id, no second factor — the string this module
 * returns IS the account. Two functions that disagree about what "the same
 * address" means would let a magic link reach an account the buyer does not own.
 *
 * ## What is normalized, and what is deliberately not
 *
 * Trim, then lowercase. That is all.
 *
 * `packages/db`'s `tokens` table carries `check (email = lower(email))`, so
 * lowercasing is not a preference — a row with a capital in it is rejected by
 * Postgres. The domain half is case-insensitive by RFC 1035 and every mail
 * provider in existence treats the local half that way too, so folding case is
 * safe and is what makes "Alice@Example.com" on the Dodo receipt find the
 * account created for "alice@example.com".
 *
 * What is NOT done, and must not be added later:
 *
 * - **No Gmail dot-stripping.** `a.b@gmail.com` and `ab@gmail.com` are the same
 *   Gmail inbox but are *different addresses* at most other hosts, and this
 *   function cannot tell which host it is looking at without a provider table
 *   that goes stale. Collapsing them would merge two paying customers into one
 *   account. The failure is silent and unrecoverable, and the thing it buys is
 *   nothing: the payer's receipt carries whichever form they typed, and a magic
 *   link sent to that form arrives.
 * - **No `+tag` stripping.** Same reasoning, and `+` tags are how people
 *   deliberately keep separate accounts.
 * - **No Unicode normalization or IDN punycoding.** The address is compared
 *   against what Dodo stored, byte for byte, after case folding. Introducing a
 *   second transformation on one side of that comparison is how the two sides
 *   stop matching.
 */

/** RFC 5321 caps the whole path at 256 octets including the angle brackets. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Fold an address to its canonical stored form.
 *
 * Total, and never throws: callers pair it with `isPlausibleEmail` when they
 * need a verdict on shape. Keeping the two separate is what lets the request
 * route normalize first and then rate-limit on the normalized key, so
 * `A@x.com` and `a@x.com` share one bucket instead of two.
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * A syntactic shape check, not a deliverability check.
 *
 * Deliberately loose. The only thing that proves an address exists is a message
 * arriving at it, which is the entire mechanism this package implements; a
 * stricter regex here buys nothing and rejects real addresses (the RFC 5322
 * grammar admits quoted local parts, and every "correct" email regex on the
 * internet is either wrong or a page long).
 *
 * What it does reject is input that cannot be an address at all — empty, no `@`,
 * an unqualified domain, embedded whitespace, control characters, or something
 * long enough to be an attack on a `text` column. A header-injection attempt
 * (`a@b.com\nBcc: victim@x.com`) fails on the whitespace rule, which matters
 * because this string reaches a mail transport.
 *
 * Note the asymmetry with `brief §2.1`'s no-enumeration rule: rejecting a
 * MALFORMED address leaks nothing, because the caller can determine syntax
 * without asking us. Only the known-account / unknown-account distinction has to
 * be hidden, and that is `requestMagicLink`'s job.
 */
export function isPlausibleEmail(input: string): boolean {
  if (input.length === 0 || input.length > MAX_EMAIL_LENGTH) {
    return false;
  }
  // One `@`, something either side, a dotted domain, and none of the characters
  // that would let the string escape a mail header or an address list. `\s`
  // covers CR and LF, which is the header-injection guard.
  return /^[^\s@,;:<>"\\]+@[^\s@.,;:<>"\\]+(\.[^\s@.,;:<>"\\]+)+$/.test(input);
}
