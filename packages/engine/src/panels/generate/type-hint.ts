/**
 * Tagline sampling and the provisional category-type heuristic. `01 §4` Step 2.
 *
 * `01` describes `generate_jury.py` as sampling the first `TAGLINE_SAMPLE` (15)
 * taglines and inferring a provisional type with a keyword count (`infer_type_hint`).
 *
 * ## This is a HINT, never a decision
 *
 * The hint is one line of a generation prompt. The authoritative `type` is what
 * the model returns and what `validateJury` checks against `01 §4` Step 2's
 * `{b2b, consumer, prosumer}`. Nothing downstream ever reads the hint: it does
 * not reach `ranking.json`, it is not persisted, and no arithmetic depends on it.
 *
 * That matters because the heuristic is crude on purpose. Ten b2b words against
 * eight consumer words over fifteen truncated taglines will misfire on any
 * category whose vocabulary is mixed — a category of security tools for
 * photographers lights up both lists. A wrong hint costs a model one sentence of
 * misleading prior; a wrong `type` would be installed. So the hint is stated to
 * the model as a guess it is expected to overrule.
 */

import { TAGLINE_SAMPLE } from '../../config/constants.js';
import type { CategoryType } from '../../types.js';

/**
 * The b2b vocabulary, verbatim from `01 §4` Step 2.
 *
 * `soc 2` carries a space, which is why matching is done with a regex rather
 * than by splitting on whitespace.
 */
export const B2B_WORDS: readonly string[] = [
  'compliance',
  'soc 2',
  'enterprise',
  'procurement',
  'api',
  'infrastructure',
  'sales',
  'crm',
  'security',
  'workflow',
];

/** The consumer vocabulary, verbatim from `01 §4` Step 2. */
export const CONSUMER_WORDS: readonly string[] = [
  'you',
  'your',
  'fun',
  'game',
  'photo',
  'personal',
  'daily',
  'free',
];

/**
 * The first `TAGLINE_SAMPLE` taglines, in the order given.
 *
 * The FIRST 15, not a random 15: `01` says `sample_taglines(k=15)` over rows that
 * arrive sorted by the sheet's `Rank`, and a deterministic slice keeps the
 * generation prompt byte-stable for a given category so two people generating the
 * same jury see the same prompt. Taking the head does mean the sample skews to
 * the incoming leaderboard's top — acceptable for a vocabulary hint, and not
 * acceptable anywhere a score is involved, which is why the calibration sample
 * (`brief §1.1`) stratifies instead of slicing.
 */
export function sampleTaglines(taglines: readonly string[]): string[] {
  return taglines.slice(0, TAGLINE_SAMPLE);
}

/**
 * Count whole-word occurrences of `word` in already-lowercased `text`.
 *
 * Word boundaries, not substring counting: without them `api` matches inside
 * "rapid" and "therapist", and `free` inside "freelance" — three of the commonest
 * words in product copy would each contribute a false vote. `01` does not pin the
 * matching rule (it describes the heuristic, it does not quote the code), so this
 * takes the reading that makes the counts mean what the word lists say.
 *
 * Multi-word entries (`soc 2`) work unchanged: the boundary assertions land on
 * the outside of the phrase.
 */
function countWord(text: string, word: string): number {
  const escaped = word.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`\\b${escaped}\\b`, 'g'))?.length ?? 0;
}

/** Total whole-word hits for a vocabulary across the sampled taglines. */
function countVocabulary(text: string, words: readonly string[]): number {
  return words.reduce((total, word) => total + countWord(text, word), 0);
}

/** What the heuristic saw, so a prompt can show its working rather than a bare verdict. */
export interface TypeHint {
  /** The guess the generation prompt states, and expects the model to overrule. */
  type: CategoryType;
  /** Whole-word hits from `B2B_WORDS` across the sample. */
  b2b_hits: number;
  /** Whole-word hits from `CONSUMER_WORDS` across the sample. */
  consumer_hits: number;
}

/**
 * The provisional type hint for a set of taglines. `01 §4` Step 2's
 * `infer_type_hint`: count b2b words against consumer words.
 *
 * A tie — including the zero-zero tie of a category whose copy uses neither
 * vocabulary — resolves to `prosumer`. That is the archetype between the two the
 * count is discriminating, so a count that failed to discriminate lands there
 * rather than picking an end arbitrarily; and `prosumer` is the reading a model
 * is most likely to revise, which is what a hint should be.
 */
export function inferTypeHint(taglines: readonly string[]): TypeHint {
  const text = taglines.join('\n').toLowerCase();
  const b2b = countVocabulary(text, B2B_WORDS);
  const consumer = countVocabulary(text, CONSUMER_WORDS);

  const type: CategoryType = b2b > consumer ? 'b2b' : consumer > b2b ? 'consumer' : 'prosumer';
  return { type, b2b_hits: b2b, consumer_hits: consumer };
}
