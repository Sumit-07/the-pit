/**
 * The `CategoryClassifier` that ships: nearest centroid, plus a blocking rule
 * calibrated to almost never fire on a correct category.
 *
 * ## The one number this file is optimized for
 *
 * Not accuracy. `DECISIONS.md` S12 and `brief §2.5` agree on the asymmetry — "a
 * false rejection on a paying customer is worse than an extra run" — and a
 * blocked submitter at 2am has nobody to appeal to. So the objective is: of the
 * 1028 labelled products in the corpus, filed in the category their own
 * submitter chose, how many would this classifier refuse?
 *
 * The answer, measured two ways in `test/submission/category-corpus.test.ts`, is
 * **zero**: zero with the shipped table, and zero under 5-fold cross-validation,
 * where each product is scored by a model that never saw it. The cross-validated
 * number is the honest one — the shipped table has memorized its own corpus,
 * scoring 92.9% top-1 in-sample against 52.1% held out — and it is the one the
 * thresholds below were fitted against.
 *
 * The price is recall, paid deliberately. Picking the right category first only
 * half the time across 28 fine-grained categories means ANY rule that blocked
 * whenever it disagreed with a submitter would reject hundreds of paying
 * customers. This one blocks 86.6% of a worst-case adversarial pick — a product
 * filed in the category it scores LOWEST of the 28, the pure form of
 * `DECISIONS.md` S12's "pick the weakest peers" — and lets everything arguable
 * through. Most of a free lever closed with no customer turned away beats all of
 * it closed with a tenth of them turned away.
 *
 * ## Four conditions, all of which must hold to block
 *
 * 1. **`MIN_KNOWN_TOKENS` words the corpus has actually seen.** Below that the
 *    text is a brand name, a single word, or a language the corpus does not
 *    contain, and every score is noise. 40 of the corpus's own correct rows score
 *    exactly zero in their true category for this reason; they must not be
 *    blocked, and this is the condition that spares them.
 * 2. **`MIN_SIMILARITY_GAP` of absolute separation.** The suggested category must
 *    out-score the chosen one by a real margin, which also guarantees the
 *    suggestion itself scores at least that much — there is no "this is not
 *    Developer Tools" without a "…it is Health & Fitness" worth putting in the
 *    message.
 * 3. **`MIN_SIMILARITY_RATIO`× more evidence.** An order of magnitude. Adjacent
 *    categories — a CI tool with an AI feature, an SEO product on a leaderboard —
 *    land between 1× and 3× and are exactly what this threshold exists to let
 *    through. In the corpus, correct assignments reach 7× at the 95th percentile
 *    and 11× at the 99th, which is why the bar is 10 and not 5.
 * 4. **`MIN_SUGGESTION_SIMILARITY` of fit for the suggestion itself.** "Nothing
 *    here fits, but this fits least" is not a mismatch.
 *
 * All four read only the two cosine similarities and the token count. Nothing a
 * submitter can write changes WHICH rule runs — only the numbers it is given.
 *
 * ## Confidence is the policy knob, and it is continuous
 *
 * `decideCategory` blocks at `CATEGORY_MISMATCH_BLOCK_CONFIDENCE` (0.8). This
 * file maps evidence onto that scale so the threshold means something: a
 * mismatch that exactly meets all four conditions reports 0.8, more evidence
 * reports more, and evidence at half the bar reports 0.4 — a review flag, not a
 * block. Lowering the threshold in `category.ts` therefore loosens the guard
 * smoothly rather than switching it between "never" and "always".
 */

import type { CategoryClassifier, CategoryClassifierInput, CategoryVerdict } from './category.js';
import { CATEGORY_MISMATCH_BLOCK_CONFIDENCE } from './category.js';
import type { CategoryModel } from './category-model.js';
import { scoreCategories } from './category-model.js';
import { SEEDED_CATEGORY_MODEL } from './category-model.data.js';

/**
 * How many of a submission's words the corpus must recognize before any verdict
 * other than `uncertain` is possible.
 *
 * Six is where the corpus's own non-English and one-word rows stop being scored
 * at all, and it is roughly the 5th percentile of the corpus's token counts, so
 * a real product description clears it easily.
 */
export const MIN_KNOWN_TOKENS = 6;

/** Minimum absolute cosine separation between the suggestion and the choice. */
export const MIN_SIMILARITY_GAP = 0.1;

/** Minimum ratio of evidence. A chosen category scoring zero counts as infinite. */
export const MIN_SIMILARITY_RATIO = 10;

/**
 * How well the SUGGESTED category must fit before it is worth suggesting.
 *
 * Nearly implied by the gap — a gap of 0.1 already forces the suggestion above
 * 0.1 — but not quite, and the two rows it catches are real: under
 * cross-validation, a consultant's profile and a booking product were each
 * out-scored ten to one by a category that itself barely fit. "Nothing fits, but
 * that fits least" is not evidence of a mismatch, and this is the condition that
 * says so.
 */
export const MIN_SUGGESTION_SIMILARITY = 0.12;

/**
 * Below half the bar, a disagreement is not even worth a review flag.
 *
 * Roughly half of all correct submissions score below some other category by a
 * little — that is what a 28-way classifier at ~50% top-1 looks like — and
 * flagging half the queue is the same as flagging none of it.
 */
const FLAG_FRACTION = 0.5;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Evidence against the chosen category, in units of "the blocking bar".
 *
 * `1` is exactly at the bar. The conjunction is a `min`, not an average, so a
 * spectacular ratio cannot buy its way past a missing absolute gap: both kinds
 * of evidence have to be there, which is what stops a pair of near-zero scores
 * whose quotient happens to be large from looking like proof of anything.
 */
function evidenceAgainst(chosenScore: number, bestScore: number): number {
  const gap = bestScore - chosenScore;
  const ratio = chosenScore <= 0 ? Number.POSITIVE_INFINITY : bestScore / chosenScore;
  return Math.min(
    gap / MIN_SIMILARITY_GAP,
    ratio / MIN_SIMILARITY_RATIO,
    bestScore / MIN_SUGGESTION_SIMILARITY,
  );
}

/**
 * Evidence to a confidence, hinged on the blocking threshold.
 *
 * Continuous and monotone, and `evidence === 1` maps exactly onto
 * `CATEGORY_MISMATCH_BLOCK_CONFIDENCE`, so "meets all three conditions" and
 * "blocks" are the same statement rather than two thresholds that can drift.
 * Above the bar it saturates at three times the bar, because the difference
 * between overwhelming and more overwhelming changes no decision.
 */
function mismatchConfidence(evidence: number): number {
  const bar = CATEGORY_MISMATCH_BLOCK_CONFIDENCE;
  if (evidence < 1) return bar * clamp(evidence, 0, 1);
  return bar + (1 - bar) * clamp((evidence - 1) / 2, 0, 1);
}

function reason(chosen: string, suggested: string, chosenScore: number, bestScore: number): string {
  return (
    `${suggested} matches this text ${bestScore.toFixed(3)} against ${chosen} at ` +
    `${chosenScore.toFixed(3)}, over ${MIN_KNOWN_TOKENS}+ known terms.`
  );
}

/**
 * Build a classifier over a model table.
 *
 * Exported so a test can classify against a model built from a subset of the
 * corpus — which is the only way to measure a false-rejection rate that is not
 * the model grading its own homework.
 */
export function createNearestCentroidClassifier(model: CategoryModel): CategoryClassifier {
  const known = new Set(model.categories);

  function verdictFor(input: CategoryClassifierInput): CategoryVerdict {
    const chosen = input.chosenCategory;
    // The roster is the server's, not the submitter's; intersecting with what the
    // model knows is what keeps a suggestion to a category that actually has a board.
    const roster = new Set(input.candidateCategories.filter((slug) => known.has(slug)));
    roster.add(chosen);

    if (!known.has(chosen)) {
      // A category the corpus has no products for. There is nothing to compare
      // against, and guessing would be inventing evidence.
      return { verdict: 'uncertain', confidence: 0, reason: `No labelled products for ${chosen}.` };
    }

    const { scores, knownTokens } = scoreCategories(model, input.name, input.description, roster);
    const best = scores[0];
    const chosenScore = scores.find((score) => score.slug === chosen)?.score ?? 0;
    if (best === undefined) {
      return { verdict: 'uncertain', confidence: 0, reason: 'No comparable categories.' };
    }

    if (knownTokens < MIN_KNOWN_TOKENS) {
      return {
        verdict: 'uncertain',
        confidence: 0,
        reason: `Only ${knownTokens} recognisable term(s); too little text to judge a category.`,
      };
    }

    if (best.slug === chosen) {
      // How clear the win was, so a `match` at 0.9 and a `match` at 0.55 are
      // distinguishable in the logs — the stub's constant is what made the
      // question "did anything actually look?" unanswerable.
      const runnerUp = scores[1]?.score ?? 0;
      const separation = clamp((chosenScore - runnerUp) / MIN_SIMILARITY_GAP, 0, 1);
      return { verdict: 'match', confidence: 0.5 + 0.5 * separation };
    }

    const evidence = evidenceAgainst(chosenScore, best.score);
    if (evidence < FLAG_FRACTION) {
      // Another category edges it out, but nowhere near enough to say so. This is
      // the ordinary state of a product that sits between two categories.
      return { verdict: 'match', confidence: 0.5 * (1 - clamp(evidence, 0, 1)) };
    }

    return {
      verdict: 'mismatch',
      confidence: mismatchConfidence(evidence),
      suggested: best.slug,
      reason: reason(chosen, best.slug, chosenScore, best.score),
    };
  }

  return {
    classify(input: CategoryClassifierInput): Promise<CategoryVerdict> {
      return Promise.resolve(verdictFor(input));
    },
  };
}

/**
 * The classifier the app wires in, over the table built from all 1028 labelled
 * products. No network, no key, no clock: safe on an unauthenticated route.
 */
export const seededCategoryClassifier: CategoryClassifier =
  createNearestCentroidClassifier(SEEDED_CATEGORY_MODEL);
