/**
 * The free preview's cache key — `the-pit-build-brief.md` §1.3.
 *
 * ## The defect
 *
 * Preview results were cached on the description hash alone. That is wrong
 * because a preview result is not a property of the text: it is a property of the
 * text *and the population it was placed into*. Brief §1.2 is explicit that
 * appending a product shifts the population mean and std, so **every** existing
 * z-score changes. The same description therefore yields a different rank band
 * after any placement in that category, and a description-only key serves the
 * stale one forever.
 *
 * ## The fix
 *
 * Key on all four things the result depends on:
 *
 *   (description_hash, category_snapshot_version, prompt_version, persona_version)
 *
 * - `descriptionHash` — the submitted text.
 * - `categorySnapshotVersion` — the population. Bumps on every placement and
 *   every nightly rebuild (`brief` Part 3).
 * - `promptVersion` — the jury. A juror swap is a new weight vector and a new
 *   composite (`brief` Part 3, "Changing the panel later").
 * - `personaVersion` — the customer panel, which supplies 35% of `core`.
 *
 * ## Known consequence
 *
 * `DECISIONS.md` S10 (open, Phase 5) records that `categorySnapshotVersion` bumps
 * so often that this key will rarely hit — on the one cost line that scales with
 * traffic rather than sales. The proposed relaxation is that a rank BAND may be
 * coarse enough to survive population drift on `(description_hash,
 * prompt_version)` alone. That decision is not made, so this implements §1.3 as
 * written: a key that is correct and rarely hits is a cost problem, while a key
 * that is wrong and hits is a customer serving a stale rank.
 *
 * Pure function. It computes a key; it does not read, write, or own a cache, and
 * it does not hash the description — the caller supplies that hash, because the
 * hashing policy belongs with whatever stores the entry.
 *
 * Phase 1 has no consumer for this (the free preview is a Phase 5 surface). It is
 * built here because §1.3 is one of the four defects Phase 1 exists to correct,
 * and the correction is only worth anything if it is in place before the surface
 * that would otherwise reintroduce it.
 */

/** The four components of a preview cache key. Source: `brief §1.3`. */
export interface PreviewCacheKeyInput {
  /** Hash of the submitted description. The caller chooses the hash function. */
  descriptionHash: string;
  /** The category's population snapshot; bumps on every placement and rebuild. */
  categorySnapshotVersion: string;
  /** The installed jury's version (`01 §4` Step 2). */
  promptVersion: string;
  /** The customer panel's version (`01 §4` Step 3). */
  personaVersion: string;
}

/** Field order is part of the key. Changing it would invalidate every entry. */
const FIELDS = ['descriptionHash', 'categorySnapshotVersion', 'promptVersion', 'personaVersion'] as const;

/** Tags keep the key readable in a log without making it ambiguous. */
const TAGS: Record<(typeof FIELDS)[number], string> = {
  descriptionHash: 'desc',
  categorySnapshotVersion: 'cat',
  promptVersion: 'prompt',
  personaVersion: 'persona',
};

/**
 * Build the stable preview cache key for one submission.
 *
 * The key is readable rather than hashed, so a stale or missing entry can be
 * diagnosed by looking at it. Components are percent-encoded, which is what makes
 * it unambiguous: no component can contain the `|` or `=` that separate them, so
 * two different inputs can never encode to the same key. Concatenating raw values
 * would let a version string containing a separator impersonate a different
 * submission — on the one endpoint that is public, unauthenticated, and free.
 *
 * Every component must be a non-empty string. An absent version silently
 * defaulting to `""` would collide two genuinely different states, which is the
 * exact class of bug §1.3 exists to remove, so it throws instead.
 */
export function previewCacheKey(input: PreviewCacheKeyInput): string {
  const parts: string[] = ['preview'];

  for (const field of FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value === '') {
      throw new RangeError(`previewCacheKey: ${field} must be a non-empty string`);
    }
    parts.push(`${TAGS[field]}=${encodeURIComponent(value)}`);
  }

  return parts.join('|');
}
