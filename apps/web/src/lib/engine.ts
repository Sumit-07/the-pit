/**
 * The app's one door onto `@the-pit/engine`.
 *
 * `PHASE-0.md §3` fixes the direction of the dependency: "`packages/engine` never
 * imports from `apps/web`. The engine is a library the pipeline calls, so the
 * whole ranking path stays runnable from a local CLI — which is what makes
 * disputes reproducible later."
 *
 * Keeping the import in one module rather than scattering it across routes is
 * what makes that checkable. It is also the seam that keeps a Node-only library
 * off the client: everything here is server-side, and `next.config.ts` lists the
 * engine as an external package so its `node:fs`, `node:crypto`, `exceljs` and
 * SDK dependencies are required at runtime rather than bundled.
 *
 * Nothing in this file computes anything. Ranking arithmetic lives in
 * `packages/engine/src/rank/` and stays there.
 */

import {
  CHUNK_SIZE,
  DEMAND_W,
  ENGINE_VERSION,
  JUROR_COUNT,
  MERIT_W,
  UNIQ_LAMBDA,
  previewCacheKey,
  type PreviewCacheKeyInput,
} from '@the-pit/engine';

/**
 * The constants a surface is allowed to render, echoed in one place so a page
 * never hard-codes `0.65` next to a number the engine computed with something
 * else.
 */
export const ENGINE = {
  /** "The Six" — `DECISIONS.md` S1, which supersedes `01 §4`'s five. */
  jurors: JUROR_COUNT,
  /** `core = MERIT_W * z(merit) + DEMAND_W * z(demand)` — `01 §7.1`. */
  meritWeight: MERIT_W,
  demandWeight: DEMAND_W,
  /** The bounded scarcity tilt kept by `DECISIONS.md` S2. */
  uniquenessLambda: UNIQ_LAMBDA,
  /** Products per scoring call — `01 §7.2`, with `brief §1.4`'s balancing. */
  chunkSize: CHUNK_SIZE,
  /** The build that produced a stored run (`brief` Part 7's integrity record). */
  version: ENGINE_VERSION,
} as const;

/**
 * `brief §1.3`'s cache key, re-exported so the free preview surface (Phase 5)
 * cannot invent its own.
 *
 * The defect it fixes: a preview cached on the description hash alone serves a
 * rank that was true against a board that no longer exists, because `brief §1.2`
 * has every z-score move on every placement.
 */
export function cacheKeyForPreview(input: PreviewCacheKeyInput): string {
  return previewCacheKey(input);
}
