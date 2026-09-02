/**
 * The verdict page, as one self-contained HTML document.
 *
 * ## Why a string and not a component
 *
 * `brief` Part 6 requires the page to be **downloadable**. A document with no
 * external stylesheet, no font host and no script is downloadable by
 * construction: the file the customer saves is the page they were looking at,
 * and it still renders with the machine offline in five years. That is the same
 * decision `packages/engine/src/board/page.ts` made for the board and
 * `apps/web/src/lib/auth/pages.ts` made for the magic-link screens, and this
 * follows both.
 *
 * It also means the page carries no `<script>` tag, and the figures below are
 * held to that: the heatmap's hover readouts, the bar tooltips, the spoke
 * biographies, the ledger's blocks and the table views are CSS, native focus and
 * native `<details>`, so a copy saved to disk is as interactive as the served
 * page. `test/verdict-page.test.ts` asserts the absence of a `<script` tag,
 * which is the rule stated as a test rather than as a habit.
 *
 * The one exception is the share row's copy button, which carries an inline
 * `onclick` and no script block — see `lib/verdict/share.ts`. It degrades to a
 * button that does nothing, and the sentence it would have copied is on the page
 * above it either way, so nothing on this document is reachable only through it.
 *
 * ## A scorecard, not an essay
 *
 * The audit that produced this shape measured the previous page at 1440px and
 * found a 675px column with its paragraphs set in 10px mono, the rank a mid-size
 * numeral under a robot, and the two things a founder actually screenshots — the
 * harshest cut and the warmest buyer quote — at positions two and nine. The order
 * is now the order somebody reads it in:
 *
 * 1. **The header.** Identity, then the rank as the hero number with a one-line
 *    sub that says where on the board that is. The health bar under it: the
 *    `--held` head the product walked out with, and each metric's exact `--cut`
 *    share of what came off, heaviest first. Then the two lines — sharpest cut on
 *    a `--cut` rail, warmest buyer on a `--held` one — and the share row, which
 *    is `lib/verdict/share.ts`'s.
 * 2. **The scorecard.** Five metric bars on one shared 0–100 axis: the merged
 *    score as the `--held` head, the loss as the `--cut` remainder, the frozen
 *    category median as a tick, and the cross-juror spread as an ink whisker.
 * 3. **The panel and the buyers**, as four figures in two rows. *Who hurt me*
 *    (the jury radial) beside *where* (the juror × metric heatmap); *who wanted
 *    me* (the buyers radial) beside *why they said so* (their quotes, with the
 *    conviction each put behind a first choice). Hovering, tabbing to or tapping
 *    a spoke says who that juror or buyer is, out of the frozen panel.
 * 4. **The cluster** it was judged inside, and for the 32 of 48 rows that are a
 *    cluster of one, the fact that nothing was close enough to compare it to.
 * 5. **The ledger**, one `<details>` per metric, heaviest first, the first one
 *    open. Every deduction is still in the document with the juror who took it —
 *    `brief` Part 6 — and collapsing is not hiding: there is no fetch behind the
 *    control, so a saved copy, a printed copy and Ctrl-F all reach every line.
 * 6. **The footer**: the frozen stamp, the version ids, the download.
 *
 * Every figure with an axis points the same way — further out, further along, is
 * a better card — so the page does not reverse under a reader scrolling it. The
 * heatmap is the documented exception and plots what was TAKEN; `matrixFigure`
 * argues it in full. `charts.ts`'s `FIGURE_PAINT` records each figure's direction
 * beside the selectors that paint it, and `test/verdict-polarity.test.ts` fails
 * when the two disagree.
 *
 * ## One rail, and one caption
 *
 * Every block sits on the same left and right edges inside a 1100px measure, and
 * every inner surface insets by the same 18px. Prose is the sans at 15px and mono
 * is for numbers, labels and stamps only: 10px mono paragraphs are what made this
 * page read as a terminal dump. No caption runs past one line, and every "why we
 * did it this way" clause has been cut — the argument for a figure belongs in
 * this file, not on the page a customer paid for.
 *
 * ## Where the design comes from
 *
 * `lib/theme.ts`, the same values and two families every other surface uses,
 * interpolated into this document so a saved copy carries its own theme.
 *
 * Every painted figure sits in a `--sunk` well rather than on a `--card` face.
 * That is not styling: the accent ramp's lowest step clears the 2:1 floor against
 * `--pit` (2.10:1) and `--sunk` (2.30:1) and fails it against `--card` (1.80:1),
 * measured with the data-viz skill's own validator. A well is also the theme's
 * existing idiom for a track of taken points, so the check and the house style
 * agree.
 *
 * ## Voice
 *
 * `brief` Part 5: "aggressive on the homepage, plain everywhere behind it". This
 * is behind it. The connective word `cuts` is the one thing that carries over —
 * "Runlet took 97 in cuts" — and it appears in the headline, the summary line and
 * the share text.
 *
 * ## Never promise a rank
 *
 * `brief` Part 5 again. Every rank on this page is rendered by `stampedRank`,
 * which cannot emit a rank without the product count and the timestamp beside it.
 * The past tense is not decoration: the board has moved since, by design
 * (`DECISIONS.md §1.2`).
 *
 * ## Escaping
 *
 * Product names, URLs and juror reasons are user-submitted or model-written text.
 * `escapeHtml` is `@the-pit/auth`'s — the same function the magic-link email and
 * the auth pages use, so there is one answer to what escaping means in this app —
 * and every interpolation of payload text goes through it. `data-block.ts`
 * documents the `<<< >>>` delimiter stripping applied upstream; that is a prompt
 * safety measure, not an HTML one, and this page does not rely on it.
 */

import { escapeHtml } from '@the-pit/auth';

import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

import {
  buyerRadial,
  CUT_RAMP,
  cutMatrix,
  demandChart,
  juryRadial,
  lossChart,
  rampLabel,
  type AxisMandate,
  type CutMatrix,
  type MatrixCell,
  type Radial,
  type RadialSeries,
} from './charts';
import type { Verdict, VerdictMetric } from './model';
import { renderShareRow } from './share';

/** `brief` Part 5: the domain. Used when a caller does not supply the request's origin. */
export const PIT_ORIGIN = 'https://thepit.show';

export interface RenderOptions {
  /** Absolute origin for canonical, share and download links. Defaults to `PIT_ORIGIN`. */
  readonly origin?: string;
}

/** `1.2345` -> `1.23`. */
function n2(value: number): string {
  return value.toFixed(2);
}

/** `6.2421` -> `6.2`. */
function n1(value: number): string {
  return value.toFixed(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-08-27T14:03:00Z` -> `27 Aug 2026, 14:03 UTC`.
 *
 * UTC and never local: the stamp is a claim about when the board was, and a
 * reader in another timezone must not see a different one from the person who
 * shared it.
 */
export function stampTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? '???'} ${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/**
 * `2026-08-27T14:03:00Z` -> `27 Aug 2026`.
 *
 * The date the header byline carries. UTC for the same reason `stampTime` is: the
 * stamp is a claim about when the board was, and a reader in Auckland must not see
 * a different day from the person who shared it. The full instant is in the
 * footer, which is where a dispute is argued from.
 */
export function stampDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? '???'} ${date.getUTCFullYear()}`;
}

/**
 * A rank that cannot be rendered alone.
 *
 * `brief` Part 5: "**Never promise a rank in copy.** The verdict card is stamped
 * with a timestamp and product count precisely because the board moves." One
 * function emits both, so there is no code path on this page that prints a rank
 * without them. Past tense, for the same reason.
 */
export function stampedRank(verdict: Verdict): string {
  return `${verdict.rank} of ${verdict.productCount} products on ${stampTime(verdict.issuedAt)}`;
}

/** `brief` Part 5's connective word, as a sentence. Rounded, because cuts are read not audited. */
export function cutsLine(verdict: Verdict): string {
  return `${verdict.name} took ${Math.round(verdict.cuts)} in cuts.`;
}

/**
 * `brief` Part 4: "B2B boards can say 'The Panel' and 'The Buyers' where consumer
 * boards say 'The Six' and 'The Floor'. Same data, register that fits the room."
 */
export function panelLabels(verdict: Verdict): { jury: string; floor: string; buyers: string } {
  return verdict.categoryType === 'b2b'
    ? { jury: 'The Panel', floor: 'The Buyers', buyers: 'buyers' }
    : { jury: 'The Six', floor: 'The Floor', buyers: 'buyers' };
}

/**
 * Metric names come off the installed jury and are not written for a reader:
 * Developer Tools has `Problem Sharpness`, Health & Fitness has `claim_backing`.
 * A display transform only — the raw name rides in the `title` attribute and
 * nothing downstream ever sees the prettified form.
 */
function metricLabel(name: string): string {
  const text = name.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Only `http(s)` becomes an href. Anything else is printed as text, never as a link. */
function productLink(url: string): string {
  const safe = /^https?:\/\//i.test(url);
  return safe
    ? `<a class="plink" href="${escapeHtml(url)}" rel="nofollow noopener noreferrer">${escapeHtml(url)}</a>`
    : `<span class="plink">${escapeHtml(url)}</span>`;
}

/**
 * The site's typeface, and the one external reference on the page.
 *
 * One sans and one mono, from `lib/theme.ts`, which is what `app/layout.tsx`
 * loads for every React surface — so a verdict page is not the one screen in the
 * product set in Arial. It is a `<link>` and not a `next/font` import because this
 * document is served by a route handler and has to be a single file.
 *
 * It does not cost the page its offline guarantee: every family in `CSS` is
 * declared with a real local fallback stack, so a saved copy on a machine with no
 * network loses its typeface and nothing else. There is still no script, no image
 * and no stylesheet the layout depends on.
 */
const FONTS = FONT_LINKS;

const CSS = `${TOKENS}${BASE}
/*
 * 1100px, not 820. The audit measured the old page at 1440 and found "a 675px
 * column on a 1440px screen, with paragraphs set in 10px mono" — two thirds of
 * the screen empty and the important numbers the same size as the footnotes.
 * The measure widened so the two figures that answer "who hurt me" and "where"
 * can sit side by side and still be read, which is the whole shape of this page.
 */
.wrap{max-width:1100px}
/* Prose is the sans at 15px. Mono is for numbers, labels and stamps and for
   nothing else — 10px mono paragraphs are what made this page read as a
   terminal dump rather than as a scorecard. */
p{font-size:15px;line-height:1.6}
.lede{font-size:15px;max-width:70ch}

/* ---------- the header: identity, rank, health, the two lines, the share row ---------- */
.vhead{background:var(--card);border:1px solid var(--line);border-radius:var(--r3);
  box-shadow:var(--lip),var(--e1);padding:22px 24px 20px;margin-top:14px}
.vid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px 26px;align-items:start}
.vwho{display:flex;align-items:center;gap:14px;min-width:0}
/* The plate. A robot for an anonymous listing, a mono initial for a named one —
   no hue either way, because an identity painted --cut or --held would read as
   a score. */
.vfav{flex:0 0 auto;width:46px;height:46px;display:grid;place-items:center;overflow:hidden;
  background:var(--sunk);border:1px solid var(--hair);
  box-shadow:inset 0 1px 3px rgb(var(--shade-c) / .55);
  font-family:var(--mono);font-size:17px;font-weight:600;color:var(--dimmer)}
.vfav svg{display:block;width:100%;height:100%}
.vname{min-width:0}
.vhead h1{font-weight:700;font-size:clamp(21px,2.6vw,27px);line-height:1.12;
  letter-spacing:-.024em;overflow-wrap:anywhere}
.vcat{display:block;margin-top:5px;font-family:var(--mono);font-size:10.5px;font-weight:500;
  letter-spacing:.12em;text-transform:uppercase;color:var(--dimmer)}
.vurl{display:block;margin-top:7px}
.plink{font-family:var(--mono);font-size:11px;color:var(--dimmer);
  text-decoration:none;overflow-wrap:anywhere}
a.plink:hover{color:var(--ink);text-decoration:underline}
/* The hero number. Mono, because it is a measurement, and tabular so a #1 and a
   #14 sit on the same right edge. It never appears without its denominator. */
.vrank{text-align:right;justify-self:end}
/* The hash is a marker and the number is the hero, so they are not the same
   size. That is also what fixes the collision: IBM Plex Mono's hash has long
   horizontal bars that fill almost its whole advance, and at 56px beside a 1
   the rank read as a struck-through digit. */
.vrank b{display:block;font-family:var(--mono);font-size:clamp(40px,5.4vw,56px);font-weight:500;
  line-height:.95;font-variant-numeric:tabular-nums;white-space:nowrap}
.vrank b u{text-decoration:none;font-size:.5em;color:var(--dimmer);vertical-align:.42em;
  margin-right:.04em}
.vrank b i{font-style:normal;font-size:.4em;color:var(--dimmer)}
.vrank small{display:block;margin-top:7px;font-family:var(--mono);font-size:10.5px;
  letter-spacing:.09em;text-transform:uppercase;color:var(--dimmer)}
.pitch{display:inline-block;margin-top:8px;font-family:var(--mono);font-size:10px;font-weight:600;
  letter-spacing:.12em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);
  padding:3px 9px}

/* The meter is lib/theme.ts's, unmodified — the same .row / .kept / .seg
   structure and the same two hues. Taller here, with the two readouts under it. */
.vbar{margin-top:20px}
.vbar .meter{height:12px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
.vbar .meter .seg.s6{background:rgb(var(--cut-c) / .58)}
.vbarlbl{display:flex;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;margin-top:9px;
  font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dimmer)}
.vbarlbl .held,.vbarlbl .pts{font-size:11px;letter-spacing:.06em}

/* The two lines a founder screenshots: the sharpest cut and the warmest buyer.
   One rail each, in the hue that says which it is. */
.vlines{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:20px}
.vlines .ln{background:var(--rise);border-left:3px solid var(--line);padding:13px 16px;
  font-size:15px;line-height:1.45;color:var(--ink);box-shadow:var(--lip)}
.vlines .ln.c{border-left-color:var(--cut)}
.vlines .ln.h{border-left-color:var(--held)}
.vlines .ln small{display:block;margin-top:9px;font-family:var(--mono);font-size:10.5px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--dimmer)}
@media (max-width:760px){.vlines{grid-template-columns:1fr}}

/* The share row. lib/verdict/share.ts writes the controls; this dresses them.
   Two of them are <button> and two are <a>, because two copy and two navigate —
   so .sact resets the three things a button brings that an anchor does not (its
   own font, its own background, its own border) and both then land on the same
   object. This rule set is the row's only styling: it is written into the
   document, not into pit.css, because a saved copy carries no stylesheet. */
.share-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:20px}
.share-row .sact{font:inherit;font-size:12.5px;line-height:1;color:var(--dim);
  background:none;border:1px solid var(--line);padding:9px 13px;text-decoration:none;
  cursor:pointer;transition:border-color .15s ease,color .15s ease,background-color .15s ease}
/* Hover lifts to the ink and the next surface up, which is what every other
   control on this page does. Not the accent: --cut means taken and --held means
   survived, and a button that turns vermilion when a pointer crosses it spends
   the one hue that has a meaning on a thing that has none. */
.share-row .sact:hover,.share-row .sact:focus-visible{color:var(--ink);
  background:var(--rise);border-color:var(--dimmer)}
/* Copying swaps a 17-character label for a 6-character one. A floor keeps the
   rest of the row from sliding sideways when it does. */
.share-row .sact[data-copy]{min-width:148px;text-align:center}
.share-row .sbadge{display:block;height:20px;width:auto;max-width:100%}
/* The narrow-screen half of this rule set is at the bottom with the page's one
   other 560px block. One block per breakpoint: two of them is how a reader ends
   up applying only the first they find. */

/* ---------- the evidence ---------- */
/*
 * The ledger, one <details> per metric, heaviest first, the first one open.
 *
 * Thirty deductions in a flat list is the long tail of this page: every line is
 * evidence and none of it is what a reader came for. Collapsing per metric keeps
 * every deduction in the document — nothing is dropped and nothing is fetched —
 * while the page stops opening on its own footnotes. Native <details>, so a saved
 * copy expands with no script.
 */
.ledger{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--lip),var(--e1);margin-top:10px}
.ledger > summary{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  flex-wrap:wrap;padding:13px 18px;cursor:pointer;list-style:none}
.ledger > summary::-webkit-details-marker{display:none}
.ledger > summary:hover{background:var(--rise)}
.ledger > summary:focus-visible{outline-offset:-2px}
.ledger .mt{font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.ledger .mt::before{content:"+";font-family:var(--mono);font-weight:600;color:var(--dimmer);
  margin-right:9px}
.ledger[open] .mt::before{content:"\\2212"}
.ledger .sc{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;
  color:var(--dimmer);white-space:nowrap;margin-left:auto}
.ledger .body{padding:0 18px 15px}
.ded{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;font-size:14.5px;
  line-height:1.5;color:var(--dim);margin-top:11px;padding-top:11px;border-top:1px solid var(--hair)}
.ledger .body > .ded:first-child{border-top:0;margin-top:2px;padding-top:0}
.ded .pts{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;
  color:var(--cut);font-weight:600;text-align:right;padding-top:1px}
.ded .who{font-family:var(--mono);font-size:11px;color:var(--dimmer);white-space:nowrap}
.subs{font-family:var(--mono);font-size:11px;color:var(--dim);margin-top:12px;
  padding:8px 10px;background:var(--sunk);border-radius:var(--r1)}

.pick{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;font-size:14px;
  line-height:1.5;color:var(--dim);margin-top:11px}
.pick .p{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--pit);background:rgb(var(--ink-c) / .86);
  border-radius:999px;padding:3px 8px;white-space:nowrap;align-self:start}
.pick .p.second{background:transparent;color:var(--dim);border:1px solid var(--line)}
.pick .who{font-family:var(--mono);font-size:11px;color:var(--dimmer)}
.dnums{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;overflow-wrap:anywhere;
  color:var(--dimmer);margin-top:14px;padding-top:11px;border-top:1px solid var(--hair)}

.notfound{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--lip),var(--e1);padding:28px;margin-top:24px;font-size:14px;line-height:1.7;color:var(--dim)}

/* ---------- figures ---------- */
/*
 * Every painted mark on this page lives in a WELL — --sunk, the one surface below
 * everything else. The reason is measured: the accent ramp's lowest step clears
 * the data-viz skill's 2:1 ordinal floor against --sunk (2.30:1) and --pit
 * (2.10:1) and fails it against --card (1.80:1). It is also the theme's existing
 * idiom, the meter track: a groove of points that were taken.
 */
/*
 * The padding is .well's and .blk's, to the pixel, and that is the
 * alignment fix rather than a preference. This surface used to inset its
 * content by 14px while every other block on the page inset by 18 and the
 * ledger by 17, so a heatmap column, a ledger deduction and a cluster paragraph
 * each started on a different vertical — three inner rails inside one 784px
 * measure, off by four pixels, which is exactly the kind of drift that reads as
 * "strange" without being nameable. One rail now.
 */
.fig{margin-top:16px}
.well2{background:var(--sunk);border:1px solid var(--hair);border-radius:var(--r2);
  padding:16px 18px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
/* One line, in the sans. It was 10.5px mono running to a hundred words, which is
   most of what made this page read as a terminal dump rather than a scorecard. */
.figcap{font-family:var(--sans);font-size:13px;line-height:1.55;color:var(--dim);
  margin-top:11px}
.figcap b{color:var(--ink);font-weight:600}
/* The one sentence a figure owes beyond its caption: what the outlines ARE, or
   which cell was the deepest. Quieter than the caption, because it is a fact
   about this card rather than an instruction for reading the chart. */
.figcap.rnote{font-size:12px;color:var(--dimmer);margin-top:8px}
.mxfig{margin-top:0}
.rside{margin-top:0}

/* ---------- the juror x metric matrix ---------- */
/*
 * A CSS grid rather than an SVG: the cells are text as well as fill, they must
 * wrap their own headers, and the hover readout is a positioned element that a
 * viewBox would have had to fake. The 2px grid gap IS the surface gap the mark
 * spec asks for — the separation is the well showing through, never a stroke
 * drawn around a cell.
 */
/*
 * The grid lives in half the measure now, so the row header gives up what the
 * columns need. A column has to hold the longest single WORD in a metric name —
 * CAPABILITY and DURABILITY, ten characters — because overflow-wrap:anywhere
 * broke them mid-word into DURABILIT / Y the moment the column narrowed. Ten
 * characters of mono at 9px with .04em tracking is 58px, so the column floor is
 * 62 and the header only breaks between words.
 */
.mxgrid{display:grid;gap:2px;
  grid-template-columns:minmax(130px,1fr) repeat(var(--cols),minmax(62px,1fr))}
.mxch{font-family:var(--mono);font-size:9px;font-weight:600;letter-spacing:.04em;
  text-transform:uppercase;color:var(--dimmer);line-height:1.35;padding:0 2px 6px;
  align-self:end;text-align:center;overflow-wrap:normal}
.mxch b{display:block;font-weight:600;color:var(--dim);font-variant-numeric:tabular-nums;
  letter-spacing:.02em;margin-top:3px}
.mxrh{display:flex;flex-direction:column;justify-content:center;gap:2px;padding:4px 8px 4px 0;
  font-size:12px;line-height:1.25;color:var(--ink);overflow-wrap:anywhere}
.mxrh em{font-style:normal;font-family:var(--mono);font-size:9.5px;color:var(--dimmer);
  font-variant-numeric:tabular-nums;letter-spacing:.02em}
.mxc{position:relative;display:flex;align-items:center;justify-content:center;min-height:36px;
  font-family:var(--mono);font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;
  color:#FFFBF6;background:rgb(var(--ink-c) / .05)}
/* Steps 1-3 take the near-white ink (8.30 / 6.30 / 4.78 against the fill), steps
   4-5 take the deepest surface (5.22 / 6.73). Every in-cell number clears 4.5:1
   on its own fill, chosen by the fill's luminance rather than by preference. */
.mxc.k1{background:${CUT_RAMP[0]}}
.mxc.k2{background:${CUT_RAMP[1]}}
.mxc.k3{background:${CUT_RAMP[2]}}
.mxc.k4{background:${CUT_RAMP[3]};color:var(--sunk)}
.mxc.k5{background:${CUT_RAMP[4]};color:var(--sunk)}
.mxc.k0{color:var(--faint);font-weight:400}
.mxc.ksub{background:transparent;border:1px dashed rgb(var(--ink-c) / .30);
  color:var(--dimmer);font-size:9.5px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.mxc[tabindex]{cursor:default}
.mxc:hover,.mxc:focus,.mxc:focus-visible{z-index:8}
.tip{position:absolute;left:-2px;top:calc(100% + 7px);z-index:9;width:max-content;max-width:264px;
  background:var(--rise);color:var(--ink);border:1px solid var(--line);border-radius:var(--r1);
  box-shadow:var(--lip),var(--e3);padding:10px 12px;text-align:left;
  font-family:var(--sans);font-size:12.5px;font-weight:400;line-height:1.5;letter-spacing:0;
  white-space:normal;opacity:0;visibility:hidden;pointer-events:none}
.tip b{display:block;font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;color:var(--cut)}
.tip em{display:block;font-style:normal;font-family:var(--mono);font-size:10.5px;
  color:var(--dimmer);margin:2px 0 7px}
.tip i{display:block;font-style:normal;margin-top:7px}
.mxc:hover .tip,.mxc:focus .tip,.mxc:focus-visible .tip,
.lbrow:hover .tip,.lbrow:focus .tip,.lbrow:focus-visible .tip,
.rspot:hover .tip,.rspot:focus .tip,.rspot:focus-visible .tip{opacity:1;visibility:visible}
.tip.tr{left:auto;right:-2px}
.tip.tu{top:auto;bottom:calc(100% + 7px)}
.mxkey{display:flex;flex-wrap:wrap;gap:7px 15px;margin-top:12px;
  font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.02em}
.mxkey span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.mxkey i{display:inline-block;width:11px;height:11px;flex:0 0 auto}
.mxkey i.k1{background:${CUT_RAMP[0]}}
.mxkey i.k2{background:${CUT_RAMP[1]}}
.mxkey i.k3{background:${CUT_RAMP[2]}}
.mxkey i.k4{background:${CUT_RAMP[3]}}
.mxkey i.k5{background:${CUT_RAMP[4]}}
.mxkey i.k0{background:rgb(var(--ink-c) / .05)}
.mxkey i.ksub{background:transparent;border:1px dashed rgb(var(--ink-c) / .30)}

/* ---------- the two radials ---------- */
/*
 * Emphasis, not a categorical palette. choosing-a-form.md: "one series is the
 * point, the rest are context -> highlight one, gray the rest -> 1 hue + gray".
 * So there is exactly ONE hue per chart, and every context shape is the same
 * de-emphasis grey, told apart by line style, by the legend, and by the table
 * twin underneath.
 *
 * That hue is --held on BOTH radials, and it is not a style choice. The theme
 * spends --cut on what was taken and --held on what survived, and theme-drift
 * tests treat a leak either way as a defect. The jury radial now plots the health
 * each juror LEFT STANDING, so it is a chart of what survived and wears the hue
 * that means survived; painting a health polygon in the colour that means "taken"
 * would say the opposite of its own caption. The buyers radial plots conviction —
 * also a thing the product HAS — and was already --held. Two charts pointing the
 * same way, in the same hue, reading as a pair.
 *
 * The grey is rgb(--ink-c / .36), which composites to #5F5954 over the --sunk
 * well. Run through the data-viz skill's validator against #1a1610 it separates
 * from both hues on every check that governs an emphasis chart: --cut at dE 27.3
 * normal / 14.0 CVD, --held at dE 19.1 / 16.0, both far above the 8 target. Its
 * contrast against the surface is 2.61:1, a WARN whose stated obligation is
 * "visible labels or a table view" — this chart ships both. It fails the
 * categorical lightness band and the chroma floor on purpose: those checks are
 * scoped to categorical palettes, and a de-emphasis grey that passed the chroma
 * floor would be a fifth colour rather than context.
 */
/*
 * The size and the shape of the block, which is one problem and not two.
 *
 * The founder's first complaint was that the radials read as small (R 86 in a
 * 336-wide box: a 182px polygon), and R went to 112 to answer it. R has not
 * moved since and must not: a bad product draws its polygon at a fraction of R
 * (mean health 15.4 is a radius of 0.154R), so shrinking the plot takes back the
 * one thing the enlargement bought.
 *
 * What changed is the PAIRING. The two figures a reader needs together are the
 * jury radial and the cut heatmap — *who* hurt me and *where* — and they used to
 * be four screens apart, each with a column of prose beside it. They now share
 * one grid row above 1000px, half the measure each, and the words under them are
 * one line. The buyers radial takes the row below, half width, with the buyer
 * quote cards beside it, because "who wanted me" and "why they said so" are the
 * same question asked twice.
 *
 * Below 1000px every one of those cells becomes a full-width row in the same
 * order. The SVG scales with its column, so a 390px phone gets a 358px plot
 * rather than a horizontal scrollbar.
 */
/* The pairing: jury radial | cut heatmap. */
.pgrid,.bgrid{display:grid;gap:20px;margin-top:16px;grid-template-columns:minmax(0,1fr);
  align-items:start}
@media (min-width:1000px){
  .pgrid,.bgrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px}
}
.rfig{margin:0}
.rtitle{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--dimmer);margin-bottom:9px}
/*
 * The wrapper is the SVG's own box, not a band it floats in the middle of, and
 * that is load-bearing rather than tidy: the spoke hotspots below are HTML
 * positioned in PERCENTAGES of the viewBox, so the element they are positioned
 * against has to be exactly the element the viewBox is drawn into. Capped,
 * because one hexagon is not worth 700px and 19px axis labels.
 */
.rwrap{position:relative;display:block;width:100%;max-width:560px;margin-inline:auto}
.rwrap svg{display:block;width:100%;height:auto}
/* Gridlines: solid hairlines one step off the surface, never dashed. */
.rring{fill:none;stroke:rgb(var(--ink-c) / .13);stroke-width:1}
.rring.rout{stroke:rgb(var(--ink-c) / .22)}
/*
 * The spokes are fainter than the rings, and that is not taste. A buyer series is
 * mostly zeros with one or two spikes, so its polygon runs from the centre out
 * along a single axis and back — the same line a spoke draws. At equal weight the
 * reader cannot tell a conviction of 90 from the grid. The chart's own marks win.
 */
.rspoke{fill:none;stroke:rgb(var(--ink-c) / .07);stroke-width:1}
.rax{font-family:var(--mono);font-size:9.2px;letter-spacing:.05em;text-transform:uppercase;
  fill:var(--dimmer)}
/* Ring numbers cross the shapes, so they are painted stroke-first in the well's
   own colour: a halo of the surface rather than a box drawn around a label. */
.rtick{font-family:var(--mono);font-size:8.2px;fill:var(--faint);
  stroke:var(--sunk);stroke-width:2.8;paint-order:stroke;stroke-linejoin:round}
/* The one number per spoke. It is the direct label the polygon's area is NOT
   allowed to stand in for, so it is the loudest text in the plot. */
.rax .rv{fill:var(--ink);font-weight:600;font-size:11.2px}
.rax.rmk .rv{fill:var(--dimmer);font-weight:500}
/* A runner-up's qualifier, on its own line under the zero it qualifies. On the
   value line it was fourteen characters of 11.2px type in a 72-unit gutter. */
.rax .rvm{fill:var(--dimmer);font-size:9.2px;font-weight:500}
/* The context shapes: one grey, three line styles. No fill — the filled polygon
   is the emphasis series and nothing else on the chart may claim that weight. */
.rp{fill:none;stroke:rgb(var(--ink-c) / .36);stroke-width:1.6;
  stroke-linejoin:round;vector-effect:non-scaling-stroke}
/* A context vertex, drawn only where the value is above zero: it is what tells a
   spike apart from a spoke. Hollow, so it never competes with the filled self. */
.rpdot{fill:var(--sunk);stroke:rgb(var(--ink-c) / .36);stroke-width:1.4}
.rp.rp2{stroke-dasharray:6 3}
.rp.rp3{stroke-dasharray:2 3}
.rp.rp4{stroke-dasharray:8 3 2 3}
.rp.rmed{stroke-dasharray:1 3;stroke-linecap:round;stroke-width:1.6}
.rself{stroke-width:2;stroke-linejoin:round}
.rdot{stroke:var(--sunk);stroke-width:2}
/* Both charts plot a thing the product HAS — health left, conviction won — so
   both wear --held, the hue that means survived. Never --cut here. */
.rj .rself{fill:rgb(var(--held-c) / .19);stroke:var(--held)}
.rj .rdot{fill:var(--held)}
.rb .rself{fill:rgb(var(--held-c) / .19);stroke:var(--held)}
.rb .rdot{fill:var(--held)}
.rkey{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;
  font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.02em}
.rkey span{display:inline-flex;align-items:center;gap:6px;min-width:0}
.rkey em{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:19ch}
.rkey i{display:inline-block;width:14px;height:0;flex:0 0 auto;
  border-top:2px solid rgb(var(--ink-c) / .36)}
.rkey i.rp2{border-top-style:dashed}
.rkey i.rp3{border-top-style:dotted}
.rkey i.rp4{border-top-style:double;height:3px}
.rkey i.rmed{border-top-style:dotted}
/*
 * Who each outline is, revealed only if the reader asks for it. A shape is a
 * summary; a name beside it is a second product's verdict leaking onto this page,
 * so the default labelling is positional and the identities sit behind a control.
 */
.rwho{margin-top:9px}
.rwho summary{font-family:var(--mono);font-size:10px;color:var(--dimmer);cursor:pointer;
  padding:4px 0;list-style:none;display:inline-flex;align-items:center;gap:6px}
.rwho summary::-webkit-details-marker{display:none}
.rwho summary::before{content:"+";font-weight:600}
.rwho[open] summary::before{content:"\\2212"}
.rwho summary:hover{color:var(--ink)}
.rwho ul{list-style:none;margin-top:5px;display:grid;gap:4px}
.rwho li{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:10.5px;
  color:var(--dim);min-width:0}
.rwho b{font-weight:500;color:var(--dimmer);white-space:nowrap}
.rwho em{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rwho a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.rwho a:hover{border-bottom-color:var(--ink)}
/*
 * The avatar seam. An anonymous peer gets a deterministic robot drawn from its
 * data-avatar-seed attribute; that generator is another module's and this page
 * does not write one. Until it lands the slot holds a neutral placeholder, which
 * is why it is a sized box and not an empty span.
 */
.ravatar{display:inline-block;width:14px;height:14px;flex:0 0 auto;background:var(--card);
  border:1px solid var(--line)}
.rj .rkey i.rself,.rb .rkey i.rself{height:8px;border:0;background:rgb(var(--held-c) / .19);
  box-shadow:inset 0 0 0 2px var(--held)}
/*
 * Progressive enhancement, and nothing depends on it: focusing or hovering a
 * legend entry pushes the other shapes back so one comparison can be isolated
 * without a script. A browser with no :has() support simply does not dim.
 */
.rfig:has(.rk1:hover) :is(.rp,.rpdot):not(.rk1),.rfig:has(.rk1:focus-visible) :is(.rp,.rpdot):not(.rk1),
.rfig:has(.rk2:hover) :is(.rp,.rpdot):not(.rk2),.rfig:has(.rk2:focus-visible) :is(.rp,.rpdot):not(.rk2),
.rfig:has(.rk3:hover) :is(.rp,.rpdot):not(.rk3),.rfig:has(.rk3:focus-visible) :is(.rp,.rpdot):not(.rk3),
.rfig:has(.rk4:hover) :is(.rp,.rpdot):not(.rk4),.rfig:has(.rk4:focus-visible) :is(.rp,.rpdot):not(.rk4)
  {opacity:.14}
.rkey span[tabindex]{cursor:default;border-radius:2px}
/* The focus ring is --ink, not a data hue: nothing inside a chart of what
   survived may be painted in the colour that means taken, chrome included. */
.rkey span[tabindex]:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.rp,.rpdot,.rself{transition:opacity .18s ease}
@media (prefers-reduced-motion:reduce){.rp,.rpdot,.rself{transition:none}}

/* ---------- who the spoke belongs to ---------- */
/*
 * A spoke names a juror or a buyer and used to say nothing about either. The
 * mandate behind it is frozen in the payload (model.ts's VerdictPanel) and
 * revealed here.
 *
 * It is an HTML button laid over the axis label rather than anything inside the
 * SVG, and that is the whole reason .rwrap is a positioned box the drawing
 * exactly fills: a <title> inside an SVG is a browser tooltip nobody can style
 * and no keyboard reaches, and a foreignObject is a scroll container waiting to
 * clip its own contents. A button is focusable, is tappable on a touch screen
 * (which a hover is not), and carries the page's existing .tip.
 *
 * The hotspot is transparent and carries no mark of its own: the axis label
 * underneath is the affordance, and a box drawn around six labels would be six
 * more rectangles on a chart that already has rings and spokes.
 */
.rspot{position:absolute;display:block;padding:0;margin:0;background:none;border:0;
  border-radius:2px;font:inherit;color:inherit;cursor:help;-webkit-appearance:none;appearance:none}
.rspot:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.rspot:hover,.rspot:focus,.rspot:focus-visible{z-index:8}
.rspot .tip{cursor:auto}
/* Wider than a heatmap readout because a mandate is prose, and clamped so it
   stays a tooltip: the full text of every field is in the panel list below the
   chart, which is where a reader who wants all of it goes. */
.rbio{width:272px;max-width:272px}
.rbio b{color:var(--ink);text-transform:none;font-family:var(--sans);font-size:13px;
  letter-spacing:-.01em}
.rbio i{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;
  margin-top:6px;font-style:normal;font-size:12px;line-height:1.5;color:var(--dim)}
/* Who they are gets two lines and what they weigh gets three: the readout is a
   glance at the person behind a number, and the untruncated mandate is two
   inches below it in the panel list. */
.rbio i:first-of-type{-webkit-line-clamp:2}
.rbk{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--dimmer);margin-right:6px}
/*
 * The same content, in the DOM, with no pointer involved.
 *
 * The page already ships a table twin for every figure because identity by
 * colour or by shape is not identity; a biography that existed only on hover
 * would be the same defect in prose — invisible to a screen reader, unreachable
 * on a phone, and gone from a printed copy. This list is the twin, and it is
 * where the untruncated mandate lives.
 */
.rbios{margin-top:12px}
.rbios ul{list-style:none;margin-top:8px;display:grid;gap:11px}
/* Overriding .rwho's own row rules on purpose: this list shares that control's
   summary and nothing else. .rwho li is a single-line flex row for a peer's call
   sign; a mandate is three paragraphs and has to be a block that wraps. */
.rbios li{display:block;font-family:var(--sans);font-size:12px;line-height:1.5;
  color:var(--dim);white-space:normal;border-top:1px solid var(--hair);padding-top:10px}
.rbios li:first-child{border-top:0;padding-top:0}
.rbios li b{display:block;font-family:var(--sans);color:var(--ink);font-weight:600;
  font-size:12.5px;white-space:normal;margin-bottom:4px}
.rbios li i{display:block;font-style:normal;margin-top:5px}

/* ---------- the table view: identity is never colour alone ---------- */
.tv{margin-top:12px}
.tv summary{font-family:var(--mono);font-size:11px;color:var(--dim);cursor:pointer;
  padding:5px 0;list-style:none;display:inline-flex;align-items:center;gap:7px}
.tv summary::-webkit-details-marker{display:none}
.tv summary::before{content:"+";color:var(--dimmer);font-weight:600}
.tv[open] summary::before{content:"\\2212"}
.tv summary:hover{color:var(--ink)}
.tvscroll{overflow-x:auto;margin-top:8px}
.tv table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px;
  font-variant-numeric:tabular-nums}
.tv caption{caption-side:top;text-align:left;font-size:10.5px;color:var(--dimmer);
  padding-bottom:8px;line-height:1.6}
.tv th,.tv td{border-bottom:1px solid var(--hair);padding:6px 8px;text-align:right;
  color:var(--dim);white-space:nowrap}
.tv thead th{color:var(--dimmer);font-weight:500;vertical-align:bottom;
  border-bottom:1px solid var(--line)}
.tv th[scope=row]{text-align:left;color:var(--ink);font-weight:500}
.tv tbody tr:last-child th,.tv tbody tr:last-child td{border-bottom:0}
.tv tfoot th,.tv tfoot td{border-top:1px solid var(--line);border-bottom:0;color:var(--dimmer)}

/* ---------- loss per metric, with the cross-juror spread ---------- */
.lbrow{position:relative;display:grid;gap:12px;align-items:center;padding:8px 0;
  grid-template-columns:minmax(120px,.62fr) minmax(0,2.6fr) minmax(112px,auto)}
.lbrow + .lbrow{border-top:1px solid var(--hair)}
.lbname{font-size:13px;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
 /* The direct label marks the metric the panel split widest on. That is neither
    taken nor survived, so it wears neither hue — ink, which is what everything
    that is merely a fact wears in this theme. */
.lbname em{display:block;font-style:normal;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:3px}
.lbtrack{position:relative;height:12px;background:var(--sunk);
  box-shadow:inset 0 1px 2px rgb(var(--shade-c) / .55)}
/* Gridlines at the quartiles, solid hairlines, never dashed — and drawn OVER the
   two halves rather than as the track's own background. The bar fills the whole
   track now (survived plus taken is the hundred), so a gridline behind it would
   be covered on every row it is meant to help read. */
.lbtrack::after{content:"";position:absolute;inset:0;pointer-events:none;
  background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),
    rgb(var(--ink-c) / .16) calc(25% - 1px),rgb(var(--ink-c) / .16) 25%)}
/* The two halves of one hundred, and the whole reason this figure was turned
   round. The head is what the metric KEPT and wears --held, the hue that means
   survived; the remainder is what came off and wears --cut. That is the health
   meter's own construction at the top of the card, and it is now the same
   direction the two radials above it read in. */
.lbfill{position:absolute;left:0;top:0;bottom:0;background:var(--held)}
.lbcut{position:absolute;top:0;bottom:0;background:var(--cut)}
/* The category median, on the SAME axis as the bar it qualifies — a reference
   value, not a second measure, so it is a tick and never a second track. Grey,
   because it is context: the emphasis series is the bar. The dark edge is not
   decoration: the tick now crosses two painted halves rather than an empty track,
   and a grey line without one disappears into whichever half it lands on. */
.lbmed{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;
  background:rgb(var(--ink-c) / .55);box-shadow:0 0 0 1px rgb(var(--shade-c) / .45)}
/* The whisker is uncertainty — neither survived nor taken — so it is ink and
   never either accent. */
.lbwhisk{position:absolute;top:50%;height:1px;margin-top:-1px;background:rgb(var(--ink-c) / .90);
  z-index:1}
.lbwhisk::before,.lbwhisk::after{content:"";position:absolute;top:-4px;width:1px;height:9px;
  background:rgb(var(--ink-c) / .90)}
.lbwhisk::before{left:0}
.lbwhisk::after{right:0}
/* The readout leads with the same quantity the bar does — the health this metric
   kept, in --held, exactly as the meter's caption does — and states the cut
   underneath it, so Part 5's connective word stays on the surface. */
.lbval{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;
  color:var(--ink);text-align:right;line-height:1.3}
.lbval .held{font-size:11.5px}
.lbval em{display:block;font-style:normal;font-size:10px;color:var(--dimmer)}
 /* The axis has to share the ROW's grid, not the card's width: its ticks mean
    nothing unless 0 and 100 sit on the ends of the track they scale. Drawn as a
    .lbrow with an empty label cell and an empty value cell, so the three columns
    line up by construction rather than by a matching magic number. */
.lbaxis{display:grid;gap:12px;margin-top:2px;
  grid-template-columns:minmax(120px,.62fr) minmax(0,2.6fr) minmax(112px,auto)}
/* Each tick sits ON its gridline rather than being distributed between the ends:
    space-between aligns boxes, not centres, so 25 / 50 / 75 drifted left of the
    lines they name by half a label. The ends anchor to the ends of the track. */
.lbticks{position:relative;height:13px;
  font-family:var(--mono);font-size:9.5px;color:var(--faint);letter-spacing:.06em}
.lbticks span{position:absolute;top:0}
.lbticks .tm{transform:translateX(-50%)}
.lbticks .t1{right:0}

/* ---------- the Floor ---------- */
.dblk + .dblk{margin-top:14px;padding-top:13px;border-top:1px solid var(--hair)}
.dbar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:11px;align-items:center;
  margin-top:9px}
.dk{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--dimmer);white-space:nowrap}
.dtrack{position:relative;height:8px;background:var(--sunk);
  box-shadow:inset 0 1px 2px rgb(var(--shade-c) / .55)}
.dfill{position:absolute;left:0;top:0;bottom:0;background:rgb(var(--ink-c) / .58)}
.dval{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dim);white-space:nowrap}
.dnone{font-family:var(--mono);font-size:10.5px;color:var(--dimmer);margin-top:9px}
.dsilent{margin-top:16px;padding:11px 13px;background:var(--sunk);border-radius:var(--r1);
  font-size:13.5px;line-height:1.55;color:var(--dim)}
.dsilent b{color:var(--ink);font-weight:600}
.dparts{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:14px 18px;
  margin-top:16px;padding-top:14px;border-top:1px solid var(--hair)}
.dpart .dk{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:var(--dim)}
.dpart p{font-family:var(--mono);font-size:10px;line-height:1.45;color:var(--faint);
  margin-top:6px;letter-spacing:.02em;text-transform:none}
/* The buyer quotes, in the half of the row beside the radial they belong to.
   A card, because it holds a person's sentence and a number they put behind it. */
.bcards{margin-top:0}
.bhead{font-size:14.5px;line-height:1.5;color:var(--dim)}
.bhead b{color:var(--ink);font-weight:600}
/* The block sits in a column now, so it scrolls its own overflow rather than
   pushing the radial beside it out of the measure. */
.bcards .pick{grid-template-columns:auto minmax(0,1fr)}

/* ---------- the phone ---------- */
/*
 * Shared links are opened on phones, so 390px is the case this page is designed
 * for as much as 1440 is. Everything stacks, the header's two columns become two
 * rows with the rank left-aligned under the name, and both figures stay usable:
 * the radial's SVG scales with its column, and the heatmap's own columns shrink
 * to fit rather than pushing a scrollbar under the reader's thumb.
 */
@media (max-width:640px){
  .vhead{padding:18px 16px 16px}
  .vid{grid-template-columns:minmax(0,1fr);gap:16px}
  .vrank{text-align:left;justify-self:start}
  .vrank b{font-size:46px}
  .lbrow{grid-template-columns:minmax(0,1fr) minmax(66px,auto);row-gap:7px}
  .lbtrack{grid-column:1 / -1;order:3}
  /* The track goes full width here, so the axis has to as well: left on the
     three-column template its ticks scaled a middle column that no longer
     exists, and 0/25/50/75/100 sat over the wrong points of the bar. The two
     empty cells that align the axis with the label and value columns on a wide
     screen have nothing to align to once the row has stacked. */
  .lbaxis{grid-template-columns:minmax(0,1fr)}
  .lbaxis > span:first-child,.lbaxis > span:last-child{display:none}
}
/*
 * The readouts are withdrawn below this width: a positioned tooltip has nowhere
 * to hang on a 390px screen and a touch pointer has no hover to lose. The table
 * view and the panel list are always in the document and are the twins here.
 *
 * The heatmap shrinks instead of scrolling, and the arithmetic is exact rather
 * than hopeful. A 390px phone leaves 324px inside the wrap's padding and the
 * well's; a 68px row header and five 2px gaps leave 49.2px per metric column,
 * and the longest single word a header holds — DURABILITY, ten characters — is
 * 45px of mono at 7.5px plus 2px of padding. So nothing breaks mid-word and
 * nothing scrolls. overflow-x:auto stays as the floor for a board with more
 * metrics than these two categories have.
 */
@media (max-width:560px){
  .mxscroll{overflow-x:auto}
  .mxgrid{grid-template-columns:minmax(68px,1fr) repeat(var(--cols),minmax(26px,1fr))}
  .mxrh{font-size:10.5px;padding-right:5px}
  .mxrh em{font-size:8.5px}
  .mxch{font-size:7.5px;letter-spacing:0;padding:0 1px 5px}
  .mxc{min-height:30px;font-size:10px}
  .tip{display:none}
  /* The spoke hotspots go with the readouts they carry, rather than staying as
     six invisible tab stops that reveal nothing. The panel list under each chart
     is the twin here, exactly as the table view is for the heatmap. */
  .rspot{display:none}
  /* Four controls and a badge do not fit 390px in a row, and a wrapped row of
     half-width buttons reads as a broken grid. One per line, full width. */
  .share-row{flex-direction:column;align-items:stretch}
  .share-row .sact[data-copy]{min-width:0}
}
`;

/**
 * The two lines a founder screenshots, side by side: the sharpest cut and the
 * warmest buyer.
 *
 * They were at positions two and nine on the old page. They are the whole reason
 * anyone shares a verdict — one says what hurt, the other says who wanted it —
 * so they sit under the health bar with a rail each in the hue that says which.
 *
 * The right-hand slot has three arms and no empty state. A buyer quote when one
 * exists; the second-sharpest cut when the Floor convened and named nobody; and
 * for a solo cluster, which is 32 of 48 rows, the fact itself. A blank card
 * beside a full one would read as a page that failed to render.
 */
function headerLine(text: string, meta: string, rail: 'c' | 'h'): string {
  return (
    `<div class="ln ${rail}">${escapeHtml(text)}` +
    `<small>${escapeHtml(meta)}</small></div>`
  );
}

/** The sharpest cut, as the left-hand line. `''` when nothing came off. */
function sharpestLine(verdict: Verdict): string {
  const { sharpest } = verdict;
  if (sharpest === null) return '';
  return headerLine(
    sharpest.reason,
    `${sharpest.role} · −${sharpest.points} on ${metricLabel(sharpest.metric)}`,
    'c',
  );
}

/**
 * The right-hand line: the best buyer quote, or what stands in for it.
 *
 * "Best" is the highest conviction behind a FIRST choice, because that is the
 * only pick the run records a number for (`01 §6.2`). A page that promoted a
 * runner-up here would print the warmest-sounding sentence with no figure behind
 * it.
 */
function wantedLine(verdict: Verdict): string {
  const { floor } = verdict;

  if (floor.kind === 'convened') {
    const best = [...floor.picks]
      .filter((pick) => pick.pick === 'first')
      .sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1))[0];
    if (best !== undefined) {
      const conviction = typeof best.strength === 'number' ? ` · conviction ${best.strength}` : '';
      return headerLine(best.reason, `${best.persona} · first choice${conviction}`, 'h');
    }
    // The Floor convened and named nobody. The second-sharpest cut is the next
    // most useful thing on the card, and it is a fact rather than a gap.
    const second = verdict.metrics.flatMap((metric) => metric.deductions).sort((a, b) => b.points - a.points)[1];
    if (second !== undefined) {
      return headerLine(
        second.reason,
        `${second.role} · −${second.points} on ${metricLabel(second.metric)}`,
        'c',
      );
    }
  }

  return '<div class="ln h">Nothing close enough to compare. Ranked on merit alone.</div>';
}

/** The opacity ramp a segment sits on: heaviest solid, the rest stepping back. */
function segClass(index: number, base: string = 'seg'): string {
  return index === 0 ? base : `${base} s${Math.min(index + 1, 6)}`;
}

/**
 * The health meter: this product's hundred points, and the metrics that ate them.
 *
 * The widths are exact. `cuts = 100 - mean(metric score)`, so a metric contributes
 * `metricCuts / metricCount` and the segments sum to the bar with nothing left
 * over. A key names every segment, because this document has no hover on a phone
 * and no JavaScript anywhere: a bar whose blocks can only be identified by
 * pointing at them is a bar half the readers cannot read.
 *
 * The two halves are the two hues and nothing else on this page is either of
 * them: the head is `--held`, the health the card walked out with, and every
 * segment after it is `--cut`, one metric's share of what was taken. The readout
 * leads with the health figure and states it in `--held`, which is the correction
 * `lib/theme.ts` documents — a bar whose larger quantity is drawn in the absence
 * of colour is a bar arguing against its own caption.
 *
 * The per-segment key is gone and the readout names the heaviest metric instead.
 * Six swatches under a bar were a legend for five bars that are drawn in full,
 * with their names, their figures and the board's median, one section down. The
 * fact the bar cannot state on its own is which metric ate the most, and that is
 * the fact the line now carries.
 */
function healthMeter(verdict: Verdict): string {
  const count = verdict.metrics.length;
  const cuts = Math.max(0, Math.min(100, verdict.cuts));
  const health = 100 - cuts;
  if (count === 0) return '';

  const share = (metric: VerdictMetric): number => Math.max(0, metric.cuts) / count;

  const segments = verdict.metrics
    .map((metric, index) => `<i class="${segClass(index)}" style="width:${share(metric)}%"></i>`)
    .join('');

  // `verdict.metrics` is sorted heaviest loss first, so the segments run heaviest
  // first and the worst of them is the head of that list.
  const worst = verdict.metrics[0];
  const worstLine =
    worst === undefined || worst.cuts <= 0
      ? ''
      : ` &middot; worst: ${escapeHtml(metricLabel(worst.metric))} &minus;${n1(share(worst))}`;

  return [
    '<div class="vbar">',
    `<div class="meter"><span class="row"><i class="kept" style="width:${health}%"></i>${segments}</span></div>`,
    '<div class="vbarlbl">',
    `<span><b class="held">${Math.round(health)} health left</b></span>`,
    `<span><b class="pts">&minus;${Math.round(cuts)} in cuts</b>${worstLine}</span>`,
    '</div>',
    '</div>',
  ].join('');
}

/** A width, as a percentage string with no floating-point tail. */
function pct(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(2)}%`;
}

// --- the two radials -------------------------------------------------------------

/**
 * The geometry, in viewBox units. One constant block so the labels and the plot
 * cannot drift apart.
 *
 * The box is wider than it is tall because the widest thing on the chart is a
 * juror's name, not the polygon. With six axes starting at the top, no axis sits
 * at 0° or 180°, so the furthest a label reaches horizontally is `R * cos 30°`
 * plus its own width — which is what `W` is sized for.
 */
const RAD = { W: 360, H: 334, CX: 180, CY: 155, R: 112 } as const;

/**
 * How far out the axis labels sit, as a multiple of `R`, and the type metrics
 * the box was sized against.
 *
 * `R` is unchanged at 112 and must stay there: the enlargement that produced it
 * was the answer to "the radial graphs look very small", and a bad product draws
 * its polygon at a fraction of `R` — mean health 15.4 is a radius of 0.154R — so
 * shrinking the plot is the one change that would take back the thing the
 * enlargement bought.
 *
 * What did move is the AIR around it. The frame was 372 wide and 350 tall for a
 * 224 plot because the labels were pushed out to 1.11R. At 1.07R the box is 360
 * by 334 for the same plot, so the polygon is 62% of the figure's width where it
 * was 60% and 67% of its height where it was 64% — the enlargement's own
 * argument, applied to the frame rather than to the radius.
 *
 * The margins are measured against the widest thing either box has to hold: a
 * 12-character label line at `AXIS_FS` with `.rax`'s own `letter-spacing`, which
 * is 71.8 units and not the 66.2 a bare advance would predict — `monoWidth`
 * carries the tracking for the same reason.
 */
const AXIS_OUT = 1.07;
/** Label type size, and the baseline step between wrapped lines. */
const AXIS_FS = 9.2;
const AXIS_LH = 10.4;
/** The direct-labelled figure under each axis name: the one number per spoke. */
const VALUE_DY = 12.4;
/** Type size of that figure, and of the qualifier that can sit under it. */
const VALUE_FS = 11.2;
/**
 * The line a `2nd choice` axis gets under its zero, and the step down to it.
 *
 * It used to be printed on the value line itself as `0 · 2nd choice`, fourteen
 * characters at 11.2px — 94 units wide against a label gutter of 72. On the
 * bottom axis, which is centred, it merely looked loose; on a diagonal axis it
 * would have run out of the viewBox and been clipped by it. A runner-up is a
 * fact about the axis and not a longer number, so it gets its own line.
 */
const MARK_FS = 9.2;
const MARK_DY = 11;

/**
 * Characters per label line, and how many lines a label may take.
 *
 * Measured, not guessed: the labels are IBM Plex Mono at `AXIS_FS`, whose advance
 * is 0.6em and `.rax` tracks a further 0.05em, so a line of `AXIS_CHARS` costs
 * `AXIS_CHARS * AXIS_FS * 0.65` = 71.8px. The tightest position is an axis at 30°
 * off horizontal, where the label starts at `CX + AXIS_OUT * R * cos 30` = 283.8
 * and has `W - that` = 76.2px to grow into.
 *
 * Twelve is a floor, not a preference: the longest single word on either
 * installed panel is `Raghunathan`, eleven characters, and a narrower line would
 * hard-break a buyer's surname across two lines rather than wrap it.
 */
const AXIS_CHARS = 12;
const AXIS_LINES = 3;

/** Axis `i` of `n`, at value `v` (0–100), as a viewBox point. */
function radialPoint(index: number, count: number, value: number): [number, number] {
  const angle = ((-90 + (360 / count) * index) * Math.PI) / 180;
  // Radius is LINEAR in the value, and the value scale runs 0 to 100 with ZERO AT
  // THE CENTRE. It is never rebased to the band the data occupies. Area already
  // grows as the square of the radius, so a truncated baseline would multiply one
  // exaggeration by another and leave the reader no way to see either — and on a
  // shape with no numbered axis line there is nowhere to disclose it. The rings
  // and the printed figure on every spoke are what a magnitude is read from.
  const radius = (Math.max(0, Math.min(100, value)) / 100) * RAD.R;
  return [RAD.CX + radius * Math.cos(angle), RAD.CY + radius * Math.sin(angle)];
}

/** `12.3456` -> `12.35`, for an SVG coordinate. */
function c(value: number): string {
  return value.toFixed(2);
}

/**
 * A series as a closed polygon.
 *
 * A `null` axis is **skipped**: the outline bridges from the neighbour before it
 * to the neighbour after it, and no vertex dot is drawn. It used to be plotted at
 * the centre, which was defensible while the axis was points TAKEN — a missing
 * juror drew no spike and the label said `no answer`. On a health axis the centre
 * means "this juror left nothing standing", so plotting a silent juror there
 * would draw the worst possible finding out of the absence of a finding. Bridging
 * asserts nothing about the missing axis; the label still says `no answer` and
 * the table still prints an em dash.
 *
 * `''` when every value is null, so the caller renders an empty path rather than
 * a dot at the centre.
 */
function radialPath(values: readonly (number | null)[]): string {
  const drawn = values
    .map((value, index) => (value === null ? '' : radialPoint(index, values.length, value)))
    .filter((point): point is [number, number] => point !== '');
  if (drawn.length === 0) return '';
  return `${drawn.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${c(x)} ${c(y)}`).join(' ')} Z`;
}

/**
 * `The Terminal Minimalist` -> lines that fit beside the plot.
 *
 * Greedy wrap on whole words, then a hard break for a single word longer than a
 * line — a juror role or a buyer's name is not something this page may abbreviate
 * by dropping the end of it silently, so an over-long word is broken rather than
 * cut, and only a label that overruns `AXIS_LINES` is truncated with an ellipsis
 * the reader can see.
 */
export function wrapAxisLabel(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  const flush = (): void => {
    if (line !== '') lines.push(line);
    line = '';
  };

  // A hyphen is a break opportunity, so `The Self-Experimenter` wraps to
  // `Self-` / `Experimenter` rather than being chopped mid-syllable by the hard
  // break below. The lookbehind keeps the hyphen on the line it belongs to.
  for (const word of text.split(/(?<=-)|\s+/).filter((part) => part !== '')) {
    const glue = line.endsWith('-') ? '' : ' ';
    if (line === '') line = word;
    else if (`${line}${glue}${word}`.length <= AXIS_CHARS) line = `${line}${glue}${word}`;
    else {
      flush();
      line = word;
    }
    while (line.length > AXIS_CHARS) {
      lines.push(line.slice(0, AXIS_CHARS));
      line = line.slice(AXIS_CHARS);
    }
  }
  flush();

  if (lines.length <= AXIS_LINES) return lines.length === 0 ? [''] : lines;
  const kept = lines.slice(0, AXIS_LINES);
  kept[AXIS_LINES - 1] = `${(kept[AXIS_LINES - 1] as string).slice(0, AXIS_CHARS - 1)}…`;
  return kept;
}

/**
 * What a spoke is CALLED on the chart, as opposed to what the axis IS.
 *
 * The audit's complaint was `RAVI CHANDRASEKAR / AN` — a buyer's surname broken
 * mid-word across two of the three lines a spoke gets, because eleven characters
 * of mono is what fits beside a plot and `Chandrasekar` is twelve. Every buyer on
 * both installed panels is a real two-word name, so the fix is a naming rule
 * rather than another character of gutter: **first name, surname initial**.
 *
 * A juror is not a person and does not take that rule. `The Platform Owner` under
 * it would become `The O.`, which names nobody. A role is a noun phrase, so the
 * article comes off — `Platform Owner` wraps to two whole words — and nothing
 * else is touched.
 *
 * Either way the full string is still on the page in three places: the hover and
 * keyboard readout, the panel list under the chart, and the table twin. The
 * shortening is a label, never a record.
 */
export function spokeLabel(text: string): string {
  const trimmed = text.trim();
  if (/^the\s+/i.test(trimmed)) return trimmed.replace(/^the\s+/i, '');

  const words = trimmed.split(/\s+/).filter((word) => word !== '');
  if (words.length < 2) return trimmed;
  const first = words[0] as string;
  const last = words[words.length - 1] as string;
  // A surname that is already an initial keeps its own punctuation rather than
  // becoming `A..`.
  return `${first} ${last.slice(0, 1)}${last.endsWith('.') ? '' : '.'}`;
}

/**
 * Everything about one axis's LABEL, computed once.
 *
 * The drawn label and the hotspot laid over it are two renderings of the same
 * rectangle, and a hotspot that had its own arithmetic would drift off the words
 * it belongs to the first time either changed. So both read this.
 */
interface AxisBox {
  /** The anchor point the `<text>` is placed at, in viewBox units. */
  readonly x: number;
  readonly y: number;
  readonly anchor: 'start' | 'middle' | 'end';
  /** Which side of the plot this axis is on, for placing the readout. */
  readonly right: boolean;
  readonly below: boolean;
  readonly lines: readonly string[];
  /** The figure printed under the name: a number, or `no answer`, or `0`. */
  readonly figure: string;
  /** The qualifier under the figure, on its own line. `''` when there is none. */
  readonly mark: string;
  /** The rectangle the label occupies, in viewBox units. */
  readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

/**
 * Mono advance is 0.6em and `.rax` tracks a further 0.05em, applied after every
 * character including the last. Dropping the tracking underestimates a
 * 12-character label by 5.5 units, which is most of the margin the box has.
 */
function monoWidth(text: string, size: number): number {
  return text.length * size * 0.65;
}

function axisBox(radial: Radial, index: number, count: number): AxisBox {
  const [ax, ay] = radialPoint(index, count, 100);
  const dx = ax - RAD.CX;
  const dy = ay - RAD.CY;
  const vertical = Math.abs(dx) < 1;
  const anchor = vertical ? 'middle' : dx > 0 ? 'start' : 'end';
  const x = RAD.CX + dx * AXIS_OUT;
  const y = RAD.CY + dy * AXIS_OUT + (vertical ? (dy < 0 ? -13 : 18) : 0);

  const lines = wrapAxisLabel(spokeLabel(radial.axes[index] as string));
  const value = radial.self.values[index];
  const flag = radial.marks[index];
  const figure = flag === 'no answer' || value === null || value === undefined ? 'no answer' : n1(value);
  const mark = flag === '2nd choice' ? '2nd choice' : '';

  const width = Math.max(
    ...lines.map((line) => monoWidth(line, AXIS_FS)),
    monoWidth(figure, VALUE_FS),
    mark === '' ? 0 : monoWidth(mark, MARK_FS),
  );
  // The first baseline, which `labels` below shifts up by half a line per extra
  // line so a wrapped name stays centred on its own spoke.
  const first = y - (lines.length - 1) * (AXIS_LH / 2);
  const last = first + (lines.length - 1) * AXIS_LH + VALUE_DY + (mark === '' ? 0 : MARK_DY);
  const pad = 3;

  return {
    x,
    y,
    anchor,
    right: dx > 0.5,
    below: dy > 0.5,
    lines,
    figure,
    mark,
    box: {
      left: (anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2) - pad,
      top: first - AXIS_FS * 0.82 - pad,
      width: width + pad * 2,
      height: last - first + AXIS_FS * 0.82 + 3.2 + pad * 2,
    },
  };
}

/** The class that carries a context series' line style. Peers cycle, the median is fixed. */
const PEER_STYLES = ['rp1', 'rp2', 'rp3', 'rp4'] as const;

function contextClass(series: RadialSeries, peerIndex: number): string {
  if (series.role === 'median') return 'rmed';
  return PEER_STYLES[Math.min(peerIndex, PEER_STYLES.length - 1)] as string;
}

/**
 * What the legend calls a context shape by default.
 *
 * Positional, and deliberately so. The founder's rule is that comparing against a
 * peer must not publish that peer's verdict on your page, and a name in a legend
 * is the beginning of that. A shape is a summary and stays one; who each outline
 * belongs to is one control away, in `identityList` below.
 */
function contextLabel(series: RadialSeries, peerIndex: number): string {
  return series.role === 'median' ? 'Category median' : `Peer ${peerIndex + 1}`;
}

/**
 * Who each outline is, once the reader asks.
 *
 * An anonymous peer shows its pseudonym beside the avatar slot and links
 * nowhere — a link to its verdict page carries the name it withheld. A named peer
 * links to its own public page, which is already public.
 *
 * The avatar itself is NOT drawn here. `data-avatar-seed` is the seam the
 * deterministic robot generator reads; this page reserves the box and stops.
 */
function identityList(context: readonly { entry: RadialSeries; style: string; label: string }[], origin: string): string {
  const peers = context.filter(({ entry }) => entry.role === 'peer');
  if (peers.length === 0) return '';

  const items = peers
    .map(({ entry, label }) => {
      const who =
        entry.anonymous === false && typeof entry.slug === 'string' && entry.slug !== ''
          ? `<a href="${escapeHtml(origin)}/v/${encodeURIComponent(entry.slug)}">${escapeHtml(entry.label)}</a>`
          : `<em title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</em>`;
      const avatar =
        entry.anonymous === true
          ? `<span class="ravatar" data-avatar-seed="${escapeHtml(entry.avatarSeed ?? '')}" aria-hidden="true"></span>`
          : '';
      return `<li>${avatar}<b>${escapeHtml(label)}</b>${who}</li>`;
    })
    .join('');

  return [
    '<details class="rwho">',
    `<summary>Which outline is which (${peers.length})</summary>`,
    `<ul>${items}</ul>`,
    '<p class="figcap">An anonymous listing withholds its name and its address, and nothing else.</p>',
    '</details>',
  ].join('');
}

// --- who the spoke belongs to ------------------------------------------------------

/**
 * What the roster disclosure is called on this figure.
 *
 * Phrased so the register carries without the grammar breaking: `brief` Part 4
 * lets a B2B board say `The Panel` where a consumer board says `The Six`, and
 * `The Floor` is singular where `The Buyers` is plural. "Who they are" agrees
 * with all four; "who … are" does not.
 */
function mandateTitle(kind: 'jury' | 'buyers', labels: { jury: string; floor: string }): string {
  return `${kind === 'jury' ? labels.jury : labels.floor}: who they are`;
}

/**
 * One mandate as the rows a readout and a list both print.
 *
 * The two renderings differ in their chrome and not in their content: the
 * tooltip clamps each field to three lines in CSS, the list prints them whole.
 * Nothing is truncated in the markup, so the untruncated text is in the document
 * either way — which is what makes the clamp a display decision rather than a
 * page that quietly drops half of what it froze.
 */
function mandateRows(mandate: AxisMandate): { readonly name: string; readonly rows: readonly [string, string][] } {
  return mandate.kind === 'juror'
    ? {
        name: mandate.role,
        rows: [
          ['', mandate.who],
          ['Cares most', mandate.caresMost],
          ['Punishes', mandate.biasedAgainst],
        ],
      }
    : {
        name: mandate.name,
        rows: [
          ['', mandate.description],
          ...(mandate.needs.length === 0
            ? []
            : ([['Needs', mandate.needs.join(' · ')]] as [string, string][])),
          ['On price', `${mandate.priceSensitivity} sensitivity`],
        ],
      };
}

function mandateBody(mandate: AxisMandate): string {
  return mandateRows(mandate)
    .rows.map(
      ([key, text]) =>
        `<i>${key === '' ? '' : `<span class="rbk">${escapeHtml(key)}</span>`}${escapeHtml(text)}</i>`,
    )
    .join('');
}

/**
 * The readout laid over one axis label: who this juror or buyer is.
 *
 * A `<button>` and not a `<span tabindex>`, because a button is what a touch
 * screen focuses on a tap — a readout that existed only on `:hover` would be
 * unreachable on a phone — and because it is what a screen reader announces as
 * something to activate. The readout itself is `aria-hidden` like every other
 * `.tip` on this page: the accessible copy is the panel list under the chart,
 * which carries the same text untruncated and needs no pointer at all.
 *
 * `''` when the frozen payload has no mandate for this axis. There is no
 * fallback text and no empty control: a verdict delivered before the panel was
 * frozen simply has a spoke with a name on it, which is what it has always had.
 */
function spokeButton(box: AxisBox, mandate: AxisMandate | null, axis: string): string {
  if (mandate === null) return '';
  const flip = [box.right ? 'tr' : '', box.below ? 'tu' : ''].filter((part) => part !== '').join(' ');
  const style =
    `left:${pct((box.box.left / RAD.W) * 100)};top:${pct((box.box.top / RAD.H) * 100)};` +
    `width:${pct((box.box.width / RAD.W) * 100)};height:${pct((box.box.height / RAD.H) * 100)}`;
  return [
    `<button type="button" class="rspot" style="${style}" `,
    `aria-label="${escapeHtml(`Who ${axis} is`)}">`,
    `<span class="tip rbio${flip === '' ? '' : ` ${flip}`}" aria-hidden="true">`,
    `<b>${escapeHtml(mandateRows(mandate).name)}</b>`,
    `<em>${escapeHtml(box.figure)}${box.mark === '' ? '' : ` &middot; ${escapeHtml(box.mark)}`} &middot; ${escapeHtml(
      mandate.kind === 'juror' ? 'health left' : 'conviction',
    )}</em>`,
    mandateBody(mandate),
    '</span></button>',
  ].join('');
}

/**
 * The panel, in the DOM, with no pointer involved.
 *
 * The twin of the spoke readouts, for the same reason every figure here has a
 * table twin: a fact reachable only by hovering is a fact half the readers of
 * this page cannot reach — on a phone there is no hover, in a screen reader
 * there is no pointer, and a downloaded copy printed to paper has neither.
 *
 * `''` when the verdict froze no mandates, which is every verdict delivered
 * before the panel was frozen. No control, no empty list, and nothing invented.
 */
function mandateList(radial: Radial, title: string): string {
  const present = radial.axes
    .map((axis, index) => ({ axis, mandate: radial.mandates[index] ?? null }))
    .filter((entry): entry is { axis: string; mandate: AxisMandate } => entry.mandate !== null);
  if (present.length === 0) return '';

  const items = present
    .map(
      ({ mandate }) =>
        `<li><b>${escapeHtml(mandateRows(mandate).name)}</b>${mandateBody(mandate)}</li>`,
    )
    .join('');

  return [
    '<details class="rwho rbios">',
    `<summary>${escapeHtml(title)} (${present.length})</summary>`,
    `<ul>${items}</ul>`,
    '<p class="figcap">The panel that judged this product.</p>',
    '</details>',
  ].join('');
}

/**
 * The table twin: every series, on every axis, as numbers.
 *
 * Required rather than optional. `anti-patterns.md` treats a colour-only encoding
 * on a continuous scale as a defect, and a radial adds a second one — identity by
 * SHAPE. This table is the answer to both: it survives greyscale, a screen reader
 * and a reader who wants to compare two numbers without tracing a polygon, and
 * `test/verdict-radial.test.ts` asserts it carries the same figures the shapes do.
 */
function radialTable(
  radial: Radial,
  title: string,
  columns: readonly { readonly entry: RadialSeries; readonly label: string }[],
): string {
  const series = [radial.self, ...radial.context];
  // The same positional labels the legend uses. The table is the twin of the
  // chart, so naming a peer here that the chart declines to name would put the
  // identity back on the page through the accessible door.
  const head = [radial.self.label, ...columns.map(({ label }) => label)]
    .map((label) => `<th scope="col">${escapeHtml(label)}</th>`)
    .join('');

  const body = radial.axes
    .map((axis, index) => {
      const cells = series
        .map((entry) => {
          const value = entry.values[index];
          return `<td>${value === null || value === undefined ? '&mdash;' : n1(value)}</td>`;
        })
        .join('');
      const mark = radial.marks[index];
      return (
        `<tr><th scope="row">${escapeHtml(axis)}${mark === null || mark === undefined ? '' : ` (${escapeHtml(mark)})`}</th>` +
        `${cells}</tr>`
      );
    })
    .join('');

  return [
    // `tv rtv`, not bare `tv`: the heatmap's table twin is the one that answers
    // to `<details class="tv">`, and `test/verdict-charts.test.ts` reaches for it
    // by that selector. A second table under the same exact class would have made
    // that test silently assert about this one instead.
    '<details class="tv rtv">',
    '<summary>As a table</summary>',
    '<div class="tvscroll">',
    '<table>',
    `<caption>${escapeHtml(title)} &mdash; ${escapeHtml(radial.unit)}.</caption>`,
    `<thead><tr><th scope="col">Axis</th>${head}</tr></thead>`,
    `<tbody>${body}</tbody>`,
    '</table>',
    '</div>',
    '</details>',
  ].join('');
}

/**
 * One radial: this product's shape, its cluster peers', and the category's.
 *
 * ## Why this is a radial and not six more bars
 *
 * Because the question is a SHAPE question. "Did the same juror who hurt me hurt
 * the thing I am being compared to" is answered by two polygons dented in the same
 * place, and six pairs of bars answer it only after the reader has done the
 * pairing themselves. The previous pass on this page was right that a radial with
 * nothing overlaid is a worse bar chart; what changed is that there is now
 * something to overlay, frozen at delivery (`charts.ts` carries the full argument).
 *
 * ## What is done about the two objections that still stand
 *
 * Area grows as the square of the radius, so no magnitude is read off the
 * polygon: every axis prints its own value beside its own name, the rings are
 * labelled, and the table twin carries every series on every axis. Axis order is
 * not arbitrary — it is the installed panel's order, frozen in the payload, and
 * identical for every shape on the chart.
 */
function radialFigure(
  radial: Radial,
  kind: 'jury' | 'buyers',
  title: string,
  /** What the roster disclosure is called: `The Panel`, `The Buyers`, `The Six`. */
  panelTitle: string,
  /** One line. How to read the chart, and nothing else. */
  caption: string,
  /** One sentence naming what the outlines are, beside the legend that draws them. */
  note: string,
  origin: string,
): string {
  const count = radial.axes.length;
  const series = [radial.self, ...radial.context];

  const rings = [25, 50, 75, 100]
    .map((step) => {
      const points = radial.axes
        .map((_, index) => radialPoint(index, count, step).map(c).join(','))
        .join(' ');
      return `<polygon class="rring${step === 100 ? ' rout' : ''}" points="${points}"></polygon>`;
    })
    .join('');

  const spokes = radial.axes
    .map((_, index) => {
      const [x, y] = radialPoint(index, count, 100);
      return `<line class="rspoke" x1="${c(RAD.CX)}" y1="${c(RAD.CY)}" x2="${c(x)}" y2="${c(y)}"></line>`;
    })
    .join('');

  // The rings need numbers or the reader has no scale to hang a shape on. They
  // sit on the vertical spoke and are painted stroke-first in the well's own
  // colour, so a polygon crossing underneath does not eat them. `100` is left
  // off: it would land on the outer ring under the top axis's own figure, and
  // the outer ring is the one value the caption already states.
  const ticks = [25, 50, 75]
    .map((step) => {
      const [, y] = radialPoint(0, count, step);
      return `<text class="rtick" x="${c(RAD.CX + 5)}" y="${c(y + 3.2)}">${step}</text>`;
    })
    .join('');

  // One pass fixes each context series' line style, its positional label and its
  // highlight key, so the legend swatch, the table column and the shape they name
  // cannot drift apart.
  let peerIndex = -1;
  const context = radial.context.map((entry, index) => {
    if (entry.role === 'peer') peerIndex += 1;
    return {
      entry,
      style: contextClass(entry, peerIndex),
      label: contextLabel(entry, peerIndex),
      key: `rk${index + 1}`,
    };
  });

  const shapes = context
    .map(({ entry, style, key }) => {
      const marks = entry.values
        .map((value, index) => {
          if ((value ?? 0) <= 0) return '';
          const [x, y] = radialPoint(index, count, value as number);
          return `<circle class="rpdot ${key}" cx="${c(x)}" cy="${c(y)}" r="3"></circle>`;
        })
        .join('');
      return `<path class="rp ${style} ${key}" d="${radialPath(entry.values)}"></path>${marks}`;
    })
    .join('');

  const dots = radial.self.values
    .map((value, index) => {
      if (value === null) return '';
      const [x, y] = radialPoint(index, count, value);
      return `<circle class="rdot" cx="${c(x)}" cy="${c(y)}" r="4.6"></circle>`;
    })
    .join('');

  // One pass per axis, shared by the drawn label and by the hotspot laid over it,
  // so the two cannot come apart. Labels sit outside the outer ring, anchored by
  // which side of the chart their axis is on, so a long juror name grows away
  // from the plot rather than over it.
  const boxes = radial.axes.map((_, index) => axisBox(radial, index, count));

  const labels = boxes
    .map((box, index) => {
      const tspans = box.lines
        .map(
          (line, lineIndex) =>
            `<tspan x="${c(box.x)}" dy="${lineIndex === 0 ? 0 : AXIS_LH}">${escapeHtml(line)}</tspan>`,
        )
        .join('');
      const mark =
        box.mark === ''
          ? ''
          : `<tspan class="rvm" x="${c(box.x)}" dy="${MARK_DY}">${escapeHtml(box.mark)}</tspan>`;
      return (
        `<text class="rax${radial.marks[index] === null ? '' : ' rmk'}" x="${c(box.x)}" ` +
        `y="${c(box.y - (box.lines.length - 1) * (AXIS_LH / 2))}" text-anchor="${box.anchor}">${tspans}` +
        `<tspan class="rv" x="${c(box.x)}" dy="${VALUE_DY}">${escapeHtml(box.figure)}</tspan>${mark}</text>`
      );
    })
    .join('');

  // The spoke readouts, over the labels rather than inside the drawing. Empty for
  // a verdict whose payload froze no panel.
  const spokeReadouts = boxes
    .map((box, index) => spokeButton(box, radial.mandates[index] ?? null, radial.axes[index] as string))
    .join('');

  const legend = [
    `<span><i class="rself"></i><em title="${escapeHtml(radial.self.label)}">${escapeHtml(radial.self.label)}</em></span>`,
    ...context.map(
      ({ style, label, key }) =>
        `<span tabindex="0" class="${key}"><i class="${style}"></i>` +
        `<em>${escapeHtml(label)}</em></span>`,
    ),
  ].join('');

  // A short label and a pointer to the table, rather than twenty-four numbers
  // read aloud in a sentence. `anti-patterns.md` wants every value reachable
  // without the graphic, and the table twin below is where they are reachable.
  const described =
    `${title}: ${radial.self.label} on ${count} axes, ${radial.unit}, ` +
    'on a scale from 0 at the centre to 100 at the outer ring where further out is better' +
    (context.length === 0
      ? ', with nothing overlaid'
      : `, overlaid with ${context.map(({ label }) => label).join(' and ')}`) +
    '. Every figure is in the table that accompanies this chart.';

  return [
    `<figure class="rfig ${kind === 'jury' ? 'rj' : 'rb'}">`,
    `<figcaption class="rtitle">${escapeHtml(title)}</figcaption>`,
    '<div class="well2">',
    '<span class="rwrap">',
    `<svg viewBox="0 0 ${RAD.W} ${RAD.H}" role="img" aria-label="${escapeHtml(described)}">`,
    rings,
    spokes,
    ticks,
    shapes,
    `<path class="rp rself" d="${radialPath(radial.self.values)}"></path>`,
    dots,
    labels,
    '</svg>',
    // Laid over the drawing, in the same box, so a spoke's name is something a
    // pointer, a tab key and a fingertip can all reach.
    spokeReadouts,
    '</span>',
    '</div>',
    // Under the chart, in its own half of the row: one line of caption, then the
    // legend and the three disclosures a reader has to ask for. The caption is
    // one sentence — the scale, the comparison and the reading instructions used
    // to be three paragraphs beside every figure, which is most of what made this
    // page an essay.
    '<div class="rside">',
    `<p class="figcap">${caption}</p>`,
    `<div class="rkey">${legend}</div>`,
    `<p class="figcap rnote">${note}</p>`,
    identityList(context, origin),
    mandateList(radial, panelTitle),
    radialTable(radial, title, context),
    '</div>',
    '</figure>',
  ].join('');
}

/**
 * What the overlay on a radial actually is, in one sentence.
 *
 * Three states, and the difference between them is not cosmetic:
 *
 * - **Peers.** The comparison the founder asked for — the other products in this
 *   product's own cluster.
 * - **The category.** No peers exist (32 of 48 Developer Tools rows are a cluster
 *   of one), so the only baseline is the category's own middle, and the sentence
 *   names it as the category rather than letting a reader take it for a rival.
 * - **Neither.** The verdict predates the frozen comparison. `verdicts` refuses
 *   UPDATE and is never backfilled, so those pages draw the shape alone and
 *   nothing is invented to fill it.
 *
 * Derived from the shapes actually on the chart rather than from what the payload
 * could have supplied: `freezeComparison` drops the median once there are more
 * than two peers, so a note written from the payload would describe an overlay
 * the reader cannot see.
 */
function overlayNote(radial: Radial, cluster: string): string {
  const peers = radial.context.filter((entry) => entry.role === 'peer').length;
  const hasMedian = radial.context.some((entry) => entry.role === 'median');

  if (peers > 0) {
    return (
      `Outlines: ${peers === 1 ? 'the one other product' : `the ${peers} other products`} in ` +
      `<b>${escapeHtml(cluster)}</b>` +
      (hasMedian && radial.medianOver > 0
        ? `, and the middle of the category (${radial.medianOver} products)`
        : '') +
      '.'
    );
  }
  if (hasMedian) {
    return (
      'Nothing else was in this cluster, so the outline is the middle of the category' +
      `${radial.medianOver > 0 ? ` &mdash; ${radial.medianOver} products` : ''}, not a rival.`
    );
  }
  return 'This verdict was issued before comparisons were frozen, so there is nothing to overlay.';
}

/**
 * The panel and the buyers, as four figures in two rows.
 *
 * The pairing is the point of the rebuild. *Who hurt me* (the jury radial) and
 * *where* (the cut heatmap) are one question asked two ways and used to be four
 * screens apart; they now share a row. *Who wanted me* (the buyers radial) and
 * *why they said so* (their quotes) are the same, and take the row under it. A
 * solo cluster has no second row at all — nobody was ever shown that product —
 * rather than a row with a hole in it.
 */
function panelSection(verdict: Verdict, origin: string): string {
  const labels = panelLabels(verdict);
  const jury = juryRadial(verdict);
  const buyers = buyerRadial(verdict);
  if (jury === null && buyers === null) return '';

  const juryFigure =
    jury === null
      ? ''
      : radialFigure(
          jury,
          'jury',
          labels.jury,
          mandateTitle('jury', labels),
          'One spoke per juror. Further out is better.',
          overlayNote(jury, verdict.cluster.label),
          origin,
        );

  const buyersFigure =
    buyers === null
      ? ''
      : radialFigure(
          buyers,
          'buyers',
          labels.floor,
          mandateTitle('buyers', labels),
          'One spoke per buyer. Further out is more conviction.',
          buyers.self.values.every((value) => (value ?? 0) === 0)
            ? 'Your shape sits on the centre point: not one of them made this their first choice.'
            : overlayNote(buyers, verdict.cluster.label),
          origin,
        );

  const buyerRow =
    buyersFigure === '' ? '' : `<div class="bgrid">${buyersFigure}${buyerCards(verdict)}</div>`;

  return [
    '<section>',
    '<h2>Who hurt you, who wanted you</h2>',
    `<p class="lede">Being weak and having ${escapeHtml(labels.jury)} <i>agree</i> you were weak are two findings.</p>`,
    `<div class="pgrid">${juryFigure}${matrixFigure(verdict)}</div>`,
    buyerRow,
    '</section>',
  ].join('');
}

/**
 * One cell of the matrix.
 *
 * Three states, and the difference between them is the whole point of drawing it
 * this way: a juror who took points (painted, on the ramp step their total falls
 * in), a juror who took none (unpainted, `0`), and a juror who returned nothing
 * and was substituted a 50 (`no answer`, hatched, never painted). A page that
 * drew the third as a zero would attribute an opinion to somebody who gave none —
 * `packages/db/src/seed/build.ts` refuses to store one for that reason.
 *
 * The number is printed in every painted cell, so no value on this figure is
 * reachable only through colour, and the readout is a supplement rather than a
 * gate. `tabindex` is on painted cells only: an empty cell has nothing to reveal,
 * and thirty tab stops that mostly say "0" would be a worse keyboard experience
 * than the table view underneath.
 */
function matrixCell(cell: MatrixCell, column: number, columns: number, lastRow: boolean): string {
  const metric = metricLabel(cell.metric);

  if (cell.substituted) {
    return (
      `<span class="mxc ksub" data-points="0" role="img" ` +
      `aria-label="${escapeHtml(`${cell.role} returned no answer on ${metric}`)}">n/a</span>`
    );
  }
  if (cell.points === 0) {
    return (
      `<span class="mxc k0" data-points="0" role="img" ` +
      `aria-label="${escapeHtml(`${cell.role} took nothing off ${metric}`)}">0</span>`
    );
  }

  // A readout that would run off the right edge of the card is flipped to hang
  // from the cell's right edge instead; the bottom row hangs upward. The page has
  // no script, so the decision is made here, where the column index is known.
  const flip = [column >= columns - 2 ? 'tr' : '', lastRow ? 'tu' : ''].filter((part) => part !== '').join(' ');

  const reasons = cell.deductions
    .map((deduction) => `<i>&minus;${deduction.points} &middot; ${escapeHtml(deduction.reason)}</i>`)
    .join('');

  return [
    `<span class="mxc k${cell.step}" data-points="${cell.points}" tabindex="0" role="img" `,
    `aria-label="${escapeHtml(`${cell.role} took ${cell.points} off ${metric}`)}">`,
    `${cell.points}`,
    `<span class="tip${flip === '' ? '' : ` ${flip}`}" aria-hidden="true">`,
    `<b>&minus;${cell.points} on ${escapeHtml(metric)}</b>`,
    `<em>${escapeHtml(cell.role)}</em>`,
    reasons,
    '</span></span>',
  ].join('');
}

/**
 * The matrix, as a table, for every reader colour cannot serve.
 *
 * Not an alternative to the grid — the same numbers, in a form that survives
 * greyscale printing, `forced-colors`, a screen reader, and a reader who simply
 * wants to compare two rows without moving a pointer. `anti-patterns.md` treats
 * its absence as a defect on any continuous scale, and `test/verdict-page.test.ts`
 * asserts that every cell's number appears here too.
 */
function matrixTable(matrix: CutMatrix, verdict: Verdict): string {
  const head = matrix.metrics
    .map((name) => `<th scope="col">${escapeHtml(metricLabel(name))}</th>`)
    .join('');

  const body = matrix.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) =>
          cell.substituted
            ? '<td>no answer</td>'
            : `<td>${cell.points === 0 ? '0' : `&minus;${cell.points}`}</td>`,
        )
        .join('');
      return (
        `<tr><th scope="row">${escapeHtml(row.role)}</th>${cells}` +
        `<td>&minus;${row.total}</td>` +
        `<td>${row.meanScore === null ? '&mdash;' : n1(row.meanScore)}</td></tr>`
      );
    })
    .join('');

  const foot = matrix.columnTotals.map((total) => `<td>&minus;${total}</td>`).join('');

  return [
    '<details class="tv">',
    '<summary>As a table</summary>',
    '<div class="tvscroll">',
    '<table>',
    `<caption>Points each juror took off each metric on ${escapeHtml(verdict.name)}. `,
    'A juror scores every metric out of 100 of their own, so these are their raw points &mdash; ',
    'not the merged cut, which is 100 minus the mean of the six.</caption>',
    `<thead><tr><th scope="col">Juror</th>${head}`,
    '<th scope="col">Points taken</th><th scope="col">Mean score given</th></tr></thead>',
    `<tbody>${body}</tbody>`,
    `<tfoot><tr><th scope="row">All jurors</th>${foot}<td>&minus;${matrix.rows.reduce((sum, row) => sum + row.total, 0)}</td><td></td></tr></tfoot>`,
    '</table>',
    '</div>',
    '</details>',
  ].join('');
}

/**
 * The juror × metric heatmap: who cut you, and where.
 *
 * `references/choosing-a-form.md` sends magnitude across a grid of two
 * categorical dimensions to a heatmap on a sequential ramp, and that is exactly
 * the shape of this data: six jurors down, the metrics across, the points that
 * juror took off that metric in the cell. It replaces the per-metric stacked
 * juror bar this page used to draw five times — the same attribution, but the
 * whole panel is legible at once and a reader can run their eye down a column to
 * see one metric's damage or across a row to see one juror's.
 *
 * The ramp is `--cut` in five validated steps — see `charts.ts`. The columns are
 * the ledger's order, heaviest merged loss first, so the leftmost column is where
 * the panel took the most.
 *
 * ## This figure plots CUTS, and that is the exception, on purpose
 *
 * Every other figure on this page plots what survived: the meter's head, both
 * radials, and the per-metric bars, which were turned round to match them. This
 * one was left alone, and it must stay left alone.
 *
 * A heatmap encodes magnitude as darkness, and the magnitude here is damage. Plot
 * health instead and the heaviest cut on the card becomes the palest cell in the
 * grid — damage would read as absence, which is the one reading a damage matrix
 * must not support — and the surviving quantity would either ride the `--cut`
 * ramp, saying "taken" about what was kept, or need a second five-step ramp in the
 * other hue, which is a second colour scale for one page. The grid also has no
 * direction to be inconsistent with: both of its dimensions are categorical, so
 * nothing on it "points" the way a bar or a spoke does. The consistency the rest
 * of the page owes a reader is about axes, and this figure has none.
 *
 * `charts.ts` declares it `more-is-worse` and `test/verdict-polarity.test.ts`
 * holds it to `--cut`, so the exception is checked rather than merely intended.
 * Do not "fix" it.
 */
function matrixFigure(verdict: Verdict): string {
  const matrix = cutMatrix(verdict);
  if (matrix.rows.length === 0 || matrix.metrics.length === 0) return '';

  const columns = matrix.metrics.length;

  const headers = matrix.metrics
    .map(
      (name, index) =>
        `<span class="mxch" title="${escapeHtml(name)}">${escapeHtml(metricLabel(name))}` +
        `<b>&minus;${matrix.columnTotals[index] ?? 0}</b></span>`,
    )
    .join('');

  const rows = matrix.rows
    .map((row, rowIndex) => {
      const lastRow = rowIndex === matrix.rows.length - 1;
      const cells = row.cells
        .map((cell, columnIndex) => matrixCell(cell, columnIndex, columns, lastRow))
        .join('');
      const mean = row.meanScore === null ? 'no answers' : `gave ${n1(row.meanScore)} / 100`;
      return (
        `<span class="mxrh">${escapeHtml(row.role)}` +
        `<em>&minus;${row.total} &middot; ${mean}</em></span>${cells}`
      );
    })
    .join('');

  const key = CUT_RAMP.map(
    (_, index) => `<span><i class="k${index + 1}"></i>${rampLabel(index + 1)}</span>`,
  ).join('');

  // The deepest single cut is NOT named here. It is the left-hand line at the top
  // of the page, chosen by `verdict.sharpest`; naming it again from `matrix
  // .heaviest`, which breaks ties by a different rule, put two different jurors
  // beside the same −50 on one page.
  return [
    '<figure class="fig mxfig">',
    '<figcaption class="rtitle">Where the cuts landed</figcaption>',
    '<div class="well2 mxscroll">',
    `<div class="mxgrid" style="--cols:${columns}">`,
    '<span></span>',
    headers,
    rows,
    '</div>',
    `<div class="mxkey">${key}`,
    '<span><i class="k0"></i>no cut</span>',
    '<span><i class="ksub"></i>no answer</span>',
    '</div>',
    '</div>',
    '<figcaption class="figcap">Darker is deeper. Hover a cell for the reason.</figcaption>',
    matrixTable(matrix, verdict),
    '</figure>',
  ].join('');
}

/**
 * What survived per metric, with the spread the six disagreed by, on one axis.
 *
 * ## Which way it points, and why it was turned round
 *
 * The bar is **what the metric kept** — the merged score, out of the hundred it
 * started on — and the cut is the remainder of the same track. It used to plot the
 * cut, and that was not wrong on its own: a longer bar meant a deeper loss, the
 * caption said so, and every number beside it agreed. It became wrong when the
 * jury radial three sections above was turned round to plot the health each juror
 * left. Two figures on one page pointing opposite ways make a reader reverse their
 * reading halfway down, and nothing on the page warns them to. So this one turned
 * to match: further along the track is a better card, on the meter, on both
 * radials and here.
 *
 * The paint follows the direction rather than the other way round. `lib/theme.ts`
 * spends `--held` on what survived and `--cut` on what was taken, so the plotted
 * half is `--held` and the remainder is `--cut` — the health meter's construction,
 * one section down. `charts.ts`'s `FIGURE_PAINT` writes that pairing down and
 * `test/verdict-polarity.test.ts` fails if the direction and the paint ever
 * disagree again.
 *
 * The heatmap above is deliberately NOT turned round; `charts.ts` gives the
 * argument at length.
 *
 * ## Why a bar and not a radar
 *
 * This is the chart the founder asked for as a radar, and it is a bar on purpose.
 * `references/anti-patterns.md` rules out the radar twice over — its area grows as
 * the square of the value, so equal differences look unequal, and its axis order
 * is arbitrary, so the SHAPE the reader remembers is an artefact of which metric
 * happened to be drawn first. A radar's one real justification is a baseline ring
 * to compare against, and the frozen payload carries no category median to draw
 * one from: `DECISIONS.md §1.2` moves every z-score on every placement, so a
 * baseline read from the live board would make a shared link change under its
 * reader. Sorted bars on one linear axis give the same five numbers a common
 * scale, room for a real metric name, and space for the spread on the SAME axis —
 * which is the thing a polygon has nowhere to put.
 *
 * `spread` is the population standard deviation of the six jurors' own scores,
 * frozen with the rest. The whisker is `held ± spread` and it is ink, not either
 * accent: it is disagreement, which is neither damage nor survival.
 */
function lossFigure(verdict: Verdict): string {
  const { bars } = lossChart(verdict);
  if (bars.length === 0) return '';

  const rows = bars
    .map((bar) => {
      const flag = bar.widest
        ? '<em>widest split</em>'
        : '';
      const whisker =
        bar.spread <= 0
          ? ''
          : `<i class="lbwhisk" style="left:${pct(bar.low)};width:${pct(bar.high - bar.low)}"></i>`;
      const agreement =
        bar.spread <= 0
          ? 'every juror scored it identically'
          : `the six landed within &plusmn;${n1(bar.spread)} of ${n1(bar.score)}`;
      // The frozen category median, as a tick on the bar's own axis — which is
      // now the axis of what was KEPT, so the tick sits at what the middle
      // product kept. `null` on a verdict issued before comparisons were frozen:
      // those bars carry no tick rather than a tick at some invented place.
      const median =
        bar.categoryHeld === null
          ? ''
          : `<i class="lbmed" style="left:${pct(bar.categoryHeld)}"></i>`;
      const against =
        bar.categoryCuts === null || bar.categoryHeld === null
          ? ''
          : `<i>The middle product on this board kept ${n1(bar.categoryHeld)} here, losing ${n1(bar.categoryCuts)}.</i>`;
      return [
        '<div class="lbrow" tabindex="0" role="img" ',
        `aria-label="${escapeHtml(
          `${metricLabel(bar.metric)}: ${n1(bar.held)} of 100 held, ${n1(bar.cuts)} in cuts, ` +
            `cross-juror spread ${n1(bar.spread)}, ${bar.cutters} of ${bar.jurors} jurors cut here` +
            (bar.categoryHeld === null ? '' : `, category median held ${n1(bar.categoryHeld)}`),
        )}">`,
        `<span class="lbname" title="${escapeHtml(bar.metric)}">${escapeHtml(metricLabel(bar.metric))}${flag}</span>`,
        // Order matters: the kept head, then the cut that fills the rest of the
        // hundred, then the marks that sit over both of them.
        `<span class="lbtrack"><i class="lbfill" style="width:${pct(bar.held)}"></i>` +
          `<i class="lbcut" style="left:${pct(bar.held)};width:${pct(bar.cuts)}"></i>` +
          `${whisker}${median}</span>`,
        // The merged score, then the two things that qualify it: how far off the
        // board's middle it is, and how far the six spread around it. The delta
        // wears neither hue — a comparison is not a half of the hundred, and the
        // theme spends its colours on nothing that is merely a state.
        `<span class="lbval"><b class="held">${n1(bar.held)}</b>` +
          `<em>${
            bar.categoryHeld === null
              ? `&minus;${n1(bar.cuts)} cut`
              : `${bar.held >= bar.categoryHeld ? '+' : '&minus;'}${n1(Math.abs(bar.held - bar.categoryHeld))} vs board`
          } &middot; &plusmn;${n1(bar.spread)}</em></span>`,
        '<span class="tip" aria-hidden="true">',
        `<b>&minus;${n1(bar.cuts)} on ${escapeHtml(metricLabel(bar.metric))}</b>`,
        `<em>${bar.cutters} of ${bar.jurors} jurors cut here</em>`,
        `<i>Kept ${n1(bar.held)} of 100 &mdash; ${agreement}.</i>`,
        against,
        '</span>',
        '</div>',
      ].join('');
    })
    .join('');

  return [
    '<figure class="fig">',
    '<div class="well2">',
    rows,
    '<div class="lbaxis"><span></span>',
    '<span class="lbticks"><span style="left:0">0</span>',
    '<span class="tm" style="left:25%">25</span><span class="tm" style="left:50%">50</span>',
    '<span class="tm" style="left:75%">75</span><span class="t1">100</span></span>',
    '<span></span></div>',
    '</div>',
    '<figcaption class="figcap">Green is what survived, red is what came off. ',
    'The whisker is how far the six spread.',
    bars.some((bar) => bar.categoryHeld !== null) ? ' The tick is the board&rsquo;s middle.' : '',
    '</figcaption>',
    '</figure>',
  ].join('');
}

/**
 * One metric block of the ledger: every deduction, in the juror's own words.
 *
 * What is here is the thing no figure can replace: the sentences, at reading
 * size, each with the juror who wrote it. `brief` Part 6 leads with those, and
 * the charts exist to get a reader to the right one.
 *
 * ## Collapsed, and why that is not hiding evidence
 *
 * Thirty deductions in a flat list is the long tail of this page. Every one of
 * them is still in the document — this is a `<details>`, not a fetch, so a saved
 * copy, a printed copy, a screen reader and Ctrl-F all reach every line whether
 * or not it is open. What changes is that the page no longer OPENS on its own
 * footnotes. The heaviest metric is expanded, because that is the block a reader
 * who scrolled this far came for.
 */
function ledger(verdict: Verdict): string {
  return verdict.metrics
    .map((metric, index) => {
      const deductions = metric.deductions
        .map(
          (deduction) =>
            '<div class="ded">' +
            `<span class="pts">&minus;${deduction.points}</span>` +
            `<span>${escapeHtml(deduction.reason)} <span class="who">&mdash; ${escapeHtml(deduction.role)}</span></span>` +
            '</div>',
        )
        .join('');

      const nothing =
        metric.deductions.length === 0 ? '<div class="ded"><span class="pts"></span><span class="who">nothing came off this metric</span></div>' : '';

      const substituted =
        metric.substituted.length === 0
          ? ''
          : `<p class="subs">no answer from ${escapeHtml(metric.substituted.join(', '))} &mdash; substituted 50, and counted that way in the rank</p>`;

      return [
        // Heaviest first — `verdict.metrics` is already in that order — and the
        // heaviest is the one that opens.
        `<details class="ledger"${index === 0 ? ' open' : ''}>`,
        '<summary>',
        `<span class="mt" title="${escapeHtml(metric.metric)}">${escapeHtml(metricLabel(metric.metric))}</span>`,
        `<span class="sc">&minus;${n1(metric.cuts)} &middot; ${n1(metric.score)} / 100 &middot; &plusmn;${n1(metric.spread)}</span>`,
        '</summary>',
        '<div class="body">',
        deductions,
        nothing,
        substituted,
        '</div>',
        '</details>',
      ].join('');
    })
    .join('');
}

/**
 * The Floor.
 *
 * The solo arm is the point of this function. 32 of 48 Developer Tools products
 * and 26 of 44 Health & Fitness products had no cluster peers, so for most
 * customers the Floor never convened — `DECISIONS.md` S3 renormalises them to
 * merit at weight 1.0 and S11 makes that a DELIVERY, not a failure. Rendering it
 * as a missing section or an empty state would tell the majority of paying
 * customers that nothing happened. It is a fact, and it comes with its reason.
 */
function buyerCards(verdict: Verdict): string {
  const labels = panelLabels(verdict);

  // `null` for a solo cluster, and that is the majority case. The solo statement
  // lives in `clusterSection` instead, beside the cluster that produced it —
  // `DECISIONS.md` S11 makes an empty Floor a DELIVERY, so it is a fact about
  // what was judged and not an empty half of a chart row.
  const chart = demandChart(verdict);
  const { floor } = verdict;
  if (chart === null || floor.kind !== 'convened') return '';

  const picks = chart.rows
    .map((row) => {
      const label = row.pick === 'first' ? '1st' : '2nd';
      const strength = row.strength === null ? '' : ` &middot; ${row.strength}`;
      // The bar is the conviction the buyer put behind the choice, on a 0-100
      // axis shared by every row. A runner-up has none to draw — `01 §6.2`
      // records a strength only on a first pick — so that row says so instead of
      // drawing a bar of zero, which would read as "they picked you and meant
      // nothing by it".
      const bar =
        row.strength === null
          ? `<div class="dnone">${row.pick === 'second' ? 'runner-up choices carry no conviction score' : 'no conviction score recorded for this choice'}</div>`
          : '<div class="dbar">' +
            '<span class="dk">Conviction</span>' +
            `<span class="dtrack"><i class="dfill" style="width:${pct(row.strength)}"></i></span>` +
            `<span class="dval">${row.strength} / 100</span>` +
            '</div>';

      return (
        '<div class="dblk">' +
        '<div class="pick">' +
        `<span class="p${row.pick === 'second' ? ' second' : ''}">${label}${strength}</span>` +
        `<span>${escapeHtml(row.reason)} <span class="who">&mdash; ${escapeHtml(row.persona)}</span></span>` +
        '</div>' +
        bar +
        '</div>'
      );
    })
    .join('');

  const empty =
    chart.rows.length === 0
      ? `<p>Every one of the ${chart.roster} ${escapeHtml(labels.buyers.toLowerCase())} reached for something else.</p>`
      : '';

  // The buyers who did not name it are a COUNT and never a set of rows: the
  // payload carries the personas who picked (`demand_detail.picks`) and the size
  // of the roster, never the names of the ones who did not. Naming them would be
  // inventing data; leaving them out entirely would let "5 named you" read as
  // "everyone named you".
  const silent =
    chart.silent === 0
      ? `<div class="dsilent">All <b>${chart.roster}</b> ${escapeHtml(labels.buyers.toLowerCase())} named it.</div>`
      : `<div class="dsilent"><b>${chart.silent}</b> of ${chart.roster} reached for something else.</div>`;

  // The four numbers `01 §6.2` reduces the forced choices through. Only one of
  // them needs a definition on the page: `breadth = share × capture` is the one
  // composition a reader cannot guess from the label, and the other three notes
  // were three sentences explaining arithmetic nobody asked about.
  const parts = chart.parts
    .map(
      (part) =>
        '<div class="dpart">' +
        `<span class="dk">${escapeHtml(part.label)}<b>${n2(part.value)}</b></span>` +
        `<span class="dtrack"><i class="dfill" style="width:${pct(part.value * 100)}"></i></span>` +
        (part.label === 'Breadth' ? '<p>share &times; capture</p>' : '') +
        '</div>',
    )
    .join('');

  return [
    '<div class="blk bcards">',
    `<p class="bhead"><b>${chart.named} of ${chart.roster}</b> ${escapeHtml(labels.buyers)} named this product.</p>`,
    empty,
    picks,
    silent,
    `<div class="dparts">${parts}</div>`,
    // Only `demand` — the other four are the meters directly above, and printing
    // them again as a line of mono was the same five numbers twice.
    `<p class="dnums">demand ${n2(chart.demand)}</p>`,
    '</div>',
  ].join('');
}

/**
 * The cluster the product was judged inside. `brief` Part 6 lists it by name.
 *
 * Scarcity gets a meter rather than only a fraction because it is the one number
 * on this page that moves the rank without anybody writing a reason for it: it
 * tilts `core` through `uniqueness_lambda`, and a reader who has just been shown
 * six jurors' sentences deserves to see the size of the thumb on the scale.
 */
function clusterSection(verdict: Verdict): string {
  const { cluster, floor } = verdict;
  // A solo cluster is the majority case and is stated here, where the cluster
  // that produced it is: `DECISIONS.md` S3 renormalises the row to merit at
  // weight 1.0 and S11 calls the empty Floor a delivery. Rendering it as a
  // missing section would tell most paying customers that nothing happened.
  const solo =
    floor.kind === 'solo'
      ? '<p><b>Nothing close enough to compare. Ranked on merit alone.</b> The demand weight moved onto merit rather than scoring a zero.</p>'
      : '';

  return [
    '<section>',
    '<h2>Judged inside</h2>',
    '<div class="blk">',
    `<p><b>${escapeHtml(cluster.label)}</b> &middot; ${cluster.size} product${cluster.size === 1 ? '' : 's'} &middot; scarcity ${cluster.uniqueness}/100</p>`,
    `<p>${escapeHtml(cluster.reason)}</p>`,
    solo,
    '<div class="dbar">',
    '<span class="dk">Scarcity</span>',
    `<span class="dtrack"><i class="dfill" style="width:${pct(cluster.uniqueness)}"></i></span>`,
    `<span class="dval">${cluster.uniqueness} / 100</span>`,
    '</div>',
    `<p class="dnums">this board tilted the blend by ${verdict.weights.uniqueness_lambda} of it</p>`,
    '</div>',
    '</section>',
  ].join('');
}

/**
 * Where this product stood, as a share of the board rather than as a z-score.
 *
 * "Merit composite 1.45 / Customer demand 0.78 / Ranked by 1.76" were the three
 * numbers a founder was given to read, and they are z-scores: they mean nothing
 * without the population they were standardised against, and the population moves
 * on every placement (`DECISIONS.md §1.2`). A percentile is arithmetic on the two
 * numbers the stamp already carries — the rank and the count — so it says nothing
 * this page has not already frozen, and it says it in a unit people read.
 *
 * Floored at 1, because #1 of 200 rounds to "top 0%" and a share of a board is
 * never zero. Capped at 100 for the same reason from the other end.
 */
export function boardPercentile(rank: number, count: number): number {
  if (count <= 0) return 100;
  return Math.min(100, Math.max(1, Math.round((rank / count) * 100)));
}

/** The full document. */
export function renderVerdictPage(verdict: Verdict, options: RenderOptions = {}): string {
  const origin = options.origin ?? PIT_ORIGIN;
  const canonical = `${origin}/v/${encodeURIComponent(verdict.slug)}`;
  const ogImage = `${canonical}/og`;
  const labels = panelLabels(verdict);

  const title = `${verdict.name} — ${Math.round(verdict.cuts)} in cuts — The Pit`;
  // The social description is the stamped rank, never a bare one. `brief` Part 5.
  const description = `${cutsLine(verdict)} Ranked ${stampedRank(verdict)} in ${verdict.category}.`;

  const pitch = verdict.pitchLabel === null ? '' : `<span class="pitch">${escapeHtml(verdict.pitchLabel)}</span>`;

  // The plate. An anonymous listing has a deterministic robot frozen with it; a
  // named one gets its initial, because this document may carry no <img> and a
  // favicon fetched at render time would break the offline guarantee.
  const plate =
    verdict.anonymous && verdict.robot !== undefined
      ? verdict.robot
      : escapeHtml((verdict.name.trim()[0] ?? '?').toUpperCase());

  // The one-line sub under the hero number: where on the board, and how many
  // buyers reached for it. Both are arithmetic on frozen figures.
  const standing = [
    `Top ${boardPercentile(verdict.rank, verdict.productCount)}% of the board`,
    verdict.floor.kind === 'convened'
      ? `${verdict.floor.firstPicks + verdict.floor.secondPicks} of ${verdict.floor.rosterSize} ${labels.buyers}`
      : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="The Pit">
<meta property="og:title" content="${escapeHtml(cutsLine(verdict))}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(cutsLine(verdict))}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
${FONTS}
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

<nav>
  <a class="mark" href="${escapeHtml(origin)}/">THE <i>PIT</i></a>
  <span class="navr"><a href="${escapeHtml(origin)}/how-it-works">How it works</a> <a href="${escapeHtml(origin)}/boards">Boards</a> <a href="${escapeHtml(origin)}/auth/sign-in">Sign in</a></span>
</nav>

<header class="vhead">
  <div class="vid">
    <div class="vwho">
      <span class="vfav" aria-hidden="true">${plate}</span>
      <div class="vname">
        <h1>${escapeHtml(verdict.name)}</h1>
        <span class="vcat">${escapeHtml(verdict.category)} &middot; judged ${escapeHtml(stampDate(verdict.issuedAt))}</span>
        ${
          verdict.anonymous
            ? '<span class="vurl plink">Name and URL withheld.</span>'
            : `<span class="vurl">${productLink(verdict.url)}</span>`
        }
      </div>
    </div>
    <div class="vrank">
      <b title="${escapeHtml(stampedRank(verdict))}"><u>#</u>${verdict.rank}<i> / ${verdict.productCount}</i></b>
      <small>${escapeHtml(standing)}</small>
      ${pitch}
    </div>
  </div>

  ${healthMeter(verdict)}

  <div class="vlines">
    ${sharpestLine(verdict)}
    ${wantedLine(verdict)}
  </div>

  ${renderShareRow(verdict, { origin })}
</header>

<section>
  <h2>The scorecard</h2>
  <p class="lede">Being weak and having ${escapeHtml(labels.jury)} <i>agree</i> you were weak are two findings.</p>
  ${lossFigure(verdict)}
</section>

${panelSection(verdict, origin)}

${clusterSection(verdict)}

<section>
  <h2>Every cut, in the juror's own words</h2>
  <p class="lede">Raw points per juror.</p>
  ${ledger(verdict)}
</section>

<footer>
  <b>${escapeHtml(verdict.name)}</b> &middot; ${verdict.productCount} products &middot; issued ${escapeHtml(stampTime(verdict.issuedAt))}${verdict.pitchLabel === null ? '' : ` &middot; ${escapeHtml(verdict.pitchLabel)}`}<br>
  jury ${escapeHtml(verdict.versions.prompt)} &middot; panel ${escapeHtml(verdict.versions.persona)} &middot; scarcity ${escapeHtml(verdict.versions.uniqueness)} &middot; category snapshot ${escapeHtml(verdict.versions.categorySnapshot)}<br>
  weights: merit ${verdict.weights.merit} &middot; demand ${verdict.weights.demand} &middot; scarcity tilt ${verdict.weights.uniqueness_lambda}${verdict.tiebroken ? ' &middot; demand and scarcity moved this row off its pure-merit position' : ''}<br>
  <br>
  This page was frozen when it was issued and never recomputed &mdash; the comparison shapes above
  included. <a href="${escapeHtml(canonical)}?download=1" download="the-pit-${escapeHtml(verdict.slug)}.html">Download this page</a> &middot;
  <a href="${escapeHtml(origin)}/how-it-works">How this works</a> &middot;
  <a href="${escapeHtml(origin)}/">thepit.show</a>
</footer>

</div>
</body>
</html>`;
}

/**
 * A slug that resolves to nothing.
 *
 * A 404 rather than an empty verdict, and it says which slug: a shared link that
 * stopped working is a support email, and the reply is faster if the page named
 * the thing it could not find. The slug is escaped — it arrives from the URL.
 */
export function renderVerdictNotFound(slug: string, options: RenderOptions = {}): string {
  const origin = options.origin ?? PIT_ORIGIN;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>No verdict here — The Pit</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav>
  <a class="mark" href="${escapeHtml(origin)}/">THE <i>PIT</i></a>
  <span class="navr"><a href="${escapeHtml(origin)}/how-it-works">How it works</a> <a href="${escapeHtml(origin)}/boards">Boards</a> <a href="${escapeHtml(origin)}/auth/sign-in">Sign in</a></span>
</nav>
<div class="notfound">
No verdict has been issued at <b>${escapeHtml(slug)}</b>. Check the link.
</div>
</div>
</body>
</html>`;
}
