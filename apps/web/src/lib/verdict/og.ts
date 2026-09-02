/**
 * What the share card says.
 *
 * `brief` Part 6 names the four things a verdict's OG image must carry: the
 * name, the cuts total, the rank, and the sharpest juror line. This module
 * derives all four — plus the category, the health remaining and the stamp the
 * redrawn card sets in its corners — as plain strings and nothing else: no
 * image, no React, no font. That split is deliberate:
 *
 * - The **content** is where the requirements live, including `brief` Part 5's
 *   rule that a rank never travels without its product count and its timestamp.
 *   A share card is the single most screenshot-able object the product produces,
 *   so an unstamped rank on it is the exact failure Part 5 is about. Content is
 *   therefore pure, offline and tested.
 * - The **rasterisation** lives in the route, because `next/og` resolves only
 *   through the Next bundler — a test that imported it would fail on module
 *   resolution, and the way to keep the requirements tested is to keep them out
 *   of the module that needs a bundler to load.
 *
 * Nothing here escapes anything: these strings are handed to a text layout
 * engine, not to an HTML parser, and escaping for the wrong sink is how `&amp;`
 * ends up rendered on an image. The route is the only consumer, and it sets text
 * as text.
 */

import type { Verdict } from './model';
import { PIT_ORIGIN, stampTime } from './page';

/** The share card, as strings. */
export interface OgFields {
  /** `THE PIT · VERDICT · DEVELOPER TOOLS` */
  readonly eyebrow: string;
  /**
   * `DEVELOPER TOOLS` — the category on its own, for the card's top-right eyebrow.
   *
   * The wordmark occupies the top-left corner and says THE PIT there, so the
   * eyebrow above no longer has to carry the brand as well as the category. Both
   * are kept: `eyebrow` is the one-line form, this is the corner form.
   */
  readonly category: string;
  /** The product name, as submitted, trimmed to fit. */
  readonly name: string;
  /** `97` — the cuts total, rounded. */
  readonly cuts: string;
  /** `took 97 in cuts` — the connective word (`brief` Part 5) spelled out. */
  readonly cutsLabel: string;
  /**
   * `#7` — the rank as the card's biggest element.
   *
   * It is only ever set beside `rankOf` and `stamp`, which is what keeps the
   * layout honest: `brief` Part 5 forbids a rank that travels without its product
   * count and its moment, and there is no field here that supplies one alone.
   */
  readonly rankNumber: string;
  /** `/ 48` — the product count, set small beside `rankNumber`. */
  readonly rankOf: string;
  /**
   * `7 of 48 products · 27 Aug 2026, 14:03 UTC`.
   *
   * Never just `7`. `brief` Part 5: "Never promise a rank in copy. The verdict
   * card is stamped with a timestamp and product count precisely because the
   * board moves."
   */
  readonly rank: string;
  /**
   * `83` — health remaining, rounded, as a percentage of the hundred every
   * product walks in with. The width of the held head of the card's bar, so the
   * route can write `${health}%` and draw the rest in `--cut`.
   */
  readonly health: string;
  /** `83 health left · 17 in cuts` — the bar's caption, both halves of the hundred. */
  readonly healthLine: string;
  /** The sharpest juror's reason, trimmed. Empty when nothing came off the card. */
  readonly quote: string;
  /** `The Practitioner · −19 on Trust Surface`. Empty when there is no quote. */
  readonly attribution: string;
  /** `3rd pitch` (`brief §2.4`), or empty on an unclaimed listing. */
  readonly pitch: string;
  /**
   * `27 Aug 2026 · thepit.show` — the corner stamp.
   *
   * The date without the clock, because at the size this sits on the card the
   * minutes are unreadable and the day is the part that says the board has moved
   * since. `rank` above still carries the full instant.
   */
  readonly stamp: string;
}

/**
 * Trim to `limit` characters on a word boundary, with an ellipsis.
 *
 * A juror reason is one sentence and usually fits; a few run long, and a share
 * card that overflows is a broken share card. Cutting mid-word reads as a
 * rendering fault rather than as a quotation, so the break lands on whitespace
 * when there is any to land on.
 */
export function trimTo(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? head.slice(0, space) : head).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * Room on the card. Read off the 1200x630 layout in the route.
 *
 * The name is set at 48px now that the rank is the biggest thing on the card
 * rather than the cuts total, and the quote shares its band with a health bar,
 * so both fit fewer characters than they used to.
 */
const NAME_LIMIT = 42;
const QUOTE_LIMIT = 132;

/** `https://thepit.show` -> `thepit.show`. One definition of the domain, in `page.ts`. */
const DOMAIN = PIT_ORIGIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/**
 * `27 Aug 2026, 14:03 UTC` -> `27 Aug 2026`.
 *
 * Derived from `stampTime` rather than formatted again here, so the card and the
 * page cannot come to disagree about which day a verdict was issued.
 */
function stampDay(iso: string): string {
  return (stampTime(iso).split(',')[0] ?? '').trim();
}

/** The card's copy for one verdict. */
export function ogFields(verdict: Verdict): OgFields {
  const sharpest = verdict.sharpest;
  const cuts = Math.round(verdict.cuts);
  // The other half of the same hundred, and it is derived from the SAME rounded
  // cuts total the card prints — `100 - 16.6` rounded is 83 while `round(16.6)`
  // is 17, and a card whose two halves add up to 100 in prose but not in
  // arithmetic is a card arguing with itself.
  const health = 100 - cuts;

  return {
    eyebrow: `THE PIT · VERDICT · ${verdict.category.toUpperCase()}`,
    category: verdict.category.toUpperCase(),
    name: trimTo(verdict.name, NAME_LIMIT),
    cuts: String(cuts),
    // The number never travels alone: `brief` Part 5 fixes the connective word,
    // and this is the surface it travels furthest on.
    cutsLabel: `took ${cuts} in cuts`,
    rankNumber: `#${verdict.rank}`,
    rankOf: `/ ${verdict.productCount}`,
    rank: `${verdict.rank} of ${verdict.productCount} products · ${stampTime(verdict.issuedAt)}`,
    health: String(health),
    healthLine: `${health} health left · ${cuts} in cuts`,
    quote: sharpest === null ? '' : trimTo(sharpest.reason, QUOTE_LIMIT),
    attribution: sharpest === null ? '' : `${sharpest.role} · −${sharpest.points} on ${sharpest.metric}`,
    pitch: verdict.pitchLabel ?? '',
    stamp: `${stampDay(verdict.issuedAt)} · ${DOMAIN}`,
  };
}
