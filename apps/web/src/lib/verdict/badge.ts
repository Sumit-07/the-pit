/**
 * The README badge for one verdict.
 *
 * A shields.io-shaped shield, drawn by hand: two flat square-cornered segments,
 * the mark on the left and the claim on the right. It is the smallest surface the
 * verdict has, and the only one that renders inside somebody else's document.
 *
 * ## Why it is drawn here and not fetched
 *
 * shields.io would serve this from a query string, and then a README's badge
 * would depend on a third party being up and would carry a rank this app did not
 * write. Every number on the shield comes off the frozen payload — `rank`,
 * `productCount`, `category` and the health derived from `cuts` — which is the
 * same rule the page and the OG card follow (`DECISIONS.md §1.2`): the board
 * moves on every placement, and a badge pinned in a README months ago must keep
 * saying what it said when it was pasted.
 *
 * ## Never promise a rank
 *
 * `brief` Part 5 forbids a bare rank. A 20px shield has no room for a timestamp,
 * so the rank travels with its **product count** — `#7 of 48` is not a promise,
 * it is a position in a stated field — and the badge links to the page, where the
 * stamp is. `title` says the same thing again for a screen reader.
 *
 * ## Fonts, and why the width is arithmetic
 *
 * There is no external font and no `<style>`: a badge is fetched cross-origin by
 * GitHub's image proxy, which strips both. `ui-monospace,Menlo,monospace` is
 * whatever the reader's machine calls its terminal face, and the glyphs of a
 * monospace family at a given size are all one width — so the label's pixel width
 * is `characters × advance`, computed rather than measured. `CHAR` is that advance
 * at `FONT`, rounded up, so a face slightly wider than the estimate still lands
 * inside its segment.
 *
 * ## Escaping
 *
 * The category label and the numbers are payload text going into XML. `&<>"` are
 * replaced before any of it reaches the document; a product whose category
 * contained `</text>` would otherwise write elements into the badge that GitHub
 * would happily serve.
 */

import type { Verdict } from './model';

/** `--pit`: the site's ground, and the shield's left segment. */
const GROUND = '#1a1610';
/** `--card`: one step up, so the two segments separate without a border. */
const PANEL = '#29241c';
/** `--cut`: the founder's vermilion. The mark, and nothing else. */
const MARK = '#f45c33';
/** `--ink`. */
const INK = '#ede6de';
/** `--held`: survived. The health figure is the only number on the shield in it. */
const HELD = '#3e9c86';

/** Shield height, shields.io's flat proportion. */
const H = 20;
/** The claim's size. */
const FONT = 11;
/** The health figure's, which is a footnote to the claim beside it. */
const SMALL = 9;
/** Advance of one glyph at `FONT` in a typical monospace face, rounded up. */
const CHAR = 6.7;
/** Advance at `SMALL`. */
const CHAR_SMALL = 5.5;
/** Breathing room either side of a segment's text. */
const PAD = 9;
/** Between the claim and the health figure. */
const GAP = 8;

/** `&<>"` — the four that can leave a text node or an attribute in XML. */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The three strings the shield sets, before any of them is escaped. */
export interface BadgeFields {
  /** `THE PIT`. */
  readonly mark: string;
  /** `#7 of 48 · Developer Tools`. Never a rank alone (`brief` Part 5). */
  readonly claim: string;
  /** `71 health`. */
  readonly health: string;
  /** The `<title>`, which is what a screen reader and GitHub's alt fallback read. */
  readonly title: string;
}

const MARK_TEXT = 'THE PIT';

/**
 * What the shield says.
 *
 * Health is `100 - cuts`, clamped and rounded, exactly as the page's health meter
 * computes it — one definition of "what survived", read off the same frozen
 * `cuts`.
 */
export function badgeFields(verdict: Verdict): BadgeFields {
  const health = Math.round(100 - Math.max(0, Math.min(100, verdict.cuts)));
  const claim = `#${verdict.rank} of ${verdict.productCount} · ${verdict.category}`;
  return {
    mark: MARK_TEXT,
    claim,
    health: `${health} health`,
    title: `The Pit — ${claim}, ${health} health left`,
  };
}

/** `width` of a run of monospace text at a given advance, plus nothing else. */
function textWidth(text: string, advance: number): number {
  return Math.ceil(text.length * advance);
}

/** The mark's segment. One string, so one width. */
const LEFT_W = PAD * 2 + textWidth(MARK_TEXT, CHAR);

/** Baseline: the cap height of an 11px face centred in a 20px band. */
const BASE = 14;

/**
 * How wide the shield will be.
 *
 * Exported because the page previews the badge in an `<img>` beside the button
 * that copies it, and an `<img>` without an intrinsic width either reflows the
 * row when it loads or is squashed by a guess. One arithmetic, used by the
 * drawing and by the tag that displays it.
 */
export function badgeWidth(verdict: Verdict): number {
  const fields = badgeFields(verdict);
  return (
    LEFT_W + PAD * 2 + textWidth(fields.claim, CHAR) + GAP + textWidth(fields.health, CHAR_SMALL)
  );
}

/**
 * The badge, as a complete SVG document.
 *
 * `role="img"` with a `<title>` rather than an `aria-label`: the title is read by
 * assistive technology when the SVG is inlined AND is what a browser shows on
 * hover, so one element does both jobs.
 */
export function badgeSvg(verdict: Verdict): string {
  const fields = badgeFields(verdict);

  const left = LEFT_W;
  const width = badgeWidth(verdict);
  const right = width - left;
  const base = BASE;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" `,
    `viewBox="0 0 ${width} ${H}" role="img" aria-labelledby="t">`,
    `<title id="t">${escapeXml(fields.title)}</title>`,
    `<rect width="${left}" height="${H}" fill="${GROUND}"/>`,
    `<rect x="${left}" width="${right}" height="${H}" fill="${PANEL}"/>`,
    `<g font-family="ui-monospace,Menlo,monospace" font-size="${FONT}">`,
    `<text x="${PAD}" y="${base}" fill="${MARK}" font-weight="700" letter-spacing="0.5">`,
    `${escapeXml(fields.mark)}</text>`,
    `<text x="${left + PAD}" y="${base}" fill="${INK}">${escapeXml(fields.claim)}</text>`,
    `<text x="${width - PAD}" y="${base}" fill="${HELD}" font-size="${SMALL}" text-anchor="end">`,
    `${escapeXml(fields.health)}</text>`,
    '</g></svg>',
  ].join('');
}

/**
 * The shield for a slug that resolves to nothing.
 *
 * Served with a 404, so a README that pins a URL which stops resolving shows
 * something honest rather than a broken-image glyph. No payload, so nothing to
 * escape.
 */
export function notFoundBadgeSvg(): string {
  const label = 'not found';
  const right = PAD * 2 + textWidth(label, CHAR);
  const width = LEFT_W + right;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" `,
    `viewBox="0 0 ${width} ${H}" role="img" aria-labelledby="t">`,
    '<title id="t">The Pit — no verdict at this url</title>',
    `<rect width="${LEFT_W}" height="${H}" fill="${GROUND}"/>`,
    `<rect x="${LEFT_W}" width="${right}" height="${H}" fill="${PANEL}"/>`,
    `<g font-family="ui-monospace,Menlo,monospace" font-size="${FONT}">`,
    `<text x="${PAD}" y="${BASE}" fill="${MARK}" font-weight="700" letter-spacing="0.5">${MARK_TEXT}</text>`,
    `<text x="${LEFT_W + PAD}" y="${BASE}" fill="${INK}">${label}</text>`,
    '</g></svg>',
  ].join('');
}
