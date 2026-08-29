/**
 * The merit composite — `01 §6.1` (`compute_composite`, `rank_final.py:55`).
 *
 * ```
 * For each juror jl:
 *   For each metric m:
 *     v[i]   = the juror's 0-100 score for product i on m   (missing -> 50.0)
 *     z[i]   = (v[i] - mean_i v) / popstd_i v                (popstd == 0 -> 0)
 *     composite[i] += weight_jl[m] * z[i]
 * composite[i] /= juror_count
 * ```
 *
 * Per-juror z happens BEFORE combining. That is guardrail 3 in `01 §1`: it
 * cancels any constant offset between a harsh juror and a lenient one, so a
 * juror who scores the whole category 10 points lower than the rest changes
 * nobody's rank. It also means merit is fully independent of demand and
 * uniqueness — no model call ever sees or produces a rank (Global Constraint 1);
 * every number here is arithmetic over stored raw rows.
 */

import { SCORE_CLAMP_DEFAULT } from '../config/constants.js';
import type { JurorWeights, ScoreLogEntry } from '../types.js';
import { mergeScoreLog } from './score-log.js';
import { clampScore, standardize } from './stats.js';

/**
 * `01 §6.1` `_normalize_weights`: normalize a juror's weights to sum 1 over the
 * metric names it is keyed by. Negatives (and non-finite values) become 0; an
 * all-zero vector becomes uniform `1 / len`.
 *
 * The uniform fallback matters: a juror whose weights all collapse to zero still
 * votes, with an equal say on every metric, rather than silently dropping out
 * and leaving the composite divided by a juror count it no longer reflects.
 */
export function normalizeWeights(weights: Readonly<Record<string, number>>): Map<string, number> {
  const names = Object.keys(weights);
  const normalized = new Map<string, number>();
  if (names.length === 0) return normalized;

  const cleaned = names.map((name) => {
    const weight = weights[name];
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0;
  });

  let total = 0;
  for (const weight of cleaned) total += weight;

  if (total <= 0) {
    const uniform = 1 / names.length;
    for (const name of names) normalized.set(name, uniform);
    return normalized;
  }

  names.forEach((name, index) => normalized.set(name, (cleaned[index] ?? 0) / total));
  return normalized;
}

/**
 * The merit composite per product, keyed by product id.
 *
 * `productIds` is passed explicitly rather than inferred from the score log so
 * that a product no juror returned still gets a composite: every one of its
 * scores defaults to 50.0, which lands it wherever the 50-line falls on each
 * metric. Inferring the set would instead make an unscored product disappear
 * from the board, which is a silent partial delivery.
 *
 * `juror_count` is the number of DISTINCT juror roles present in the score log,
 * not the size of `jury`. A juror whose call failed contributes nothing and is
 * not counted; dividing by the full jury size instead would scale every
 * composite by the same factor, which `z_merit` would standardize straight back
 * out but which would understate `discrimination` in the health block.
 *
 * @throws if the score log carries a juror role the jury does not define (the
 * installed jury is authoritative for weights, `01 §4` Step 6), or if
 * `productIds` contains a duplicate.
 */
export function computeComposite(
  scoreLog: readonly ScoreLogEntry[],
  jury: readonly JurorWeights[],
  productIds: readonly number[],
): Map<number, number> {
  const composite = new Map<number, number>();
  for (const id of productIds) {
    if (composite.has(id)) {
      throw new Error(`computeComposite: duplicate product id ${id} in productIds`);
    }
    composite.set(id, 0);
  }
  if (productIds.length === 0) return composite;

  const jurors = mergeScoreLog(scoreLog);
  if (jurors.length === 0) return composite;

  const weightsByRole = new Map(jury.map((juror) => [juror.role, juror.weights]));

  for (const juror of jurors) {
    const weights = weightsByRole.get(juror.role);
    if (weights === undefined) {
      throw new Error(
        `computeComposite: score log carries juror role "${juror.role}", ` +
          `which the installed jury does not define (jury roles: ` +
          `${jury.map((entry) => entry.role).join(', ') || '<none>'})`,
      );
    }

    for (const [metric, weight] of normalizeWeights(weights)) {
      const raw = productIds.map((id) =>
        clampScore(juror.rows.get(id)?.get(metric)?.score, SCORE_CLAMP_DEFAULT),
      );
      const z = standardize(raw);
      productIds.forEach((id, index) => {
        composite.set(id, (composite.get(id) ?? 0) + weight * (z[index] ?? 0));
      });
    }
  }

  const jurorCount = jurors.length;
  for (const id of productIds) composite.set(id, (composite.get(id) ?? 0) / jurorCount);
  return composite;
}
