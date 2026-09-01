/**
 * The one function that freezes a verdict document.
 *
 * ## Why it is here rather than inside the seed builder
 *
 * It used to be a private function in `seed/build.ts`, and that was correct while
 * the only verdicts in existence were the cold-start ones: `brief` Part 7's
 * seeded boards were the only thing that had ever been "delivered".
 *
 * A paid delivery freezes exactly the same document, at the moment the board is
 * republished, inside the transaction `brief §2.3` describes. Two freezers would
 * be two answers to "what did we say to this customer" — and the difference would
 * be invisible, because both produce a page that renders. `apps/web`'s
 * `parseVerdict` reads ONE shape; this module is the only thing that writes it,
 * for the seed and for the money path alike.
 *
 * ## What goes in it, and why each thing is frozen rather than looked up
 *
 * `brief` Part 6 enumerates the card: "every deduction with its reason and the
 * juror who made it", the cluster the product was judged inside, which Floor
 * personas picked it — plus Part 5's timestamp and product count. `RankedProduct`
 * already carries the first three (`scorecard` with per-role deductions,
 * `cluster`, `demand_detail.picks`), so the row is embedded WHOLE rather than
 * projected, which would drop a field the moment the engine adds one.
 *
 * The board-level context around it is the part that cannot be recovered later.
 * `DECISIONS.md §1.2` moves every z-score on the next placement, so without
 * `product_count` and `issued_at` a rank of 4 is a number with no denominator.
 * The version stamps make the page auditable against the panels that produced it
 * (`brief §1.3`).
 *
 * `weights` is included because `core` is a blend of merit and demand and the
 * page shows the blend; `health` is not, because it is a statement about the
 * PANEL rather than about this product, it is already frozen on the snapshot row,
 * and copying it onto 48 verdicts would make one board's quality metrics 48 rows
 * that could disagree.
 *
 * `demand_roster_size` is the denominator a `demand_detail.picks` count needs to
 * mean anything: "5 personas picked you" reads as a strong result or a weak one
 * depending on whether the roster was 6 or 40, and the row on its own carries
 * only the numerator. `01 §6.2`'s `capture = |picked_personas| / P` computes
 * exactly this `P` — the number of personas that RETURNED CHOICES for the run,
 * not merely the number installed on the category's panel — and `rank/demand.ts`
 * discards the count once it folds it into `capture`. It is recovered from
 * `ranking.personas`, the run's own frozen roster, rather than from a panel read
 * live off disk, which can have drifted since this board was produced.
 *
 * It is a category-level fact, not a per-product one — the same value on every
 * verdict this board issues — which is why it lives beside `product_count` rather
 * than inside `row`. A `solo_cluster` row carries it too even though nothing
 * renders it: the Floor never convened for that product, so there is no numerator
 * to divide, and `DECISIONS.md` S3 is what the verdict page states instead.
 *
 * `comparison` is the newest thing frozen here, and the reason it can be is worth
 * stating where the freezing happens. `DECISIONS.md §1.2` forbids a verdict page
 * from FETCHING a baseline — every z-score moves on the next placement, so a
 * baseline read at render time would make a shared link change under its reader.
 * It does not forbid freezing one. This product's cluster peers and the category's
 * own middle are both facts about the board being delivered, known at this
 * instant, and frozen at this instant they are as permanent as the rank beside
 * them. `verdict-comparison.ts` carries the derivation and the honesty rules;
 * this module's only job is to put it in the document.
 *
 * The table refuses UPDATE, so no verdict issued before that key existed will
 * ever grow one. `apps/web/src/lib/verdict/charts.ts` reads its absence as "there
 * is no comparison" and draws no overlay, which is the truth about those pages.
 *
 * `panel` is frozen for the same reason and with the same consequence.
 * `verdict-panel.ts` carries the argument: a jury is versioned and a mandate can
 * be revised, so a page that read the CURRENT panel file at render time would
 * start describing jurors who are not the ones who cut this product. The mandate
 * that judged you is part of your verdict. A verdict frozen before this key
 * existed carries no biography and the page draws the spoke without one.
 */

import type { Jury, Ranking } from '@the-pit/engine';

import type { PeerIdentityResolver } from './verdict-comparison.js';
import { freezeComparison } from './verdict-comparison.js';
import { freezePanel } from './verdict-panel.js';

/** One row of a delivered board. `Ranking['ranking'][number]`, named. */
export type RankedRow = Ranking['ranking'][number];

/** A verdict for a product that is not on the board it was issued against. */
export class VerdictRowMissingError extends Error {
  override readonly name = 'VerdictRowMissingError';
  readonly engineId: number;

  constructor(engineId: number) {
    super(
      `no ranked row for product ${engineId} on this board. A verdict is a claim about a product's ` +
        'position on a board (brief Part 5), so one cannot be frozen for a product the board does not ' +
        'rank — that would be a permanent public page stating a rank nothing produced.',
    );
    this.engineId = engineId;
  }
}

/**
 * The document a verdict page renders, frozen.
 *
 * `issuedAt` is the instant the board was generated, which is the same instant
 * `verdicts.delivered_at` carries: the row is written inside the transaction that
 * marks the job delivered (`brief §2.3`), so a verdict that claimed a different
 * time from the board it describes would be describing a board that never existed.
 */
/** What only a caller holding the run's own artifacts can add to the document. */
export interface VerdictPayloadContext {
  /**
   * Who the cluster peers may be named as. Optional so the delivery path is
   * untouched; `verdict-comparison.ts`'s default withholds every name, which is
   * the fail-safe direction for a document that can never be updated.
   */
  readonly identity?: PeerIdentityResolver;
  /**
   * The installed jury, for the juror biographies frozen onto each spoke.
   *
   * Optional because there is no juror roster on a `Ranking` and only a caller
   * that loaded `cjr/references/jurors/<slug>.json` has one — the seed builder
   * does; the paid delivery path holds a store and a board and does not. A
   * payload frozen without it carries no juror biography, and
   * `apps/web/src/lib/verdict/page.ts` draws the spoke without one rather than
   * reading the current file, which would describe a panel that has since moved.
   */
  readonly jury?: Jury;
}

export function verdictPayload(
  ranking: Ranking,
  row: RankedRow,
  categorySnapshotVersion: string,
  issuedAt: Date,
  context: VerdictPayloadContext = {},
): Record<string, unknown> {
  return {
    category: ranking.category,
    category_type: ranking.type,
    /**
     * Delivered without a name or a URL.
     *
     * Derived from the row rather than passed in, because the row IS the answer:
     * an anonymous listing reaches this function already wearing its designation
     * and with its address blanked, and `products.url` is `NOT NULL` while the
     * engine's `Product.url` is required — so an empty address in a delivered row
     * can only have come from a redaction.
     *
     * It is frozen here with everything else, and that is what stops a shared
     * link from ever starting to name a product: `verdicts` is append-only, so
     * an owner who later claims their listing and chooses to be named changes
     * FUTURE boards and cannot reach back into a verdict issued anonymously.
     */
    anonymous: row.url === '',
    product_count: ranking.ranking.length,
    issued_at: issuedAt.toISOString(),
    category_snapshot_version: categorySnapshotVersion,
    prompt_version: ranking.prompt_version,
    persona_version: ranking.demand_version,
    uniqueness_version: ranking.uniqueness_version,
    weights: ranking.weights,
    metrics: ranking.metrics,
    demand_roster_size: ranking.personas.length,
    comparison: freezeComparison(ranking, row, context.identity),
    panel: freezePanel(ranking, context.jury),
    verdict: row,
  };
}

/**
 * The frozen document for ONE product of a delivered board, by engine id.
 *
 * Throws rather than returning `undefined` when the board does not rank the
 * product. Every caller is on the delivery path, where the alternative to a
 * verdict is not "no verdict" but "an attempt consumed for nothing": the engine
 * re-ranks the whole category on a placement (`brief §1.2`), so a placed product
 * missing from the ranking means the re-rank did not include the thing that was
 * paid for, and that must stop the transaction rather than be skipped.
 */
export function verdictPayloadFor(
  ranking: Ranking,
  engineId: number,
  categorySnapshotVersion: string,
  issuedAt: Date,
  context: VerdictPayloadContext = {},
): Record<string, unknown> {
  const row = ranking.ranking.find((candidate) => candidate.id === engineId);
  if (row === undefined) throw new VerdictRowMissingError(engineId);
  return verdictPayload(ranking, row, categorySnapshotVersion, issuedAt, context);
}
