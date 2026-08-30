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
 * It also means the page has no client JavaScript at all, and the figures below
 * are held to that: the heatmap's hover readouts, the bar tooltips and the table
 * views are CSS and native `<details>`, so a copy saved to disk is as interactive
 * as the served page. `test/verdict-page.test.ts` asserts the absence of a
 * `<script` tag, which is the rule stated as a test rather than as a habit.
 *
 * ## What is on it, and why each figure is the figure it is
 *
 * `brief` Part 6: "lead with deductions and reasons, not composites". A founder
 * paying for this wants four answers — *who cut me, where, how badly, did the
 * panel agree, did any buyer want this* — so the page is those four answers in
 * that order, and every mark on it is a deduction somebody wrote a reason for.
 * `charts.ts` derives every plotted number and carries the form argument for each
 * (including why the radar the founder asked for lost to a sorted bar). In short:
 *
 * - **The health meter**, on the card. Part-to-whole: the hundred points this
 *   product walked in with, the `--held` head it walked out with, and each
 *   metric's exact `--cut` share of what came off.
 * - **The juror × metric heatmap.** Magnitude across two categorical dimensions,
 *   so a sequential ramp on the one hue the theme has. It answers "who cut me and
 *   where" in one glance and every cell carries the juror's own sentence.
 * - **Loss per metric with the cross-juror spread**, on one shared 0–100 axis.
 *   Whether the six AGREED you were weak is different information from being
 *   weak, and it is the most actionable line on the page.
 * - **The Floor**, as a conviction bar per buyer who named you — or, for the
 *   majority of products, the stated fact that no buyer was ever shown it.
 *
 * The composites — merit, demand, the blended core — stay where `brief` Part 6
 * puts them: five small lines on the card, in mono, at 14px.
 *
 * ## Where the design comes from
 *
 * `lib/theme.ts`, the same values and two families every other surface uses,
 * interpolated into this document so a saved copy carries its own theme. The card
 * keeps the hierarchy the surface has always had — the header strip with the
 * category and the name, the oversized rank that cannot be printed without its
 * product count and its date, the summary lines, the pull-quote from the sharpest
 * juror, the mono footer with the versions.
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

import { HEALTH_NOTE } from '@/lib/boards/copy';
import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

import {
  CUT_RAMP,
  cutMatrix,
  demandChart,
  lossBars,
  rampLabel,
  type CutMatrix,
  type MatrixCell,
} from './charts';
import type { Verdict, VerdictDeduction, VerdictMetric } from './model';

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
.wrap{max-width:820px}

/* ---------- the card ---------- */
.vcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r3);
  box-shadow:var(--lip),var(--e3);margin-top:14px;overflow:hidden}
/* The card's masthead is --rise, the top of the stack: the verdict's own rim,
   with the cut rule under it as the first step down. */
.vtop{background:var(--rise);color:var(--ink);padding:20px 24px 22px;position:relative;
  box-shadow:var(--lip)}
.vtop::after{content:"";position:absolute;left:0;bottom:0;height:3px;width:34%;background:var(--cut)}
.vtop .lbl{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.17em;
  text-transform:uppercase;color:var(--dimmer)}
.vtop h1{font-weight:700;font-size:clamp(23px,4.2vw,34px);line-height:1.06;
  letter-spacing:-.03em;margin-top:9px;overflow-wrap:anywhere}
.vtop .purl{display:block;margin-top:10px}
.plink{font-family:var(--mono);font-size:11px;color:var(--dimmer);
  text-decoration:none;overflow-wrap:anywhere}
a.plink:hover{color:var(--ink);text-decoration:underline}

.vrank{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;
  padding:20px 24px 18px;border-bottom:1px solid var(--line)}
.vrank .big{font-weight:800;font-size:54px;line-height:.84;letter-spacing:-.05em;
  font-variant-numeric:tabular-nums}
.vrank .of{font-size:13.5px;line-height:1.5;color:var(--dim);max-width:34ch}
.vrank .of b{display:block;color:var(--ink);font-size:14px;font-weight:600}
.pitch{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dim);border:1px solid var(--line);border-radius:999px;
  padding:4px 10px;align-self:center;margin-left:auto}

/* ---------- the health meter, on the card ---------- */
/*
 * The meter itself is lib/theme.ts's, unmodified: the same element, the same
 * .row / .kept / .seg structure, the same colours. It used to be a local
 * copy with its own .kept painted rgb(--ink-c / .40), and that copy is why
 * this page kept drawing the surviving half in grey after every other surface had
 * moved it to --held. A copied rule is a rule that drifts; two overrides — the
 * card wants a taller bar with air above it — are not.
 *
 * --held is the health that survived and --cut is what was taken, and the
 * caption below names both in their own colour. theme.ts states the rule; this
 * page now obeys it by inheritance rather than by agreement.
 */
.vmeter{padding:18px 24px 20px;border-bottom:1px solid var(--line)}
.vmeter .cap{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;
  font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:10.5px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--dimmer)}
.vmeter .cap .held{font-size:10.5px;letter-spacing:.06em}
.vmeter .cap .pts{font-size:10.5px;letter-spacing:.06em}
.vmeter .meter{height:14px;margin-top:9px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
.vmeter .meter .seg.s6{background:rgb(var(--cut-c) / .58)}
.vnote{display:block;margin-top:10px;font-family:var(--mono);font-size:10px;
  line-height:1.65;color:var(--faint);letter-spacing:.02em}
.vkeys{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:11px;
  font-family:var(--mono);font-size:10.5px;color:var(--dim)}
.vkeys span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.vkeys i{display:inline-block;width:9px;height:9px;border-radius:0;background:var(--cut)}
.vkeys i.s2{background:rgb(var(--cut-c) / .90)}
.vkeys i.s3{background:rgb(var(--cut-c) / .80)}
.vkeys i.s4{background:rgb(var(--cut-c) / .71)}
.vkeys i.s5{background:rgb(var(--cut-c) / .64)}
.vkeys i.s6{background:rgb(var(--cut-c) / .58)}
.vkeys b{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}

.vbody{padding:16px 24px 20px}
.vline{display:flex;justify-content:space-between;gap:14px;font-size:14px;padding:9px 0;
  border-bottom:1px solid var(--hair)}
.vline:last-of-type{border-bottom:0}
.vline span:first-child{color:var(--dim)}
.vline span:last-child{font-family:var(--mono);font-variant-numeric:tabular-nums;
  font-weight:600;text-align:right}
.vline .none{color:var(--dim);font-weight:500}
.vquote{font-size:16px;line-height:1.5;color:var(--ink);border-left:3px solid var(--cut);
  padding-left:16px;margin-top:20px;font-weight:500;letter-spacing:-.008em}
.vquote cite{display:block;font-style:normal;font-family:var(--mono);font-size:10.5px;
  color:var(--dimmer);margin-top:9px;letter-spacing:.04em}
.vfoot{background:var(--wash);border-top:1px solid var(--line);padding:12px 24px;
  font-family:var(--mono);font-size:10.5px;line-height:1.7;color:var(--dimmer);
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}

.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}

/* ---------- the evidence ---------- */
.ledger{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--lip),var(--e1);padding:15px 17px 13px;margin-top:14px}
.ledger-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.ledger-h .mt{font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.ledger-h .sc{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;
  color:var(--dimmer);white-space:nowrap}
.ded{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;font-size:14px;
  line-height:1.5;color:var(--dim);margin-top:11px;padding-top:11px;border-top:1px solid var(--hair)}
.ledger-h + .ded{border-top:0}
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
.solo{background:var(--sunk);box-shadow:none}
.dnums{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;
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
.fig{margin-top:16px}
.well2{background:var(--sunk);border:1px solid var(--hair);border-radius:var(--r2);
  padding:14px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
.figcap{font-family:var(--mono);font-size:10.5px;line-height:1.6;color:var(--dimmer);
  letter-spacing:.02em;margin-top:10px}
.figcap b{color:var(--dim);font-weight:500}

/* ---------- the juror x metric matrix ---------- */
/*
 * A CSS grid rather than an SVG: the cells are text as well as fill, they must
 * wrap their own headers, and the hover readout is a positioned element that a
 * viewBox would have had to fake. The 2px grid gap IS the surface gap the mark
 * spec asks for — the separation is the well showing through, never a stroke
 * drawn around a cell.
 */
.mxgrid{display:grid;gap:2px;
  grid-template-columns:minmax(104px,1.2fr) repeat(var(--cols),minmax(52px,1fr))}
.mxch{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dimmer);line-height:1.3;padding:0 3px 6px;
  align-self:end;text-align:center;overflow-wrap:anywhere}
.mxch b{display:block;font-weight:600;color:var(--dim);font-variant-numeric:tabular-nums;
  letter-spacing:.02em;margin-top:3px}
.mxrh{display:flex;flex-direction:column;justify-content:center;gap:2px;padding:4px 10px 4px 0;
  font-size:12.5px;line-height:1.25;color:var(--ink);overflow-wrap:anywhere}
.mxrh em{font-style:normal;font-family:var(--mono);font-size:10px;color:var(--dimmer);
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
.lbrow:hover .tip,.lbrow:focus .tip,.lbrow:focus-visible .tip{opacity:1;visibility:visible}
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
  grid-template-columns:minmax(96px,1.1fr) minmax(0,2.4fr) minmax(74px,auto)}
.lbrow + .lbrow{border-top:1px solid var(--hair)}
.lbname{font-size:13px;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
 /* The direct label marks the metric the panel split widest on. That is neither
    taken nor survived, so it wears neither hue — ink, which is what everything
    that is merely a fact wears in this theme. */
.lbname em{display:block;font-style:normal;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:3px}
/* Gridlines: solid hairlines one step off the surface, at the quartiles, never dashed. */
.lbtrack{position:relative;height:12px;background:var(--sunk);
  box-shadow:inset 0 1px 2px rgb(var(--shade-c) / .55);
  background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),
    rgb(var(--ink-c) / .11) calc(25% - 1px),rgb(var(--ink-c) / .11) 25%)}
.lbfill{position:absolute;left:0;top:0;bottom:0;background:var(--cut)}
/* The whisker is uncertainty, not loss, so it is ink and never the accent. */
.lbwhisk{position:absolute;top:50%;height:1px;margin-top:-1px;background:rgb(var(--ink-c) / .90)}
.lbwhisk::before,.lbwhisk::after{content:"";position:absolute;top:-4px;width:1px;height:9px;
  background:rgb(var(--ink-c) / .90)}
.lbwhisk::before{left:0}
.lbwhisk::after{right:0}
.lbval{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;
  color:var(--ink);text-align:right;line-height:1.3}
.lbval em{display:block;font-style:normal;font-size:10px;color:var(--dimmer)}
 /* The axis has to share the ROW's grid, not the card's width: its ticks mean
    nothing unless 0 and 100 sit on the ends of the track they scale. Drawn as a
    .lbrow with an empty label cell and an empty value cell, so the three columns
    line up by construction rather than by a matching magic number. */
.lbaxis{display:grid;gap:12px;margin-top:2px;
  grid-template-columns:minmax(96px,1.1fr) minmax(0,2.4fr) minmax(74px,auto)}
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
.dparts{display:grid;grid-template-columns:repeat(auto-fit,minmax(152px,1fr));gap:14px 18px;
  margin-top:16px;padding-top:14px;border-top:1px solid var(--hair)}
.dpart .dk{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:var(--dim)}
.dpart p{font-family:var(--sans);font-size:11.5px;line-height:1.45;color:var(--dimmer);
  margin-top:6px;letter-spacing:0;text-transform:none}

@media (max-width:640px){
  .vtop,.vrank,.vmeter,.vbody,.vfoot{padding-left:16px;padding-right:16px}
  .vrank .big{font-size:44px}
  .pitch{margin-left:0}
  .lbrow{grid-template-columns:minmax(0,1fr) minmax(66px,auto);row-gap:7px}
  .lbtrack{grid-column:1 / -1;order:3}
}
/*
 * Below this width the grid has to scroll, and a scroll container clips an
 * absolutely-positioned readout. Rather than ship a tooltip that is cut in half,
 * the readouts are withdrawn here and the table view — which is always present,
 * carries every number, and is the accessible twin regardless — is the way to
 * read a cell. Touch pointers have no hover to lose.
 */
@media (max-width:560px){
  .mxscroll{overflow-x:auto}
  .mxgrid{min-width:440px}
  .tip{display:none}
}
`;

/** The sharpest juror line, as the card's pull quote. */
function quote(sharpest: VerdictDeduction): string {
  return [
    '<blockquote class="vquote">',
    escapeHtml(sharpest.reason),
    `<cite>${escapeHtml(sharpest.role)} &middot; &minus;${sharpest.points} on ${escapeHtml(metricLabel(sharpest.metric))}</cite>`,
    '</blockquote>',
  ].join('');
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
 * segment after it is `--cut`, one metric's share of what was taken. The caption
 * leads with the health figure and states it in `--held`, which is the correction
 * `lib/theme.ts` documents — a bar whose larger quantity is drawn in the absence
 * of colour is a bar arguing against its own caption.
 *
 * `HEALTH_NOTE` rides underneath, from `lib/boards/copy.ts`, the same sentence the
 * boards carry. It is not optional decoration: the founder's canvas ranks BY
 * health and this board does not — it ranks on `core`, merit blended with demand
 * and tilted by scarcity — so a surface that showed the health figure without the
 * note would publish a sort rule the engine does not run.
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

  const keys = verdict.metrics
    .map(
      (metric, index) =>
        `<span><i class="${segClass(index, '')}"></i>${escapeHtml(metricLabel(metric.metric))} ` +
        `<b>&minus;${n1(share(metric))}</b></span>`,
    )
    .join('');

  return [
    '<div class="vmeter">',
    '<div class="cap">',
    '<span>Walked in at 100</span>',
    `<span><b class="held">${Math.round(health)} health left</b> &middot; ` +
      `<b class="pts">&minus;${Math.round(cuts)} in cuts</b></span>`,
    '</div>',
    `<div class="meter"><span class="row"><i class="kept" style="width:${health}%"></i>${segments}</span></div>`,
    `<div class="vkeys">${keys}</div>`,
    `<span class="vnote">${escapeHtml(HEALTH_NOTE)}</span>`,
    '</div>',
  ].join('');
}

/** A width, as a percentage string with no floating-point tail. */
function pct(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(2)}%`;
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
    '<summary>The same numbers, as a table</summary>',
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
 * The ramp is one hue, the theme's only hue, in five validated steps — see
 * `charts.ts`. The columns are the ledger's order, heaviest merged loss first, so
 * the leftmost column is where the panel took the most.
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

  const heaviest =
    matrix.heaviest === null
      ? ''
      : `<b>${escapeHtml(matrix.heaviest.role)}</b> took the single deepest cut &mdash; ` +
        `&minus;${matrix.heaviest.points} on ${escapeHtml(metricLabel(matrix.heaviest.metric))}. `;

  return [
    '<figure class="fig">',
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
    '<figcaption class="figcap">',
    heaviest,
    'Darker is deeper. Each cell is the points one juror took off one metric, out of the 100 ',
    'that juror scores it on; hover or focus a cell for the sentence behind it.',
    '</figcaption>',
    matrixTable(matrix, verdict),
    '</figure>',
  ].join('');
}

/**
 * Loss per metric, with the spread the six disagreed by, on one axis.
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
 * frozen with the rest. The whisker is `cuts ± spread` and it is ink, not accent:
 * it is disagreement, not damage.
 */
function lossFigure(verdict: Verdict): string {
  const bars = lossBars(verdict);
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
      return [
        '<div class="lbrow" tabindex="0" role="img" ',
        `aria-label="${escapeHtml(
          `${metricLabel(bar.metric)}: ${n1(bar.cuts)} in cuts, cross-juror spread ${n1(bar.spread)}, ` +
            `${bar.cutters} of ${bar.jurors} jurors cut here`,
        )}">`,
        `<span class="lbname" title="${escapeHtml(bar.metric)}">${escapeHtml(metricLabel(bar.metric))}${flag}</span>`,
        `<span class="lbtrack"><i class="lbfill" style="width:${pct(bar.cuts)}"></i>${whisker}</span>`,
        `<span class="lbval">&minus;${n1(bar.cuts)}<em>&plusmn;${n1(bar.spread)}</em></span>`,
        '<span class="tip" aria-hidden="true">',
        `<b>&minus;${n1(bar.cuts)} on ${escapeHtml(metricLabel(bar.metric))}</b>`,
        `<em>${bar.cutters} of ${bar.jurors} jurors cut here</em>`,
        `<i>Merged score ${n1(bar.score)} / 100 &mdash; ${agreement}.</i>`,
        '</span>',
        '</div>',
      ].join('');
    })
    .join('');

  const split = bars.filter((bar) => bar.widest);
  const note =
    split.length === 0 || split[0] === undefined || split[0].spread <= 0
      ? 'The six agreed exactly on every metric here. '
      : `The six split widest on <b>${escapeHtml(metricLabel(split[0].metric))}</b> ` +
        `&mdash; &plusmn;${n1(split[0].spread)} around a merged ${n1(split[0].score)}. ` +
        'A deep cut the panel agreed on is a fact about the product; a deep cut they split over ' +
        'is a fact about how it reads. ';

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
    `<figcaption class="figcap">${note}`,
    'Bars are the merged cut, 100 minus the mean of the six. The ink whisker is one ',
    'cross-juror standard deviation either side of it, on the same axis.',
    '</figcaption>',
    '</figure>',
  ].join('');
}

/** The four summary lines of the mockup's card body. */
function summaryLines(verdict: Verdict): string {
  const labels = panelLabels(verdict);
  const demand =
    verdict.floor.kind === 'convened'
      ? `<span>${n2(verdict.floor.demand)}</span>`
      : `<span class="none">no ${labels.buyers} convened</span>`;
  const picked =
    verdict.floor.kind === 'convened'
      ? `<span>${verdict.floor.firstPicks + verdict.floor.secondPicks} of ${verdict.floor.rosterSize}</span>`
      : `<span class="none">n/a &mdash; solo cluster</span>`;

  return [
    `<div class="vline"><span>Health left</span><span class="held">${Math.round(100 - verdict.cuts)} / 100</span></div>`,
    `<div class="vline"><span>Cuts taken</span><span class="pts">&minus;${Math.round(verdict.cuts)}</span></div>`,
    `<div class="vline"><span>Merit composite</span><span>${n2(verdict.composite)}</span></div>`,
    `<div class="vline"><span>Customer demand</span>${demand}</div>`,
    `<div class="vline"><span>${escapeHtml(labels.floor)} picked you</span>${picked}</div>`,
    `<div class="vline"><span>Ranked by</span><span>${n2(verdict.core)}</span></div>`,
  ].join('');
}

/**
 * One metric block of the ledger: every deduction, in the juror's own words.
 *
 * The stacked juror bar that used to open each of these blocks is gone. It said
 * one metric's loss split by juror, five times over — which is one row of the
 * heatmap above, drawn worse and without the reason attached. What is left here
 * is the thing no figure can replace: the sentences, at reading size, each with
 * the juror who wrote it. `brief` Part 6 leads with those, and the charts exist to
 * get a reader to the right one.
 */
function ledger(verdict: Verdict): string {
  return verdict.metrics
    .map((metric) => {
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
        '<div class="ledger">',
        '<div class="ledger-h">',
        `<span class="mt" title="${escapeHtml(metric.metric)}">${escapeHtml(metricLabel(metric.metric))}</span>`,
        `<span class="sc">${n1(metric.score)} / 100 &middot; spread &plusmn;${n1(metric.spread)} &middot; ${metric.jurors} jurors</span>`,
        '</div>',
        deductions,
        nothing,
        substituted,
        '</div>',
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
function floorSection(verdict: Verdict): string {
  const labels = panelLabels(verdict);

  if (verdict.floor.kind === 'solo') {
    return [
      '<section>',
      `<h2>${escapeHtml(labels.floor)}</h2>`,
      `<p class="lede">Six simulated ${escapeHtml(labels.buyers)} make a forced choice between products that do the same job. That choice needs at least two products to choose between.</p>`,
      '<div class="blk solo">',
      `<p><b>No ${escapeHtml(labels.buyers)} were shown this product, because nothing in the category was close enough to compare it to.</b></p>`,
      `<p>Its cluster &mdash; <b>${escapeHtml(verdict.cluster.label)}</b> &mdash; held ${verdict.floor.clusterSize} product${verdict.floor.clusterSize === 1 ? '' : 's'} on the day this was issued, so there was no substitute to weigh it against and no forced choice to run.</p>`,
      '<p>This is the common case, not a gap in the run. Demand is normally 35% of the blended score; with no demand signal to read, that weight was moved onto merit rather than scored as a zero, so this rank is merit at full weight. It cuts both ways: a strong product gains what a weak one loses.</p>',
      '</div>',
      '</section>',
    ].join('');
  }

  // Never reached for a solo floor: `demandChart` returns null there and the arm
  // above has already returned. The guard is for the type, not for a case.
  const chart = demandChart(verdict);
  if (chart === null) return '';

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
      ? `<p>The ${escapeHtml(labels.buyers)} convened over this cluster and named nobody on this product &mdash; every one of them reached for something else.</p>`
      : '';

  // The buyers who did not name it are a COUNT and never a set of rows: the
  // payload carries the personas who picked (`demand_detail.picks`) and the size
  // of the roster, never the names of the ones who did not. Naming them would be
  // inventing data; leaving them out entirely would let "5 named you" read as
  // "everyone named you".
  const silent =
    chart.silent === 0
      ? `<div class="dsilent">Every one of the <b>${chart.roster}</b> ${escapeHtml(labels.buyers.toLowerCase())} on this run named it.</div>`
      : `<div class="dsilent"><b>${chart.silent}</b> of the ${chart.roster} ${escapeHtml(labels.buyers.toLowerCase())} on this run were shown it beside its cluster peers and reached for something else. The run records who chose you, never who declined, so they are a count here and not a list.</div>`;

  const parts = chart.parts
    .map(
      (part) =>
        '<div class="dpart">' +
        `<span class="dk">${escapeHtml(part.label)}<b>${n2(part.value)}</b></span>` +
        `<span class="dtrack"><i class="dfill" style="width:${pct(part.value * 100)}"></i></span>` +
        `<p>${escapeHtml(part.note)}</p>` +
        '</div>',
    )
    .join('');

  return [
    '<section>',
    `<h2>${escapeHtml(labels.floor)}</h2>`,
    `<p class="lede"><b>${chart.named} of ${chart.roster}</b> simulated ${escapeHtml(labels.buyers)} named this product when they were shown it beside its cluster peers and made a forced choice. These are the ones who named it, why, and how hard.</p>`,
    '<div class="blk">',
    empty,
    picks,
    silent,
    `<div class="dparts">${parts}</div>`,
    '<p class="dnums">',
    `demand ${n2(chart.demand)} &middot; breadth ${n2(verdict.floor.breadth)} &middot; intensity ${n2(verdict.floor.intensity)} `,
    `&middot; capture ${n2(verdict.floor.capture)} &middot; share ${n2(verdict.floor.share)}`,
    '</p>',
    '</div>',
    '</section>',
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
  const { cluster } = verdict;
  return [
    '<section>',
    '<h2>Judged inside</h2>',
    '<p class="lede">Demand is only meaningful against a substitute. Every product is placed in a cluster of things that do the same job, and it is judged against those and no others.</p>',
    '<div class="blk">',
    `<p><b>${escapeHtml(cluster.label)}</b> &middot; ${cluster.size} product${cluster.size === 1 ? '' : 's'} &middot; scarcity ${cluster.uniqueness}/100</p>`,
    `<p>${escapeHtml(cluster.reason)}</p>`,
    '<div class="dbar">',
    '<span class="dk">Scarcity</span>',
    `<span class="dtrack"><i class="dfill" style="width:${pct(cluster.uniqueness)}"></i></span>`,
    `<span class="dval">${cluster.uniqueness} / 100</span>`,
    '</div>',
    `<p class="dnums">a crowded cluster scores low and an uncrowded one high; this board tilted the blend by ${verdict.weights.uniqueness_lambda} of it</p>`,
    '</div>',
    '</section>',
  ].join('');
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
  <span class="navr">verdict &middot; permanent &middot; public</span>
</nav>

<article class="vcard">
  <header class="vtop">
    <span class="lbl">Verdict &middot; ${escapeHtml(verdict.category)}</span>
    <h1>${escapeHtml(verdict.name)}</h1>
    <span class="purl">${productLink(verdict.url)}</span>
  </header>

  <div class="vrank">
    <span class="big">${verdict.rank}</span>
    <span class="of"><b>of ${verdict.productCount} products</b>on ${escapeHtml(stampTime(verdict.issuedAt))}. The board has moved since.</span>
    ${pitch}
  </div>

  ${healthMeter(verdict)}

  <div class="vbody">
    ${summaryLines(verdict)}
    ${verdict.sharpest === null ? '' : quote(verdict.sharpest)}
  </div>

  <div class="vfoot">
    <span>${escapeHtml(stampTime(verdict.issuedAt))}</span>
    <span>jury ${escapeHtml(verdict.versions.prompt)} &middot; panel ${escapeHtml(verdict.versions.persona)} &middot; scarcity ${escapeHtml(verdict.versions.uniqueness)}</span>
  </div>
</article>

<div class="actions">
  <a class="act prime" href="${escapeHtml(canonical)}?download=1" download="the-pit-${escapeHtml(verdict.slug)}.html">Download this page</a>
  <a class="act" href="${escapeHtml(origin)}/">Everyone walks in at 100</a>
</div>

<section>
  <h2>Who cut you, and where</h2>
  <p class="lede"><b>${escapeHtml(cutsLine(verdict))}</b> Everyone walks in at 100. Cuts is 100 minus the mean metric score &mdash; not the sum of the points below, because those are each juror's own deduction off their own 100, and ${escapeHtml(labels.jury.toLowerCase())} cutting 20 each for the same omission is one 20-point cut, not 120.</p>
  ${matrixFigure(verdict)}
</section>

<section>
  <h2>Where it landed, and whether they agreed</h2>
  <p class="lede">Being weak on a metric and having ${escapeHtml(labels.jury)} <i>agree</i> you were weak are two different findings. The bar is the loss; the whisker is how far apart ${escapeHtml(labels.jury)} were when they wrote it.</p>
  ${lossFigure(verdict)}
</section>

<section>
  <h2>Every cut, in the juror's own words</h2>
  <p class="lede">The full ledger, heaviest metric first. Every line is one juror's deduction and the sentence they wrote for it &mdash; the charts above are only a way to find the ones worth reading.</p>
  ${ledger(verdict)}
</section>

${clusterSection(verdict)}
${floorSection(verdict)}

<footer>
  <b>${escapeHtml(verdict.name)}</b> &middot; ${verdict.productCount} products &middot; issued ${escapeHtml(stampTime(verdict.issuedAt))}${verdict.pitchLabel === null ? '' : ` &middot; ${escapeHtml(verdict.pitchLabel)}`}<br>
  prompt ${escapeHtml(verdict.versions.prompt)} &middot; personas ${escapeHtml(verdict.versions.persona)} &middot; scarcity ${escapeHtml(verdict.versions.uniqueness)} &middot; category snapshot ${escapeHtml(verdict.versions.categorySnapshot)}<br>
  weights: merit ${verdict.weights.merit} &middot; demand ${verdict.weights.demand} &middot; scarcity tilt ${verdict.weights.uniqueness_lambda}${verdict.tiebroken ? ' &middot; demand and scarcity moved this row off its pure-merit position' : ''}<br>
  <br>
  This page was frozen when it was issued and never recomputed. The board it describes is rebuilt on
  every placement, so the rank above is what it was on the date stamped beside it &mdash; not what it is
  now. That is why every rank here carries a date and a count. <a href="${escapeHtml(origin)}/">thepit.show</a>
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
  <span class="navr">verdict</span>
</nav>
<div class="notfound">
No verdict has been issued at <b>${escapeHtml(slug)}</b>.<br><br>
Verdict URLs are permanent, so a link that once worked still works. A link that never worked is a
typo, a truncated paste, or a page that has not been delivered yet.
</div>
</div>
</body>
</html>`;
}
