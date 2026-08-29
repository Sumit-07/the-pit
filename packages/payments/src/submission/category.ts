/**
 * Category choice, and the seam for the classifier that polices it.
 *
 * ## Why a free-text category field is a rank lever
 *
 * `DECISIONS.md` S12: rank is computed inside a category. Merit z-scores are
 * normalized against that category's population and demand is decided inside a
 * cluster drawn from it, so the *same* product, *same* description, placed in a
 * category with weaker peers, ranks higher — by more than any amount of copy
 * editing could move it. That violates the standing rule that rank must not be
 * improvable by anything other than resolution, and it was previously free and
 * unmoderated.
 *
 * The founder's decision, recorded in S12: **the user picks**, a cheap
 * classifier blocks obvious mismatches, and the check runs **before payment so
 * nobody pays for a rejection**. Not an automatic assignment — a submitter often
 * knows their market better than a classifier does, and a wrong auto-assignment
 * is unappealable. The classifier's job is narrow: catch the developer-tool
 * being filed under Health & Fitness because that is where the peers are soft.
 *
 * ## What is built here and what is not
 *
 * The interface, the blocking policy, and the pre-payment ordering are built and
 * tested. The classifier itself is a STUB — `acceptAllClassifier` — because the
 * real one is a model call, and a model call that has not been prompt-tuned
 * against the seeded categories would produce exactly the confident false
 * rejections this design is trying to avoid. Swapping it is one argument at the
 * call site.
 *
 * ## The blocking policy errs toward letting people in
 *
 * Only a HIGH-CONFIDENCE mismatch blocks. `uncertain`, and a mismatch the
 * classifier is not sure of, both pass and are flagged for review instead. This
 * mirrors `brief §2.5`'s reasoning about URL evasion — "a false rejection on a
 * paying customer is worse than an extra run" — with the added point that a
 * blocked submitter has nowhere to appeal to at 2am.
 */

/** Below this confidence a mismatch is a flag, not a block. */
export const CATEGORY_MISMATCH_BLOCK_CONFIDENCE = 0.8;

export interface CategoryClassifierInput {
  readonly name: string;
  readonly description: string;
  /** The category the submitter chose. */
  readonly chosenCategory: string;
  /** Every category on offer, so the classifier can name a better one. */
  readonly candidateCategories: readonly string[];
}

export type CategoryVerdict =
  | { readonly verdict: 'match'; readonly confidence: number }
  | {
      readonly verdict: 'mismatch';
      readonly confidence: number;
      /** The category the classifier would have picked. Shown in the rejection. */
      readonly suggested: string;
      readonly reason: string;
    }
  | { readonly verdict: 'uncertain'; readonly confidence: number; readonly reason: string };

/**
 * The seam. Async because the real implementation is a model call; the stub
 * resolves immediately.
 */
export interface CategoryClassifier {
  classify(input: CategoryClassifierInput): Promise<CategoryVerdict>;
}

/**
 * The placeholder: everything matches, at zero confidence.
 *
 * Zero rather than one on purpose. `confidence` is only ever compared against a
 * blocking threshold, so a stub that reported certainty would be indistinguishable
 * in the logs from a real classifier that had actually looked, and the day the
 * real one is installed nobody would be able to tell from the data whether it
 * had been.
 */
export const acceptAllClassifier: CategoryClassifier = {
  classify(): Promise<CategoryVerdict> {
    return Promise.resolve({ verdict: 'match', confidence: 0 });
  },
};

export type CategoryDecision =
  | { readonly action: 'allow'; readonly verdict: CategoryVerdict; readonly flagForReview: boolean }
  | {
      readonly action: 'block';
      readonly verdict: CategoryVerdict;
      readonly suggested: string;
      readonly message: string;
    };

/**
 * Turn a classifier verdict into a decision.
 *
 * Pure, and separate from the classifier, so the policy can be tested against
 * hand-written verdicts without a model and so changing the threshold cannot
 * accidentally change what the classifier reports.
 */
export function decideCategory(
  verdict: CategoryVerdict,
  chosenCategory: string,
  blockConfidence: number = CATEGORY_MISMATCH_BLOCK_CONFIDENCE,
): CategoryDecision {
  if (verdict.verdict === 'mismatch' && verdict.confidence >= blockConfidence) {
    return {
      action: 'block',
      verdict,
      suggested: verdict.suggested,
      message:
        `This reads like ${verdict.suggested}, not ${chosenCategory}. ` +
        'Pick the category your buyers would search, then submit again — you have not been charged.',
    };
  }
  return {
    action: 'allow',
    verdict,
    flagForReview: verdict.verdict !== 'match',
  };
}
