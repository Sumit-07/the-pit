/**
 * Balanced chunking for the merit scoring pass — `the-pit-build-brief.md` §1.4.
 *
 * A juror scores at most `CHUNK_SIZE` products per call (`01 §5.1`). The naive
 * split — fill chunks to 40 and let the last one take the remainder — is a
 * DEFECT, not a style preference:
 *
 *   n = 44, chunkSize 40  ->  [40, 4]
 *
 * `01 §5.1` has each juror start every metric at 100 and deduct against the peers
 * in front of it, so a chunk IS the comparison set. The 4-product chunk is scored
 * against 3 peers while the 40-product chunk is scored against 39, and the two
 * halves of one category then arrive on different scales. `01 §6.1` z-normalizes
 * a juror's scores across all products afterwards, which does not undo the damage
 * — it standardizes a mixture of two populations as if it were one.
 *
 * The fix (brief §1.4) fixes the chunk COUNT first and divides evenly into it:
 *
 *   k     = ceil(n / maxSize)        the fewest calls that respect the cap
 *   sizes = n split as evenly as possible over k chunks
 *
 * so n = 44 splits 22/22, and every product in the category is judged against a
 * comparison set of the same size. The call count is identical to the naive
 * split, so the correction is free: it costs nothing and removes a systematic
 * scale difference between chunks.
 *
 * Pure arithmetic. No I/O, no model, no rank (Global Constraint 1).
 */

import { CHUNK_SIZE } from '../config/constants.js';

/**
 * Split `n` into `parts` sizes that are as equal as possible and sum to exactly
 * `n`. The first `n % parts` sizes are one larger than the rest.
 *
 * The remainder rule is the whole reason this is a named function rather than a
 * multiplication: `ceil(n / k)` describes the LARGEST chunk, and handing every
 * chunk that size overshoots. n = 45 over 2 chunks is `[23, 22]` — sizes must
 * sum to exactly `n` or the pass silently drops or double-scores a product, and
 * a double-scored product would appear twice in one juror's comparison set.
 *
 * `parts === 0` is only reachable from `n === 0` and yields `[]`.
 *
 * Shared with the calibration sampler (`src/panels/calibration.ts`), which
 * stratifies a candidate list into exactly `CALIBRATION_SAMPLE` bands and needs
 * the identical "sums to exactly n" guarantee.
 */
export function partitionSizes(n: number, parts: number): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`partitionSizes: n must be a non-negative integer, got ${n}`);
  }
  if (!Number.isInteger(parts) || parts < 0) {
    throw new RangeError(`partitionSizes: parts must be a non-negative integer, got ${parts}`);
  }
  if (parts === 0) {
    if (n !== 0) throw new RangeError(`partitionSizes: cannot split ${n} items into 0 parts`);
    return [];
  }

  const base = Math.floor(n / parts);
  const remainder = n % parts;
  const sizes: number[] = [];
  for (let index = 0; index < parts; index += 1) sizes.push(index < remainder ? base + 1 : base);
  return sizes;
}

/**
 * The chunk sizes for scoring `n` products with a cap of `maxSize` per call.
 * `the-pit-build-brief.md` §1.4: `ceil(n / ceil(n / maxSize))`-sized chunks.
 *
 * Worked cases from the brief and `docs/plans/phase-1-engine.md` Task 4:
 *
 *   n=44 -> k=ceil(44/40)=2 -> [22, 22]     (NOT [40, 4])
 *   n=48 -> k=ceil(48/40)=2 -> [24, 24]
 *   n=13 -> k=ceil(13/40)=1 -> [13]
 *   n=80 -> k=ceil(80/40)=2 -> [40, 40]     (an exact fill stays an exact fill)
 *   n=81 -> k=ceil(81/40)=3 -> [27, 27, 27]
 *
 * Decided edge cases:
 *
 * - **n = 0** -> `[]`. Zero products is zero calls, so there is nothing to
 *   chunk. `ceil(0 / maxSize)` is 0, and returning `[0]` would book a scoring
 *   call with an empty product list. (Ingest refuses a category under
 *   `MIN_PRODUCTS` long before this, so n = 0 only reaches here from a caller
 *   chunking an already-filtered subset.)
 * - **n = 1** -> `[1]`. One call for one product. Note that a chunk of one is
 *   exactly the isolated-scoring situation brief §1.1 exists to correct: the
 *   incremental path must supply a calibration sample, and chunking cannot
 *   substitute for it.
 * - **n not divisible by k** (e.g. n=45, maxSize=40) -> `[23, 22]`. Sizes always
 *   sum to exactly `n`, largest chunks first, and no chunk ever exceeds
 *   `maxSize` because `ceil(n/ceil(n/maxSize)) <= maxSize`.
 *
 * `n` must be a non-negative integer and `maxSize` a positive integer; anything
 * else throws rather than silently producing a wrong number of calls.
 */
export function balancedChunks(n: number, maxSize: number = CHUNK_SIZE): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`balancedChunks: n must be a non-negative integer, got ${n}`);
  }
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError(`balancedChunks: maxSize must be a positive integer, got ${maxSize}`);
  }

  return partitionSizes(n, Math.ceil(n / maxSize));
}

/**
 * Split a list into balanced chunks, preserving order. The convenience wrapper
 * around `balancedChunks` that the scoring pass (Task 7) actually calls, so the
 * offset arithmetic that turns sizes into slices lives in one place instead of
 * being re-derived per caller.
 *
 * The concatenation of the result is always the input, element for element: no
 * product is dropped and none is scored twice.
 */
export function chunkItems<T>(items: readonly T[], maxSize: number = CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  let offset = 0;
  for (const size of balancedChunks(items.length, maxSize)) {
    chunks.push(items.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}
