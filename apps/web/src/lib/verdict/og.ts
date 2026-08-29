/**
 * What the share card says.
 *
 * `brief` Part 6 names the four things a verdict's OG image must carry: the
 * name, the cuts total, the rank, and the sharpest juror line. This module
 * derives all four as plain strings and nothing else — no image, no React, no
 * font. That split is deliberate:
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
import { stampTime } from './page';

/** The share card, as strings. */
export interface OgFields {
  /** `THE PIT · VERDICT · DEVELOPER TOOLS` */
  readonly eyebrow: string;
  /** The product name, as submitted, trimmed to fit. */
  readonly name: string;
  /** `97` — the cuts total, rounded, as the card's one big number. */
  readonly cuts: string;
  /** `took 97 in cuts` — the connective word (`brief` Part 5) spelled out. */
  readonly cutsLabel: string;
  /**
   * `7 of 48 products · 27 Aug 2026, 14:03 UTC`.
   *
   * Never just `7`. `brief` Part 5: "Never promise a rank in copy. The verdict
   * card is stamped with a timestamp and product count precisely because the
   * board moves."
   */
  readonly rank: string;
  /** The sharpest juror's reason, trimmed. Empty when nothing came off the card. */
  readonly quote: string;
  /** `The Practitioner · −19 on Trust Surface`. Empty when there is no quote. */
  readonly attribution: string;
  /** `3rd pitch` (`brief §2.4`), or empty on an unclaimed listing. */
  readonly pitch: string;
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

/** Room on the card. Read off the 1200x630 layout in the route. */
const NAME_LIMIT = 58;
const QUOTE_LIMIT = 150;

/** The card's copy for one verdict. */
export function ogFields(verdict: Verdict): OgFields {
  const sharpest = verdict.sharpest;

  return {
    eyebrow: `THE PIT · VERDICT · ${verdict.category.toUpperCase()}`,
    name: trimTo(verdict.name, NAME_LIMIT),
    cuts: String(Math.round(verdict.cuts)),
    // The number never travels alone: `brief` Part 5 fixes the connective word,
    // and this is the surface it travels furthest on.
    cutsLabel: `took ${Math.round(verdict.cuts)} in cuts`,
    rank: `${verdict.rank} of ${verdict.productCount} products · ${stampTime(verdict.issuedAt)}`,
    quote: sharpest === null ? '' : trimTo(sharpest.reason, QUOTE_LIMIT),
    attribution: sharpest === null ? '' : `${sharpest.role} · −${sharpest.points} on ${sharpest.metric}`,
    pitch: verdict.pitchLabel ?? '',
  };
}
