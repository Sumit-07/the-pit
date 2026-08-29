/**
 * The category classifier's arithmetic: a nearest-centroid model over the
 * labelled corpus, and nothing else.
 *
 * ## Why this shape and not a model call
 *
 * `DECISIONS.md` S12 puts the category check BEFORE payment, on
 * `POST /api/checkout`, which `brief §2.1` makes guest checkout — no session, no
 * identity, no rate limit that costs the caller anything. A model call on that
 * route is an unauthenticated endpoint that spends money per request: anyone
 * with `curl` could drain an inference budget without ever reaching a payment
 * form. So the classifier is arithmetic over a table that ships with the build:
 * no network, no key, no clock, no randomness, and the same answer every time it
 * is asked the same question.
 *
 * ## Nearest centroid, because the labels already exist
 *
 * `cjr/` was seeded from a workbook where 1028 products carry the category their
 * own submitters chose on outbid.lol. That is a labelled set, so the cheapest
 * honest classifier is the oldest one: represent each product as a tf-idf vector
 * over its name and description, average the vectors of a category's products
 * into a centroid, and score a new submission by cosine similarity to each
 * centroid (Rocchio). It costs one tokenization and 28 sparse dot products.
 *
 * The centroids are computed offline by `scripts/build-category-model.ts` and
 * shipped as `category-model.data.ts`; `test/submission/category-model.build.test.ts`
 * rebuilds them from the corpus and fails if the committed table has drifted, so
 * the artifact cannot silently stop matching the data it claims to summarize.
 *
 * ## The scoring is deliberately blunt about what it does not know
 *
 * A token the corpus never saw contributes to the submission vector's LENGTH but
 * to no centroid's dot product. That is the point: text made of words the corpus
 * has no opinion about scores low against EVERY category, which lands it in
 * `uncertain` — pass, flag — rather than letting three lucky tokens decide a
 * rejection. `category-classifier.ts` reads that as "no evidence", never as "mismatch".
 */

import { sanitize, SANITIZE_LIMIT } from '@the-pit/engine';

/**
 * Words carrying no category signal — English function words, plus the handful
 * of verbs every product page uses about itself.
 *
 * Kept small on purpose. Words that LOOK generic ("platform", "tool", "agent")
 * are not on this list, because idf is a better judge of that than intuition is:
 * "tool" really is evidence for Developer Tools, and hand-deleting it would be
 * throwing away signal to satisfy a hunch.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'did', 'do', 'does', 'doing', 'don', 'down', 'during', 'each', 'even', 'ever', 'every', 'few',
  'for', 'from', 'further', 'get', 'gets', 'had', 'has', 'have', 'having', 'he', 'her', 'here',
  'hers', 'herself', 'him', 'himself', 'his', 'how', 'however', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'itself', 'just', 'let', 'lets', 'like', 'made', 'make', 'makes', 'many', 'me', 'more',
  'most', 'much', 'must', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once',
  'one', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'per',
  'put', 're', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'us', 'use', 'used', 'uses', 'using', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/**
 * The longest run of text the tokenizer will look at, per field.
 *
 * `checkSubmissionLocal` already refuses a description over `SANITIZE_LIMIT`, so
 * in the guard path this is never the binding limit. It is here because
 * `classify` is a public entry point on an unauthenticated route and must be
 * bounded by its own code rather than by a caller's promise — the cost of
 * classifying has to be a constant, not a function of what a stranger typed.
 */
export const CLASSIFIER_TEXT_LIMIT = SANITIZE_LIMIT;

/** Tokens are letters, digits, `+` and `#`, so `c++` and `c#` survive. */
const NON_TOKEN = /[^a-z0-9+#]+/gu;

/** All digits, e.g. `2026` or `24`. Carries no category signal. */
const ALL_DIGITS = /^[0-9]+$/u;

/**
 * Strip a plural `s`, and nothing more.
 *
 * Full stemming (`-ing`, `-ed`, `-ion`) was not worth it: it collapses
 * `marketing` into `market` and `trading` into `trade`, which merges two of the
 * most category-discriminative tokens in the corpus into their blandest forms.
 * Plurals are the one inflection that is pure noise here — `agents`/`agent`,
 * `workouts`/`workout` — so that is the only one folded.
 */
function singular(token: string): string {
  if (token.length >= 4 && token.endsWith('s') && !/(?:ss|us|is)$/u.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Product text to a term-frequency map.
 *
 * The input is UNTRUSTED (`brief` Global Constraint 2, and here it arrives
 * before payment and before any moderation), so it is sanitized — control and
 * format characters stripped, whitespace collapsed, truncated — before anything
 * looks at it, and the tokenizer's own alphabet is a whitelist. Nothing in the
 * text can reach a decision except as counts of tokens: there is no branch in
 * this file that a submission's wording can change, only numbers it can move.
 */
export function tokenizeProduct(name: string, description: string): Map<string, number> {
  const text = `${sanitize(name, CLASSIFIER_TEXT_LIMIT)} ${sanitize(description, CLASSIFIER_TEXT_LIMIT)}`;
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().replace(NON_TOKEN, ' ').split(' ')) {
    if (raw.length < 2 || ALL_DIGITS.test(raw)) continue;
    const token = singular(raw);
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** Sub-linear term frequency: a word repeated five times is not five times the evidence. */
function termFrequency(count: number): number {
  return 1 + Math.log(count);
}

/** One labelled product. The corpus is a list of these. */
export interface LabelledProduct {
  /** The category slug this product actually belongs to. */
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

/**
 * The shipped table.
 *
 * Parallel arrays rather than objects because the generated file is read by
 * nobody and diffed by everybody: numbers keyed by position stay stable when a
 * single token's weight changes, where a map of maps would reflow.
 */
export interface CategoryModel {
  /** Bumped when the arithmetic changes in a way that invalidates a stored table. */
  readonly version: number;
  /** How many labelled products the table was built from. Reported, never used in scoring. */
  readonly documentCount: number;
  /** Category slugs, sorted. Centroid `i` belongs to category `i`. */
  readonly categories: readonly string[];
  /** Vocabulary, sorted. Token `i` has inverse document frequency `idf[i]`. */
  readonly vocabulary: readonly string[];
  readonly idf: readonly number[];
  /** The idf charged to a token the corpus never saw. See `scoreCategories`. */
  readonly unknownIdf: number;
  /**
   * One L2-normalized sparse centroid per category, flattened as
   * `[tokenIndex, weight, tokenIndex, weight, ...]` with indices ascending.
   */
  readonly centroids: readonly (readonly number[])[];
}

/** How many of a centroid's heaviest terms survive into the shipped table. */
export const CENTROID_TERMS = 260;

/** A token must appear in at least this many products to earn a vocabulary slot. */
export const MIN_DOCUMENT_FREQUENCY = 1;

/** Weights are stored rounded, so the table is byte-reproducible across platforms. */
const WEIGHT_PRECISION = 6;

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function l2Normalize(vector: Map<number, number>): void {
  let sum = 0;
  for (const weight of vector.values()) sum += weight * weight;
  const norm = Math.sqrt(sum);
  if (norm === 0) return;
  for (const [index, weight] of vector) vector.set(index, weight / norm);
}

/**
 * Build the table from a labelled corpus. Offline only.
 *
 * Deterministic: every iteration order here is over a sorted array or an insertion
 * order derived from one, so the same corpus produces the same bytes on any
 * machine (`brief` Global Constraint 5).
 */
export interface BuildOptions {
  readonly minDocumentFrequency?: number;
  readonly centroidTerms?: number;
}

export function buildCategoryModel(
  corpus: readonly LabelledProduct[],
  options: BuildOptions = {},
): CategoryModel {
  const minDocumentFrequency = options.minDocumentFrequency ?? MIN_DOCUMENT_FREQUENCY;
  const centroidTerms = options.centroidTerms ?? CENTROID_TERMS;
  const documents = corpus.map((product) => ({
    slug: product.slug,
    counts: tokenizeProduct(product.name, product.description),
  }));

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = documents.length;
  const vocabulary = [...documentFrequency.entries()]
    .filter(([, frequency]) => frequency >= minDocumentFrequency)
    .map(([token]) => token)
    .sort();
  const index = new Map(vocabulary.map((token, position) => [token, position]));
  // Smoothed idf. A token seen in one document — the rarest thing the vocabulary
  // admits — is also what an unseen token is charged, so novel wording costs a
  // submission vector length without buying it similarity to anything.
  const idf = vocabulary.map((token) => Math.log((total + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1);
  const unknownIdf = Math.log((total + 1) / 2) + 1;

  const categories = [...new Set(corpus.map((product) => product.slug))].sort();
  const sums = new Map<string, Map<number, number>>(categories.map((slug) => [slug, new Map()]));

  for (const document of documents) {
    const vector = new Map<number, number>();
    for (const [token, count] of document.counts) {
      const position = index.get(token);
      if (position === undefined) continue;
      vector.set(position, termFrequency(count) * (idf[position] ?? 0));
    }
    l2Normalize(vector);
    const sum = sums.get(document.slug);
    if (sum === undefined) continue;
    for (const [position, weight] of vector) {
      sum.set(position, (sum.get(position) ?? 0) + weight);
    }
  }

  const centroids = categories.map((slug) => {
    const sum = sums.get(slug) ?? new Map<number, number>();
    // Top terms only. The tail of a centroid is a long list of near-zero weights
    // that move no decision and would triple the size of the shipped file.
    const kept = [...sum.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, centroidTerms);
    const vector = new Map(kept);
    // Normalized AFTER pruning, so the shipped centroid is a unit vector and the
    // cosine the runtime computes is the cosine this file's thresholds were tuned on.
    l2Normalize(vector);
    return [...vector.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([position, weight]) => [position, round(weight, WEIGHT_PRECISION)]);
  });

  return {
    version: 1,
    documentCount: total,
    categories,
    vocabulary,
    idf: idf.map((value) => round(value, WEIGHT_PRECISION)),
    unknownIdf: round(unknownIdf, WEIGHT_PRECISION),
    centroids,
  };
}

/** A category's cosine similarity to the submission, in `[0, 1]`. */
export interface CategoryScore {
  readonly slug: string;
  readonly score: number;
}

export interface ScoredSubmission {
  /** Every category in `restrictTo` that the model knows, best first. */
  readonly scores: readonly CategoryScore[];
  /** How many of the submission's tokens the corpus has ever seen. */
  readonly knownTokens: number;
}

/**
 * Token to vocabulary position, built once per model.
 *
 * A `WeakMap` rather than a field on the model, because the shipped table is a
 * frozen literal and this is a derived index, not data: keying the cache on the
 * object identity means a model built in a test is memoized exactly like the
 * shipped one and neither has to carry a cache around in its type. It changes
 * nothing about the answer, only how many times the same array is walked.
 */
const indexCache = new WeakMap<CategoryModel, Map<string, number>>();

function vocabularyIndex(model: CategoryModel): Map<string, number> {
  const cached = indexCache.get(model);
  if (cached !== undefined) return cached;
  const index = new Map(model.vocabulary.map((token, position) => [token, position]));
  indexCache.set(model, index);
  return index;
}

/**
 * Score a submission against the model's centroids.
 *
 * The submission vector is L2-normalized over ALL its tokens — the unknown ones
 * charged `unknownIdf` — so similarity is bounded by how much of the text the
 * corpus actually recognizes. A submission written entirely in vocabulary the
 * corpus has never seen scores near zero against all 28 centroids, which is the
 * honest answer and the one the classifier turns into `uncertain`.
 */
export function scoreCategories(
  model: CategoryModel,
  name: string,
  description: string,
  restrictTo?: ReadonlySet<string>,
): ScoredSubmission {
  const counts = tokenizeProduct(name, description);
  const index = vocabularyIndex(model);

  const vector = new Map<number, number>();
  let squared = 0;
  let knownTokens = 0;
  for (const [token, count] of counts) {
    const frequency = termFrequency(count);
    const position = index.get(token);
    if (position === undefined) {
      squared += (frequency * model.unknownIdf) ** 2;
      continue;
    }
    knownTokens += 1;
    const weight = frequency * (model.idf[position] ?? 0);
    vector.set(position, weight);
    squared += weight * weight;
  }

  const norm = Math.sqrt(squared);
  const scores: CategoryScore[] = [];
  for (const [position, slug] of model.categories.entries()) {
    if (restrictTo !== undefined && !restrictTo.has(slug)) continue;
    const centroid = model.centroids[position];
    if (centroid === undefined) continue;
    let dot = 0;
    for (let cursor = 0; cursor < centroid.length; cursor += 2) {
      const token = centroid[cursor] ?? 0;
      const weight = vector.get(token);
      if (weight !== undefined) dot += weight * (centroid[cursor + 1] ?? 0);
    }
    scores.push({ slug, score: norm === 0 ? 0 : dot / norm });
  }

  // Ties broken by slug so the suggested category never depends on Map ordering.
  scores.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1));
  return { scores, knownTokens };
}
