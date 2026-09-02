/**
 * The pitch field: what the founder claims, kept apart from what their site
 * says.
 *
 * ## Why there are two fields now and not one longer one
 *
 * `description` used to be the only text on the form, and it has quietly been
 * two different things at once. On the 1028 seeded rows it is a DIRECTORY's copy
 * — 913 of them were scraped from a third-party listing site, not written by
 * anybody at the company — so the jury has been partly grading a house style
 * that none of those founders chose. On a paid row it is whatever the submitter
 * typed, up to 300 characters, against a seeded median of 141: a different
 * length distribution as well as a different author.
 *
 * `POST /api/site-metadata` fixes the first half by pre-filling `description`
 * from the product's own `<meta name="description">`, so seeded and paid rows
 * carry first-party copy of comparable length and the two populations become
 * comparable. This field is the second half: the founder's own claim, in its own
 * labelled box, next to the site's.
 *
 * Merging them would throw away the only interesting comparison. "What the site
 * says" against "what they claim" is a signal; one blob containing both is not.
 *
 * ## The cap
 *
 * 800 characters — about 130 words — and the number is a scoring-cost decision
 * before it is a writing one. The recalibration prompt carries EVERY product in
 * a category, so a character here is paid once per row per rebuild, and
 * recalibration already runs 16–21× over its inference budget. Against that,
 * `Capability Substance`'s own anchors reward a specific claim rather than a
 * long one: "turns an OpenAPI spec into a typed Python client" scores 100 in
 * nine words. 800 is room for a claim with a number and a named user in it, and
 * deliberately not room for a landing page.
 *
 * ## Enforced on the server, and again in the database
 *
 * `maxlength` on the `<textarea>` is fast feedback and nothing more — it is one
 * devtools edit and one `curl` away from irrelevant. `readPitch` below is the
 * check that binds, it runs before a Dodo session is opened so an over-long
 * pitch costs the visitor nothing, and `submissions_pitch_limit` in
 * `0008_submission_pitch.sql` is the floor under every writer that is not this
 * handler.
 *
 * ## Nothing scores it yet
 *
 * The juror prompts and `pit/placement.requested` are unchanged: they still
 * carry the same `Product`, which is a name and a description. Wiring the pitch
 * into scoring is an engine change with its own calibration cost and its own
 * report. This stores it and shows it, so that when that change lands there is a
 * corpus to calibrate against instead of an empty column.
 */

/** The cap. Mirrored by `submissions_pitch_limit` in `packages/db`. */
export const PITCH_LIMIT = 800;

/** What the submitter is told when they go over it. Both numbers, no lecture. */
export function pitchTooLongMessage(length: number): string {
  return `Your pitch is ${length} characters. The limit is ${PITCH_LIMIT}.`;
}

export type PitchCheck =
  | { readonly ok: true; readonly pitch: string | null }
  | { readonly ok: false; readonly message: string; readonly length: number };

/**
 * The server-side cap.
 *
 * Refuses rather than truncating. A silent truncation would store a sentence the
 * founder did not finish and then show it back to them as if they had written
 * it, which is a worse outcome than being told to trim — and this runs before
 * payment, so being told costs them an edit and not a refund.
 *
 * An empty field is `null`, not `''`. The column is nullable precisely so that
 * "said nothing" and "said nothing, at length" stay distinguishable.
 */
export function readPitch(raw: string): PitchCheck {
  const pitch = raw.trim();
  if (pitch === '') return { ok: true, pitch: null };
  // Counted in code units, the same unit `maxlength` and Postgres'
  // `char_length` disagree about for astral characters — see the report. The
  // browser's cap is therefore never LOOSER than this one, which is the
  // direction that matters: the server refuses first.
  if (pitch.length > PITCH_LIMIT) {
    return { ok: false, message: pitchTooLongMessage(pitch.length), length: pitch.length };
  }
  return { ok: true, pitch };
}
