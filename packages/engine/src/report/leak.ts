/**
 * The leak test: how much of outbid's paid leaderboard survived into our board.
 *
 * ## Why this is measured rather than patched
 *
 * `Product.id` is assigned after sorting by the source sheet's `Rank`
 * (`src/ingest/load-category.ts`), so id order IS the incoming leaderboard order.
 * Task 5's review found the consequences: prompts rendered products in that
 * order, and `balancedChunks` therefore cut rank-contiguous bands, so each chunk
 * was judged against a uniformly strong or uniformly weak field.
 * `src/panels/ordering.ts` fixed that by shuffling on a seed before chunking.
 *
 * What the fix removed is the POSITIONAL signal. What it did not remove is the
 * NUMERIC one: every prompt still prints `[id N]` markers, and `N` is monotone in
 * `orig_rank`, so a model that chose to read the numbers could still recover the
 * incoming order. Remapping display ids was considered and rejected — ids are the
 * join key for the score log, the clusters, the demand log and `ranking.json`
 * alike, and a translation bug that misattributed a score to the wrong product
 * would be far worse than the residual signal.
 *
 * So the size of what remains is a question for measurement, and this is the
 * measurement.
 *
 * ## How to read the number, and how not to
 *
 * A positive correlation is EXPECTED and LEGITIMATE. Products that are genuinely
 * good plausibly rank well in both systems, and outbid's leaderboard is not
 * random noise. This statistic cannot separate "the source ranking leaked into
 * our prompts" from "two panels looked at the same products and agreed", and
 * nothing in this file pretends otherwise: there is no threshold here, no flag,
 * and no verdict. The report states the number, states that limitation, and
 * leaves the judgement to the reader.
 *
 * `id_vs_orig_rank` is printed alongside because it is the exact statement of
 * what the numeric channel carries: it is +1 by construction, and it is the thing
 * a juror would have to be reading for a leak to be possible at all.
 */

import type { Product, RankedProduct } from '../types.js';
import { spearman } from './stats.js';

/** Every correlation the leak test reports, with the population it was taken over. */
export interface LeakReport {
  /** Products carrying a usable `orig_rank`, i.e. the size of every correlation below. */
  n: number;
  /**
   * Spearman(merit composite, `orig_rank`). NEGATIVE means agreement, because a
   * better product has a HIGHER composite and a LOWER `orig_rank` number. This is
   * the statistic `docs/plans/phase-1-engine.md` Task 8 names.
   */
  merit_vs_orig_rank: number;
  /**
   * Spearman(our final rank, `orig_rank`). POSITIVE means agreement — both are
   * 1-is-best positions. Same information as `merit_vs_orig_rank` with the sign
   * the reader expects, and taken over the final board rather than pure merit, so
   * it includes what demand and the uniqueness tilt did.
   */
  final_rank_vs_orig_rank: number;
  /**
   * Spearman(`core`, `orig_rank`). The blended score the board is ordered by,
   * before the tilt. Negative means agreement, as with `merit_vs_orig_rank`.
   */
  core_vs_orig_rank: number;
  /**
   * Spearman(`Product.id`, `orig_rank`). +1 by construction — ids are assigned in
   * `orig_rank` order — and printed so the residual channel is stated rather than
   * described. If this is ever not +1 the ingest changed and the whole framing
   * above needs rereading.
   */
  id_vs_orig_rank: number;
  /**
   * How many of the top ten by `orig_rank` are in our top ten. A blunt,
   * non-statistical companion to the correlations, because a founder reading this
   * once will want one number they can picture.
   */
  top_ten_overlap: number;
  /** The size of that comparison, which is `min(10, n)`. */
  top_ten_size: number;
}

/** The `top_ten_overlap` window. A presentation choice, not a threshold. */
const TOP_WINDOW = 10;

/**
 * Correlate the board against the source sheet's ranking.
 *
 * Only products present in BOTH the board and the product set are used, so a
 * product added after the sheet was ingested — which has no `orig_rank` from the
 * same population — cannot skew the result. `n` reports how many that left.
 */
export function leakReport(rows: readonly RankedProduct[], products: readonly Product[]): LeakReport {
  const origById = new Map(products.map((product) => [product.id, product.orig_rank]));

  const paired = rows.flatMap((row) => {
    const orig = origById.get(row.id);
    return typeof orig === 'number' && Number.isFinite(orig) ? [{ row, orig }] : [];
  });

  const origRanks = paired.map((entry) => entry.orig);
  const window = Math.min(TOP_WINDOW, paired.length);

  const topByOrig = new Set(
    [...paired].sort((a, b) => a.orig - b.orig).slice(0, window).map((entry) => entry.row.id),
  );
  const topByOurs = [...paired].sort((a, b) => a.row.rank - b.row.rank).slice(0, window);

  return {
    n: paired.length,
    merit_vs_orig_rank: spearman(paired.map((entry) => entry.row.composite), origRanks),
    final_rank_vs_orig_rank: spearman(paired.map((entry) => entry.row.rank), origRanks),
    core_vs_orig_rank: spearman(paired.map((entry) => entry.row.core), origRanks),
    id_vs_orig_rank: spearman(paired.map((entry) => entry.row.id), origRanks),
    top_ten_overlap: topByOurs.filter((entry) => topByOrig.has(entry.row.id)).length,
    top_ten_size: window,
  };
}

/**
 * A plain-language reading of `final_rank_vs_orig_rank`, with the caveat attached.
 *
 * Deliberately describes the strength of the agreement and stops. It never uses
 * the word "leak" as a conclusion and never says a number is too high, because
 * this statistic cannot support either claim on its own — see the header.
 */
export function describeLeak(report: LeakReport): string {
  const r = report.final_rank_vs_orig_rank;
  const magnitude = Math.abs(r);
  const strength =
    magnitude < 0.2 ? 'essentially unrelated to' :
    magnitude < 0.4 ? 'weakly related to' :
    magnitude < 0.6 ? 'moderately related to' :
    magnitude < 0.8 ? 'strongly related to' :
    'almost the same as';
  const direction = r >= 0 ? 'agrees with' : 'runs opposite to';

  return (
    `Our board order is ${strength} outbid's (Spearman ${r.toFixed(4)} over ${report.n} products, ` +
    `where +1 is identical and -1 is reversed), and it ${direction} theirs. ` +
    `${report.top_ten_overlap} of our top ${report.top_ten_size} are in theirs. ` +
    'This number cannot on its own separate a leaked source ranking from two panels ' +
    'independently agreeing about the same products — some positive agreement is expected ' +
    'and legitimate. It is stated so the judgement can be made, not so it can be made here.'
  );
}
