/**
 * The calibration sample — `the-pit-build-brief.md` §1.1, the most important
 * correction in the project.
 *
 * ## The defect
 *
 * In a full category run a juror sees up to `CHUNK_SIZE` products in one prompt
 * and spreads its deductions across them (`01 §5.1`: start at 100, deduct with
 * reasons). In the incremental `--add-product` path a juror sees **one product
 * alone**, with no peers to deduct against, and returns systematically different
 * raw scores for the same text.
 *
 * `01 §6.1` z-normalizes across products afterwards, so those raw scores are not
 * an isolated cosmetic difference: they enter the same population as scores
 * produced under comparative conditions and move the placement. Every paid
 * submission goes through the incremental path, so the entire bias lands on
 * paying customers — and it is invisible, because a lone product's scores look
 * perfectly plausible either way.
 *
 * ## The fix
 *
 * Embed a fixed sample of `CALIBRATION_SAMPLE` already-scored products from the
 * same category in the incremental prompt, **shown with the scores they were
 * already assigned, as reference, and never re-scored**. That restores the
 * comparative context. The juror still returns one product's scores, so the
 * output stays ~200 tokens instead of ~2,400; only the input grows.
 *
 * ## Known cost consequence
 *
 * The calibration block never repeats ACROSS SUBMISSIONS. `categoryVersion` is
 * part of the seed, and per `brief` Part 3 the category snapshot version bumps on
 * every placement and every nightly rebuild — so the anchor is redrawn for each
 * customer. That is the correct behaviour: an anchor frozen against a stale
 * population would calibrate a new product against a board that no longer exists.
 * But it means the added input tokens are paid on every submission rather than
 * amortized across a category. This is the same shape of trade-off
 * `DECISIONS.md` S10 records for the preview cache key.
 *
 * What the prompt layer does with that (`src/panels/prompts/score.ts`): the block
 * sits INSIDE the cached prefix, but it is not what the breakpoint is for. Each
 * scoring request places exactly one breakpoint, at the end of the stable prefix
 * — method, rubric, calibration, product chunk — because those bytes are shared
 * by the SIX JURORS OF ONE RUN, which is the repetition that actually exists. The
 * juror mandate is the volatile tail and is deliberately left uncached. A second
 * breakpoint covering only the method and rubric was considered and rejected: that
 * prefix would very likely fall below Claude Haiku 4.5's minimum cacheable length
 * and so would not cache at all, while still costing a write premium wherever it
 * did. Nothing downstream should plan cost around a cross-submission hit here.
 *
 * Two properties are the whole point of the fix, and both are enforced here:
 *
 * 1. **Stable per category.** The same category at the same `categoryVersion`
 *    yields the identical sample, every time, in every process. The selection is
 *    derived from a seed built out of the category slug and the version — never
 *    `Math.random()`, never a clock, and never the order the input arrays happen
 *    to arrive in. A sample that drifted between runs would move the calibration
 *    with it, and the fix would do nothing.
 * 2. **Versioned.** `calibration_version` is emitted alongside the sample and is
 *    a digest of the sample's actual content, so any change to the selection, to
 *    a peer's scores, or to a peer's text invalidates downstream caches.
 *
 * And a third that is easy to get wrong: the sample is **spread across the score
 * range**, not the top `CALIBRATION_SAMPLE`. An anchor made of the category's
 * best products teaches the juror that the category is uniformly excellent and
 * re-introduces the bias it was meant to remove, in the opposite direction.
 *
 * ## What this module is not
 *
 * It selects and versions the sample. It does not build a prompt: wrapping the
 * (UNTRUSTED, Global Constraint 2) product text as labelled DATA belongs to the
 * prompt layer. Nothing here produces or sees a rank (Global Constraint 1); the
 * scores it carries are the raw 0-100 numbers already computed and published.
 */

import { CALIBRATION_SAMPLE, SANITIZE_LIMIT } from '../config/constants.js';
import { sanitize } from '../ingest/sanitize.js';
import { partitionSizes } from '../rank/chunk.js';
import { mean } from '../rank/stats.js';
import type { Product, RankedProduct } from '../types.js';
import { digest, mulberry32, requireSlug, seedFrom } from './seeded.js';

/**
 * Namespace for this module's seed. Keeps the sample selection from moving in
 * step with the render order (`src/panels/ordering.ts`), which is drawn from the
 * same `(slug, categoryVersion)` pair. The string is load-bearing: changing it
 * redraws every calibration sample in existence.
 */
const CALIBRATION_SEED_NAMESPACE = 'calibration-seed';

/**
 * One already-scored peer, as it is handed to the prompt layer.
 *
 * `scores` is keyed by metric name and holds that peer's published per-metric
 * score — the cross-juror mean of `ScorecardEntry.score`, which is the number
 * the board shows. It is reference material: the juror is shown it and must not
 * re-score it.
 *
 * `description` is UNTRUSTED product text (Global Constraint 2). It is
 * sanitized and truncated here, but the caller must still wrap it in the `<<< >>>`
 * data block and label it as content to be judged, never obeyed.
 */
export interface CalibrationProduct {
  id: number;
  name: string;
  description: string;
  scores: Record<string, number>;
}

/** A calibration sample and the version that identifies its exact content. */
export interface CalibrationSample {
  sample: CalibrationProduct[];
  /**
   * Identifies this exact sample. Changes when the category version changes,
   * when the selection changes, or when any selected peer's text or scores
   * change — so a downstream cache keyed on it can never serve a result
   * computed against a different anchor.
   */
  calibration_version: string;
}

/**
 * The slice of `ranking.json` (`01 §6.6`) the selector reads: the category it
 * belongs to and its scored rows. A whole `Ranking` is structurally assignable
 * to this, so Task 7 passes the document it just built.
 */
export interface CalibrationRanking {
  category: string;
  ranking: readonly RankedProduct[];
}

/** A scored product that is eligible to appear in a sample, with its sort key. */
interface Candidate extends CalibrationProduct {
  /**
   * Mean of this product's published per-metric scores. The axis the sample is
   * spread along, chosen because it is the number the juror actually sees in the
   * calibration block: spreading along `composite` or `rank` would spread along
   * an axis the prompt never shows.
   */
  meanScore: number;
}

/**
 * Pick `CALIBRATION_SAMPLE` already-scored products from a category to embed in
 * an incremental scoring prompt as calibration. `brief §1.1`.
 *
 * ## Selection
 *
 * 1. **Candidates.** Every row of `rankings.ranking` that has a matching
 *    `Product` (for its description) and at least one scorecard entry (a product
 *    with no published scores cannot anchor anything).
 * 2. **Canonical order.** Candidates are sorted by mean published score,
 *    descending, ties broken by `id` ascending. This is what makes the result
 *    independent of the order the caller's arrays happen to be in — a sample
 *    that depended on array order would be stable only by luck.
 * 3. **Strata.** The sorted candidates are cut into exactly `sampleSize`
 *    contiguous bands of near-equal size (`partitionSizes`, the same
 *    sums-to-exactly-n split `balancedChunks` uses). Band 1 holds the highest
 *    scorers, the last band the lowest.
 * 4. **One pick per stratum**, chosen by a PRNG seeded from
 *    `(category slug, categoryVersion)`. Exactly one peer comes from each band,
 *    so the anchor covers the distribution the new product is being placed into
 *    by construction — taking the top `sampleSize` is not merely discouraged
 *    here, it is unreachable.
 *
 * Same category + same version + same scores -> byte-identical result. Bumping
 * `categoryVersion` deliberately redraws the sample, which is what makes
 * `calibration_version` a usable cache key.
 *
 * ## Degenerate inputs
 *
 * With `sampleSize` or fewer candidates, every candidate is returned in canonical
 * order — there is nothing to select, and the spread is total. A category with
 * no scored candidates returns an empty sample and still returns a version, so a
 * caller can cache the "no calibration available" state rather than re-deriving
 * it. A caller handed an empty sample is scoring in isolation and should say so
 * rather than pretend the correction was applied.
 *
 * An empty `categoryVersion`, or a category name with no alphanumeric characters
 * (which would slug to `''`), throws. Both would silently collide two different
 * states onto one seed and one version digest.
 *
 * @param products Every usable product in the category, from ingest — the source
 *   of the descriptions the ranking rows do not carry.
 * @param rankings The category's ranking document (`01 §6.6`), the source of the
 *   published per-metric scores and of the category name the seed is built from.
 * @param categoryVersion The category snapshot version. Part of the seed, so it
 *   is what pins "the same sample every time" to a point in the category's life.
 * @param sampleSize Peers to select. Defaults to `CALIBRATION_SAMPLE`.
 */
export function selectCalibrationSample(
  products: readonly Product[],
  rankings: CalibrationRanking,
  categoryVersion: string,
  sampleSize: number = CALIBRATION_SAMPLE,
): CalibrationSample {
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new RangeError(`selectCalibrationSample: sampleSize must be a positive integer, got ${sampleSize}`);
  }

  // Both degenerate inputs — an empty version, or a name that slugs to `''` —
  // would collide two different states onto one seed and one version digest.
  const slug = requireSlug('selectCalibrationSample', rankings.category, categoryVersion);

  const candidates = collectCandidates(products, rankings.ranking);

  const selected =
    candidates.length <= sampleSize
      ? candidates
      : pickAcrossStrata(candidates, sampleSize, seedFrom(CALIBRATION_SEED_NAMESPACE, slug, categoryVersion));

  const sample: CalibrationProduct[] = selected.map(({ id, name, description, scores }) => ({
    id,
    name,
    description,
    scores,
  }));

  return { sample, calibration_version: versionFor(slug, categoryVersion, sampleSize, sample) };
}

/**
 * The eligible peers, in canonical order: mean published score descending, `id`
 * ascending. A row whose product is unknown, whose id repeats, or that carries no
 * scorecard is dropped — each of those would put a peer with no reference scores,
 * or no text, into the calibration block.
 */
function collectCandidates(products: readonly Product[], rows: readonly RankedProduct[]): Candidate[] {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const seen = new Set<number>();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    const product = productsById.get(row.id);
    if (product === undefined || seen.has(row.id)) continue;

    // Built through `Object.fromEntries` rather than by assignment: metric names
    // are generated by the jury pass, and `scores[metric] = x` on an object
    // literal would invoke the prototype setter for a metric named `__proto__`
    // instead of recording a score. `fromEntries` defines an own property.
    const scores: Record<string, number> = Object.fromEntries(
      row.scorecard.map((entry) => [entry.metric, entry.score] as const),
    );
    const values = Object.values(scores);
    if (values.length === 0) continue;

    seen.add(row.id);
    candidates.push({
      id: row.id,
      name: product.name,
      // Defence in depth on a prompt boundary: ingest already sanitized this, and
      // the operation is idempotent, so re-running it costs nothing and closes the
      // path where a caller assembles `Product`s itself (Task 7's incremental
      // path, Phase 5's preview) and reaches a juror with raw text.
      description: sanitize(product.description, SANITIZE_LIMIT),
      scores,
      meanScore: mean(values),
    });
  }

  return candidates.sort((a, b) => b.meanScore - a.meanScore || a.id - b.id);
}

/**
 * Cut the canonically ordered candidates into `sampleSize` contiguous bands and
 * take one from each, seeded. This is the "do not take the top 15" guarantee: the
 * result holds exactly one peer from every band of the score range.
 */
function pickAcrossStrata(candidates: readonly Candidate[], sampleSize: number, seed: number): Candidate[] {
  const nextUint32 = mulberry32(seed);
  const picked: Candidate[] = [];
  let offset = 0;

  for (const size of partitionSizes(candidates.length, sampleSize)) {
    const candidate = candidates[offset + (nextUint32() % size)];
    // Unreachable: the strata partition the candidate list exactly, so every
    // index is in range. Checked rather than asserted because a silent `undefined`
    // here would ship a malformed calibration block to a paying customer.
    if (candidate === undefined) throw new Error('selectCalibrationSample: stratum index out of range');
    picked.push(candidate);
    offset += size;
  }

  return picked;
}

/**
 * `calibration_version`: the category version, then a digest of everything that
 * defines the sample's content — the seed inputs, the sample size, and each
 * selected peer's id, name, text and per-metric scores in the order they appear.
 *
 * Keeping `categoryVersion` in plain sight makes the value legible in a cache key
 * and a log; the digest is what actually guarantees that two different samples
 * never share a version. A peer re-scored by a nightly rebuild changes the digest
 * even if the selection itself is unchanged, which is correct: the anchor moved.
 */
function versionFor(slug: string, categoryVersion: string, sampleSize: number, sample: readonly CalibrationProduct[]): string {
  const canonical = JSON.stringify([
    'calibration',
    slug,
    categoryVersion,
    sampleSize,
    sample.map((peer) => [peer.id, peer.name, peer.description, Object.entries(peer.scores)]),
  ]);
  return `${categoryVersion}:${digest(canonical).slice(0, 16)}`;
}
