/**
 * "Require materially changed description text" (`brief §2.4`).
 *
 * ## What the rule is actually defending
 *
 * §2.4's first bullet is the load-bearing one: a re-pitch REPLACES the previous
 * listing, never keeps the best, because keep-the-best is a slot machine
 * exploitable on variance alone. Replacement removes the incentive to reroll —
 * but only if a reroll requires actual work. Without this check, "re-pitch"
 * with the same text is a free resample of a stochastic panel, and $5 buys a
 * spin. `brief §1.2` says plainly that raw scores differ between runs and that
 * nothing may assume rank stability, so the variance is real and known.
 *
 * So the test is not "is this a different string". It is "did the submitter
 * change what they are claiming".
 *
 * ## The measure, and why this one
 *
 * Similarity is Jaccard over the SET of normalized tokens: `|A ∩ B| / |A ∪ B|`.
 * Three properties earn it the job:
 *
 * - **Word reordering scores 1.0.** Shuffling a sentence is not a new pitch, and
 *   an edit-distance measure would call it a large change.
 * - **It is symmetric and bounded**, so the threshold means the same thing on a
 *   40-word description and a 15-word one.
 * - **It is hand-checkable.** Anyone reviewing a rejected submission can count
 *   the words. A cosine over embeddings could not be argued with, could not be
 *   tested without a model call, and would put a network dependency on a
 *   pre-payment check.
 *
 * Similarity alone is not enough, because it is scale-dependent in the direction
 * that matters: swapping one word in an 8-token description moves Jaccard to
 * 0.78 (under the threshold) while the same edit in a 25-token description
 * leaves it at 0.92 (over it). So a second condition runs alongside — an
 * absolute floor on how many distinct tokens moved. Both must be satisfied.
 * `deploys` → `deployments` fails the floor and is rejected in both cases.
 *
 * ## Which way it errs
 *
 * Toward rejection, deliberately, and this is the one guard where that is safe:
 * it runs BEFORE payment (`brief §2.4`), so a false rejection costs an edit, not
 * five dollars. Contrast `brief §2.5`, where a suspected URL evasion is flagged
 * for review rather than hard-blocked — that check can land on someone who has
 * already paid.
 */

/** Above this Jaccard similarity, two descriptions are the same pitch. */
export const MATERIAL_CHANGE_MAX_SIMILARITY = 0.8;

/** Fewer distinct tokens than this moved, and it is an edit rather than a rewrite. */
export const MATERIAL_CHANGE_MIN_TOKEN_DELTA = 3;

export interface MaterialChangeThresholds {
  readonly maxSimilarity?: number;
  readonly minTokenDelta?: number;
}

export interface MaterialChangeResult {
  readonly material: boolean;
  /** Jaccard over normalized token sets. `1` for identical text, `0` for disjoint. */
  readonly similarity: number;
  /** Tokens in one description and not the other, both directions summed. */
  readonly tokenDelta: number;
  /** True when the normalized texts are byte-identical — the commonest rejection. */
  readonly identical: boolean;
}

/**
 * Lowercase, strip everything that is not a letter, digit or intra-word mark,
 * collapse whitespace.
 *
 * Punctuation is dropped rather than tokenized so that adding a full stop, or
 * changing "state-of-the-art" to "state of the art", does not read as a rewrite.
 * Digits are kept: "10x faster" → "100x faster" is a different claim and should
 * count.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
}

/** The normalized text, for the identical-string check. */
export function normalizeDescription(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * Did the description change materially?
 *
 * An empty previous description (there was no previous pitch) is not this
 * function's problem — `checkSubmission` only calls it when a listing exists.
 * Called with two empty strings it reports `identical`, similarity 1, and no
 * material change, which is the safe answer.
 */
export function materialChange(
  previous: string,
  next: string,
  thresholds: MaterialChangeThresholds = {},
): MaterialChangeResult {
  const maxSimilarity = thresholds.maxSimilarity ?? MATERIAL_CHANGE_MAX_SIMILARITY;
  const minTokenDelta = thresholds.minTokenDelta ?? MATERIAL_CHANGE_MIN_TOKEN_DELTA;

  const before = new Set(tokenize(previous));
  const after = new Set(tokenize(next));
  const identical = normalizeDescription(previous) === normalizeDescription(next);

  if (before.size === 0 && after.size === 0) {
    return { material: false, similarity: 1, tokenDelta: 0, identical: true };
  }

  let intersection = 0;
  for (const token of after) {
    if (before.has(token)) {
      intersection += 1;
    }
  }
  const union = before.size + after.size - intersection;
  const similarity = union === 0 ? 1 : intersection / union;
  const tokenDelta = union - intersection;

  return {
    material: !identical && similarity <= maxSimilarity && tokenDelta >= minTokenDelta,
    similarity,
    tokenDelta,
    identical,
  };
}
