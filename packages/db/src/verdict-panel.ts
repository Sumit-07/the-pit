/**
 * The mandate that judged you, frozen with everything else on the verdict.
 *
 * ## Why this is frozen and not read at render
 *
 * The verdict page could load `cjr/references/jurors/<slug>.json` at render time
 * and have every juror's biography for free. That is the same mistake
 * `DECISIONS.md §1.2` forbids for the rank, one level up: a panel is VERSIONED
 * (`01 §4` Step 2 bumps `prompt_version` by hand on any edit, and the personas
 * carry their own `persona_version`), a mandate can be revised, and a juror can
 * be replaced. A page that read the CURRENT panel would start describing jurors
 * who are not the ones who cut this product — a permanent public URL quietly
 * re-attributing its own sentences.
 *
 * The mandate that judged you is part of your verdict. So it is frozen at
 * delivery, in the same document as the rank, the timestamp and the comparison,
 * and it can no more drift than they can.
 *
 * ## Why the buyers are always here and the jurors are not
 *
 * `Ranking` carries `personas` — the run's own frozen roster, full `Persona`
 * objects (`01 §6.6`) — so a buyer's mandate is already inside the document this
 * module is handed and is frozen on every path, paid and seeded alike.
 *
 * There is no juror roster on a `Ranking`: `packages/engine/src/types.ts` carries
 * `metrics` and `personas` and nothing else about the panel, which is why
 * `verdict-comparison.ts` has to RECOVER the juror order from the board. The
 * installed jury is a file, and only a caller holding it can supply one — the
 * seed builder does, the paid delivery path (`apps/web/src/lib/pipeline/run.ts`)
 * holds a store and a board and never the jury. So `jurors` is empty on a
 * verdict frozen without one, exactly as `comparison` is absent on a verdict
 * frozen before comparisons existed, and the page renders the spoke with no
 * biography rather than inventing one.
 *
 * ## What is NOT frozen
 *
 * `voice` — how a juror writes — and `weights` — what the ranking math reads.
 * Neither answers "who is this and what do they punish", which is the whole
 * question a reader hovering a spoke is asking, and both would grow a document
 * that is written once per product per board for text no surface renders.
 */

import type { Jury, PriceSensitivity, Ranking } from '@the-pit/engine';

/**
 * One juror, as the spoke that carries their name is allowed to describe them.
 *
 * Snake-cased to match the installed jury file and `JurorMandate`, so the frozen
 * document and the artifact it came from never need translating between each
 * other. These are model-written prose fields and are escaped at render like
 * every other string on the page.
 */
export interface FrozenJurorMandate {
  /** The roster key. Matches `JurorWeights.role` and every deduction's `role`. */
  readonly role: string;
  readonly who: string;
  readonly cares_most: string;
  readonly biased_against: string;
}

/** One synthetic buyer, as the spoke that carries their name may describe them. */
export interface FrozenBuyerMandate {
  /** The roster key. Matches `Persona.name` and every pick's `persona`. */
  readonly name: string;
  readonly description: string;
  readonly needs: readonly string[];
  readonly price_sensitivity: PriceSensitivity;
}

/**
 * The panel that produced this verdict, frozen.
 *
 * Both lists are in INSTALLED ORDER, which is the order the radials draw their
 * axes in — but the page joins on `role` and `name` rather than on position, so a
 * panel frozen in a different order than the axes were recovered in still finds
 * the right biography and a juror with no entry simply has none.
 */
export interface FrozenPanel {
  /** Empty when the freezing caller held no installed jury. Never a guess. */
  readonly jurors: readonly FrozenJurorMandate[];
  readonly buyers: readonly FrozenBuyerMandate[];
}

/**
 * The mandate behind every axis of both radials.
 *
 * `jury` is optional for the reason the module comment gives: only a caller that
 * loaded the installed jury can supply one, and the alternative to an empty list
 * is a biography this module invented.
 */
export function freezePanel(ranking: Ranking, jury?: Jury): FrozenPanel {
  return {
    jurors: (jury?.jurors ?? []).map((juror) => ({
      role: juror.role,
      who: juror.who,
      cares_most: juror.cares_most,
      biased_against: juror.biased_against,
    })),
    buyers: ranking.personas.map((persona) => ({
      name: persona.name,
      description: persona.description,
      needs: [...persona.needs],
      price_sensitivity: persona.price_sensitivity satisfies PriceSensitivity,
    })),
  };
}
