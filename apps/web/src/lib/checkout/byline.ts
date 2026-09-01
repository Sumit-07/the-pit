/**
 * The byline: whether a listing is published under its name or as a robot.
 *
 * ## One decision, made once, in ignorance of the result
 *
 * `products.anonymous` has been the source of truth since
 * `0009_anonymous_listings.sql`, and `products_anonymity_immutable` has frozen it
 * since the same migration. What neither had was a customer. Every paid row was
 * written `false` because nothing on the buying path carried a value, so the
 * trigger was guarding a choice nobody had been offered and the seeded board was
 * the only anonymous thing in the product.
 *
 * This module is the wire format of that choice, and it exists as its own file
 * for the same reason `pitch.ts` does: the form, the route and the tests all have
 * to agree on what "yes" looks like, and three copies of that agreement is how
 * they stop agreeing.
 *
 * ## Why it is chosen at submission, and why that is not negotiable
 *
 * The founder's rule is that the choice is made before scoring and cannot be
 * undone. `brief §2.4`'s never-keep-the-best argument is the fairness half: if
 * someone could go anonymous AFTER reading a verdict, the good scores would stay
 * named and the bad ones would hide, and the named half of every board would
 * drift toward the flattering until a name stopped being evidence of anything.
 * Buying an anonymous read up front has no selection effect at all, because the
 * buyer does not yet know what they are hiding.
 *
 * The mechanical half is stronger still, and it is in `lib/pipeline/pg-catalog.ts`:
 * an anonymous listing is marshalled into the engine already wearing its
 * designation, because a juror who is shown a real name can write that name into
 * a reason, and a reason is free text that is published in full. There is no
 * filter that takes a name back out of prose about the thing it names. So the
 * choice has to exist before the first prompt is built — before the run, before
 * settlement, on the draft. A later choice is not a worse choice; it is a choice
 * that cannot be honoured.
 *
 * There is therefore no toggle anywhere in this application, and there must never
 * be one. The single legal transition is anonymous -> named on a listing whose
 * owner has been verified through GitHub, which is an act of consent about one's
 * own product rather than a reaction to a number, and it lives with the claim.
 *
 * ## What the default is, and why an unrecognised value is refused instead
 *
 * Absent means **named** — the same default `products.anonymous` and
 * `submissions.anonymous` carry, and the ordinary case: the board is worth reading
 * because its rows can be checked, and most people want the credit. An API caller
 * that says nothing gets the documented default; the FORM never says nothing,
 * because it renders two radios with the named one pre-checked.
 *
 * A value that is present and unrecognised is a 422, not a default. The two
 * directions of that mistake are not symmetric: publishing a name that was meant
 * to be withheld is irreversible and is the one failure this feature exists to
 * prevent, while a refusal before payment costs an edit and no money. Guessing at
 * `anonymous=ture` is not worth an irreversible disclosure, so the route refuses
 * the way it already refuses an unknown tier.
 */

/** The field name on the form and in the JSON body. */
export const BYLINE_FIELD = 'anonymous';

/** Published under its own name and URL. The default. */
export const BYLINE_NAMED = 'named';

/** Published as a robot: the name and the URL withheld, and nothing else. */
export const BYLINE_ANONYMOUS = 'anonymous';

/** What the submitter is told when the field carried something unreadable. */
export const BYLINE_UNREADABLE =
  'We could not read your byline choice, so we did not guess. Pick “under your name” or ' +
  '“as a robot” and try again — nothing was charged.';

export type BylineCheck =
  | { readonly ok: true; readonly anonymous: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * The wire value, resolved to the decision.
 *
 * Accepts the two form values, the two JSON booleans, and the string spellings of
 * those booleans — `fetch`-based callers post `true`, form posts send `"named"`,
 * and both are the same intent. Anything else is refused rather than coerced; see
 * the module header for why the asymmetry is deliberate.
 */
export function readByline(raw: unknown): BylineCheck {
  if (raw === undefined || raw === null) return { ok: true, anonymous: false };
  if (typeof raw === 'boolean') return { ok: true, anonymous: raw };
  if (typeof raw !== 'string') return { ok: false, message: BYLINE_UNREADABLE };

  const value = raw.trim().toLowerCase();
  // An empty field is the same as no field: a form that did not render the
  // control, or a caller that left it out. Both mean "did not choose", and the
  // default for "did not choose" is the ordinary, checkable, named listing.
  if (value === '') return { ok: true, anonymous: false };
  if (value === BYLINE_NAMED || value === 'false') return { ok: true, anonymous: false };
  if (value === BYLINE_ANONYMOUS || value === 'true') return { ok: true, anonymous: true };
  return { ok: false, message: BYLINE_UNREADABLE };
}
