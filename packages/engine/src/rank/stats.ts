/**
 * The statistical primitives every part of `01 §6` is built from.
 *
 * Global Constraint 7 (`docs/plans/phase-1-engine.md`): **population** standard
 * deviation (divide by N), never sample std, everywhere. `01 §6` calls this
 * `_pop_std`. A sample std would divide by N-1 and quietly inflate every z-score
 * by `sqrt(N/(N-1))` — on a 44-product category that is ~1.2%, which is small
 * enough to never look wrong and large enough to move a rank.
 */

/**
 * The fixed endpoints of the 0-100 raw scale that jurors, the uniqueness pass,
 * and personas all answer on. `01 §6` guards every raw value with
 * `_clamp(x, 0, 100, default=50)`.
 *
 * These are not tunable weights, so they are not in the frozen constants table
 * (`docs/plans/phase-1-engine.md`): they are the domain of the scale itself.
 * Changing either would not re-weight the algorithm, it would mean the model
 * outputs were on a different scale entirely.
 */
export const RAW_SCORE_MIN = 0;
export const RAW_SCORE_MAX = 100;

/** Arithmetic mean. Empty input is 0, so an empty spread list contributes nothing. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Population standard deviation (divide by N). `01 §6` `_pop_std`. */
export function popStd(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const centre = mean(values);
  let sumSquares = 0;
  for (const value of values) {
    const deviation = value - centre;
    sumSquares += deviation * deviation;
  }
  return Math.sqrt(sumSquares / values.length);
}

/**
 * Population z-scores across the whole input list.
 *
 * `popstd == 0 -> z = 0` (`01 §6.1`): when every product scored alike there is
 * no information on that axis, so it must contribute nothing rather than divide
 * by zero. This is the reason a unanimous jury cannot move a board.
 */
export function standardize(values: readonly number[]): number[] {
  const centre = mean(values);
  const spread = popStd(values);
  if (spread === 0) return values.map(() => 0);
  return values.map((value) => (value - centre) / spread);
}

/**
 * `01 §6`'s `_clamp(x, 0, 100, default=<fallback>)`: guard a raw model-returned
 * value. A missing, non-numeric, or non-finite value becomes `fallback`; an
 * out-of-range number is pulled back onto the 0-100 scale.
 *
 * The fallback differs by call site and each one is a named constant:
 * `SCORE_CLAMP_DEFAULT` for a juror metric score, `STRENGTH_DEFAULT` for a
 * persona's conviction, `UNIQ_NEUTRAL` for a scarcity score.
 */
export function clampScore(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < RAW_SCORE_MIN) return RAW_SCORE_MIN;
  if (value > RAW_SCORE_MAX) return RAW_SCORE_MAX;
  return value;
}
