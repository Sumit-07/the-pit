/**
 * How far a row moved since the board before this one.
 *
 * ## Why this is allowed to exist at all
 *
 * `brief` Part 6 forbids motion from rank churn, and `brief §1.2` is the reason:
 * appending one product shifts the population mean and standard deviation, so
 * **every** z-score moves and ranks reshuffle for products that did nothing. A
 * board that animated that would be advertising instability as its most
 * eye-catching feature.
 *
 * A static mark is the opposite of that. It does not move, it does not draw the
 * eye, and it says the one thing a reader of a rebuilt board actually wants to
 * know: is this position the same one it was, or did the board move under it.
 * Printing `▼2` beside a row is how the page stops pretending the number is
 * stable — it is `§1.2` written on the surface instead of hidden by it.
 *
 * ## Pure, and deliberately ignorant of where the two boards came from
 *
 * This module imports nothing. It takes two lists of `(key, rank)` and returns
 * what changed. The current board is a snapshot the read path already holds; the
 * previous one is a lookup that only a deployment with a database can make
 * (`lib/boards/pg-history.ts`), and in filesystem mode there is exactly one
 * snapshot, so `previous` is `undefined` and NOTHING is rendered. A dash against
 * every row of a board that has no history would be a claim — "held its
 * position" — about a comparison that was never made.
 *
 * ## Four answers, and the fourth is the interesting one
 *
 *   up      the row climbed; `by` is how many places
 *   down    the row fell
 *   same    the row is where it was
 *   new     the row was not on the previous board at all
 *
 * `new` is the only one that is not arithmetic, and it is the one that carries
 * the feature: a row absent from the previous snapshot is a product that landed
 * between the two boards. A row that has LEFT — present before, gone now — gets
 * no entry, because there is no row on this board to draw it against. That is a
 * deliberate omission rather than an oversight: a board is what is on it.
 */

/** What happened to one row's position between two boards. */
export type RankMovement =
  | { readonly kind: 'up'; readonly by: number }
  | { readonly kind: 'down'; readonly by: number }
  | { readonly kind: 'same' }
  | { readonly kind: 'new' };

/** One row of a board, reduced to the two fields a comparison needs. */
export interface RankedKey {
  /** Stable across rebuilds. The engine's product id, not the rank. */
  readonly key: number;
  /** 1-based board position. */
  readonly rank: number;
}

/**
 * What moved, keyed by product.
 *
 * `previous` of `undefined` — no earlier board to compare against — returns an
 * empty map, so a surface renders nothing rather than a row of dashes claiming a
 * stability nobody checked.
 */
export function rankMovement(
  current: readonly RankedKey[],
  previous: readonly RankedKey[] | undefined,
): ReadonlyMap<number, RankMovement> {
  const moved = new Map<number, RankMovement>();
  if (previous === undefined) return moved;

  const before = new Map<number, number>();
  for (const row of previous) before.set(row.key, row.rank);

  for (const row of current) {
    const was = before.get(row.key);
    if (was === undefined) {
      moved.set(row.key, { kind: 'new' });
      continue;
    }
    // A SMALLER rank is a better position, so climbing is `was - rank`.
    const delta = was - row.rank;
    moved.set(row.key, delta === 0 ? { kind: 'same' } : delta > 0 ? { kind: 'up', by: delta } : { kind: 'down', by: -delta });
  }
  return moved;
}

/**
 * The mark itself: three characters at most, in the row's own mono.
 *
 * `—` and not "held" or a blank, because the three states have to be
 * distinguishable at a glance in a 38px column, and an empty cell is already
 * taken — it means "no previous board", which is a different fact from "did not
 * move".
 */
export function movementText(movement: RankMovement): string {
  switch (movement.kind) {
    case 'up':
      return `▲${movement.by}`;
    case 'down':
      return `▼${movement.by}`;
    case 'new':
      return 'new';
    default:
      return '—';
  }
}

/**
 * The same fact in words, for the `title` and for a screen reader.
 *
 * The glyph is not an accessible name: `▲3` announces as "black up-pointing
 * triangle three", and a reader who cannot see the colour has no other way to
 * tell a climb from a fall. Every place the mark is drawn states this beside it.
 */
export function movementTitle(movement: RankMovement): string {
  switch (movement.kind) {
    case 'up':
      return `Up ${movement.by} since the last board.`;
    case 'down':
      return `Down ${movement.by} since the last board.`;
    case 'new':
      return 'Not on the last board.';
    default:
      return 'Same place as the last board.';
  }
}

/** The class that colours it. Teal climbed, vermilion fell, neither for the rest. */
export function movementClass(movement: RankMovement): string {
  return `mv mv-${movement.kind}`;
}
