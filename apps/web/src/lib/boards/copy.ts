/**
 * `brief` Part 5, verbatim, in one place.
 *
 * Every one of these strings is fixed by the brief. They are constants rather
 * than literals inside a component because Part 5 is a specification, not a
 * suggestion: "You can't outbid the pit" is the headline, not a headline, and a
 * surface that paraphrased it would be wrong in a way no reviewer would notice
 * from a diff of JSX. Naming them makes a reworded homepage a failing test.
 *
 * Two rules ride along with the words and are enforced by the surfaces that use
 * them:
 *
 * 1. **The connective word is `cuts`.** Part 5: "Keep it on every surface — it's
 *    the one thread that runs from the loud homepage to the plain verdict page."
 *    The board's primary column is Cuts, the row leads with the cut that hurt
 *    most, and the ledger is a list of cuts. `CUTS_SENTENCE` is the Part 5
 *    example of the register, kept here so the phrasing has one home.
 * 2. **Never name outbid directly, and never promise a rank.** Part 5 again: the
 *    dig lands for anyone who knows and stands alone for anyone who doesn't, and
 *    "the verdict card is stamped with a timestamp and product count precisely
 *    because the board moves". Nothing in this file names a competitor, and
 *    nothing anywhere promises a position — `STAMP_NOTE` is the sentence that
 *    says so out loud on every board footer.
 *
 * Voice, per Part 5: aggressive on the homepage, plain everywhere behind it. The
 * homepage strings shout. The board strings do not.
 */

/** The five fixed strings. Changing any of them is a brand change, not an edit. */
export const COPY = {
  /** `brief` Part 5 — Headline. */
  headline: "You can't outbid the pit.",
  /** `brief` Part 5 — Sub. */
  sub: 'Everyone walks in at 100. Fewest cuts wins.',
  /** `brief` Part 5 — Terms line. */
  terms: "$5 to enter. That's all money does here.",
  /** `brief` Part 5 — CTA. */
  cta: 'Throw it in · $5',
  /** `brief` Part 5 — Closer. */
  closer: 'Throwing money in the pit just makes noise.',
} as const;

/**
 * The headline, split where the founder's `the-pit-home.html` splits it.
 *
 * The second half carries `--blade`. Joined with a space the two halves are
 * `COPY.headline` exactly, which is what the test asserts — the split is a type
 * treatment and may not become a rewrite.
 */
export const HEADLINE_PARTS = ["You can't outbid", 'the pit.'] as const;

/** The closer, split the same way. `CLOSER_PARTS.join(' ') === COPY.closer`. */
export const CLOSER_PARTS = ['Throwing money in the pit', 'just makes noise.'] as const;

/**
 * The register Part 5 fixes for talking about a score: "Runlet took 97 in cuts."
 *
 * Used by the board, so the one sentence a reader meets on every product reads
 * the same on the homepage row, the category board and (later) the verdict page.
 */
export function cutsSentence(name: string, cuts: number): string {
  return `${name} took ${Math.round(cuts)} in cuts.`;
}

/**
 * What the board says about its own permanence.
 *
 * `brief` Part 5: never promise a rank. `brief §1.2`: appending a product shifts
 * the population mean and standard deviation, so **every** existing z-score
 * changes and ranks reshuffle on every placement. The footer says that in words
 * next to the timestamp and the product count, which is the only honest way to
 * publish a leaderboard that is rebuilt under the reader.
 */
export const STAMP_NOTE =
  'No rank here is permanent. The board is rebuilt on every placement, which is why this line carries a time and a product count.';

/** The category board's one-line explanation of what a row is. Leads with the cut, not the number. */
export const BOARD_LEDE =
  'Open a row for the ledger: every cut, the reason it was taken, and the juror who took it.';

/**
 * The homepage's version, which has a different job.
 *
 * Homepage rows do not open — the ledger is on the category board — so the line
 * says what the row *is* rather than inviting a click that does nothing. It also
 * has to disarm the one number a reader can misread: the big red figure on the
 * lead is a single juror's deduction, while the Cuts column is what came off the
 * whole card. Those are different quantities and the page says so rather than
 * hoping nobody notices.
 */
export const HOME_LEGEND =
  'Every row leads with the cut that hurt most and the juror who took it. Cuts is what came off the whole card. The full board has the rest.';

/**
 * The solo-cluster explanation, stated once.
 *
 * 32 of 48 Developer Tools products and 26 of 44 Health, Fitness & Wellness
 * products have no cluster peers. `brief §1.6` calls this out as a thing to
 * watch, not a thing to hide: it is a stated property of the board, and a row
 * that carries it is not in an error state.
 */
export const SOLO_NOTE =
  'no buyers were shown this one beside a substitute, so there was no forced choice to run and the rank is merit alone';
