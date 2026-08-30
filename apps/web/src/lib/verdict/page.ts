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
 * It also means the page has no client JavaScript at all. There is one product
 * here, not forty-eight rows, so there is nothing to expand: everything `brief`
 * Part 6 lists — every deduction with its reason and juror, the cluster judged
 * inside, which Floor personas picked them — is on the page when it arrives.
 *
 * ## Where the design comes from
 *
 * `lib/theme.ts`, the same five values and two families every other surface uses,
 * interpolated into this document so a saved copy carries its own theme. The card
 * keeps the hierarchy the surface has always had — the header strip with the
 * category and the name, the oversized rank that cannot be printed without its
 * product count and its date, the summary lines, the pull-quote from the sharpest
 * juror, the mono footer with the versions — and states all of it on paper instead
 * of in the dark.
 *
 * The one new element is the same one the boards gained: **the cut meter**. This
 * product walked in at 100; the graphite head is what survived and every segment
 * after it is one metric's exact share of the loss. Inside the ledger the same bar
 * splits again by juror, which is what makes "every deduction shows the juror" a
 * property of the drawing rather than a caption under it. `components/board-parts.tsx`
 * carries the full reasoning; this is the same figure in a document that has to
 * survive being saved to disk.
 *
 * Everything below the card is the evidence `brief` Part 6 enumerates: the metric
 * bar, the `-NN reason — juror` line, the picks list with its persona chip.
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

/* ---------- the cut meter, on the card ---------- */
.vmeter{padding:18px 24px 20px;border-bottom:1px solid var(--line)}
.vmeter .cap{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;
  font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:10.5px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--dimmer)}
.vmeter .cap b{color:var(--cut);font-weight:600}
.meter{display:flex;height:14px;border-radius:0;background:var(--sunk);overflow:hidden;
  margin-top:9px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
.meter .kept{background:rgb(var(--ink-c) / .40);height:100%;flex:0 0 auto}
.meter .seg{background:var(--cut);height:100%;flex:0 0 auto;box-shadow:-1px 0 0 rgb(var(--shade-c) / .55)}
.meter .seg.s2{background:rgb(var(--cut-c) / .90)}
.meter .seg.s3{background:rgb(var(--cut-c) / .80)}
.meter .seg.s4{background:rgb(var(--cut-c) / .71)}
.meter .seg.s5{background:rgb(var(--cut-c) / .64)}
.meter .seg.s6{background:rgb(var(--cut-c) / .58)}
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
.bar{display:flex;height:10px;border-radius:0;background:var(--sunk);overflow:hidden;
  margin-top:10px;box-shadow:inset 0 1px 2px rgb(var(--shade-c) / .55)}
.bar i{display:block;height:100%}
.bar i.kept{background:rgb(var(--ink-c) / .40)}
.bar i.lost{background:var(--cut)}
.bar i.j{background:var(--cut);box-shadow:-1px 0 0 rgb(var(--shade-c) / .55)}
.bar i.j.s2{background:rgb(var(--cut-c) / .90)}
.bar i.j.s3{background:rgb(var(--cut-c) / .80)}
.bar i.j.s4{background:rgb(var(--cut-c) / .71)}
.bar i.j.s5{background:rgb(var(--cut-c) / .64)}
.bar i.j.s6{background:rgb(var(--cut-c) / .58)}
.barcap{display:block;margin-top:7px;font-family:var(--mono);font-size:10.5px;color:var(--dimmer)}
.ded{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;font-size:14px;
  line-height:1.5;color:var(--dim);margin-top:11px;padding-top:11px;border-top:1px solid var(--hair)}
.barcap + .ded{border-top:0}
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

@media (max-width:640px){
  .vtop,.vrank,.vmeter,.vbody,.vfoot{padding-left:16px;padding-right:16px}
  .vrank .big{font-size:44px}
  .pitch{margin-left:0}
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
 * The cut meter: this product's hundred points, and the metrics that ate them.
 *
 * The widths are exact. `cuts = 100 - mean(metric score)`, so a metric contributes
 * `metricCuts / metricCount` and the segments sum to the bar with nothing left
 * over. A key names every segment, because this document has no hover on a phone
 * and no JavaScript anywhere: a bar whose blocks can only be identified by
 * pointing at them is a bar half the readers cannot read.
 */
function cutMeter(verdict: Verdict): string {
  const count = verdict.metrics.length;
  const cuts = Math.max(0, Math.min(100, verdict.cuts));
  const kept = 100 - cuts;
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
    `<span><b>&minus;${Math.round(cuts)} in cuts</b> &middot; ${Math.round(kept)} left</span>`,
    '</div>',
    `<div class="meter"><i class="kept" style="width:${kept}%"></i>${segments}</div>`,
    `<div class="vkeys">${keys}</div>`,
    '</div>',
  ].join('');
}

/**
 * One metric's loss, split by the juror who caused it.
 *
 * Exact for the same reason the meter above it is: a metric's merged score is the
 * mean of its jurors' own scores, so juror J's share of the loss is
 * `J's points / jurorCount`, and the shares sum to the loss. It is what makes the
 * juror attribution structural - a juror is a measurable width, not a byline.
 */
function jurorBar(metric: VerdictMetric): string {
  const jurors = Math.max(1, metric.jurors);
  const lost = Math.max(0, Math.min(100, metric.cuts));

  const byRole = new Map<string, number>();
  for (const deduction of metric.deductions) {
    byRole.set(deduction.role, (byRole.get(deduction.role) ?? 0) + deduction.points);
  }
  const shares = [...byRole.entries()]
    .map(([role, points]) => ({ role, points, share: points / jurors }))
    .sort((a, b) => b.share - a.share);

  if (shares.length === 0) {
    return (
      '<div class="bar"><i class="kept" style="width:100%"></i></div>' +
      '<span class="barcap">nothing came off this metric</span>'
    );
  }

  const segments = shares
    .map((entry, index) => `<i class="${segClass(index, 'j')}" style="width:${entry.share}%"></i>`)
    .join('');

  return (
    `<div class="bar"><i class="kept" style="width:${100 - lost}%"></i>${segments}</div>` +
    `<span class="barcap">${shares.length} of ${jurors} jurors cut here &middot; widest block is ` +
    `${escapeHtml(shares[0]?.role ?? '')}</span>`
  );
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
    `<div class="vline"><span>Cuts taken</span><span>&minus;${Math.round(verdict.cuts)}</span></div>`,
    `<div class="vline"><span>Merit composite</span><span>${n2(verdict.composite)}</span></div>`,
    `<div class="vline"><span>Customer demand</span>${demand}</div>`,
    `<div class="vline"><span>${escapeHtml(labels.floor)} picked you</span>${picked}</div>`,
    `<div class="vline"><span>Ranked by</span><span>${n2(verdict.core)}</span></div>`,
  ].join('');
}

/** One metric block of the ledger: the bar, then every deduction with its juror. */
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
        jurorBar(metric),
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

  const picks = verdict.floor.picks
    .map((pick) => {
      const label = pick.pick === 'first' ? '1st' : '2nd';
      const strength = pick.strength === undefined ? '' : ` &middot; ${pick.strength}`;
      return (
        '<div class="pick">' +
        `<span class="p${pick.pick === 'second' ? ' second' : ''}">${label}${strength}</span>` +
        `<span>${escapeHtml(pick.reason)} <span class="who">&mdash; ${escapeHtml(pick.persona)}</span></span>` +
        '</div>'
      );
    })
    .join('');

  const empty =
    verdict.floor.picks.length === 0
      ? `<p>The ${escapeHtml(labels.buyers)} convened over this cluster and named nobody on this product &mdash; every one of them reached for something else.</p>`
      : '';

  return [
    '<section>',
    `<h2>${escapeHtml(labels.floor)}</h2>`,
    `<p class="lede">Simulated ${escapeHtml(labels.buyers)} were shown this product beside its cluster peers and made a forced choice. These are the ones who named it, and why.</p>`,
    '<div class="blk">',
    empty,
    picks,
    '<p class="dnums">',
    `demand ${n2(verdict.floor.demand)} &middot; breadth ${n2(verdict.floor.breadth)} &middot; intensity ${n2(verdict.floor.intensity)} `,
    `&middot; capture ${n2(verdict.floor.capture)} &middot; share ${n2(verdict.floor.share)}`,
    '</p>',
    '</div>',
    '</section>',
  ].join('');
}

/** The cluster the product was judged inside. `brief` Part 6 lists it by name. */
function clusterSection(verdict: Verdict): string {
  const { cluster } = verdict;
  return [
    '<section>',
    '<h2>Judged inside</h2>',
    '<p class="lede">Demand is only meaningful against a substitute. Every product is placed in a cluster of things that do the same job, and it is judged against those and no others.</p>',
    '<div class="blk">',
    `<p><b>${escapeHtml(cluster.label)}</b> &middot; ${cluster.size} product${cluster.size === 1 ? '' : 's'} &middot; scarcity ${cluster.uniqueness}/100</p>`,
    `<p>${escapeHtml(cluster.reason)}</p>`,
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

  ${cutMeter(verdict)}

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
  <h2>Every cut, and who took it</h2>
  <p class="lede"><b>${escapeHtml(cutsLine(verdict))}</b> Everyone walks in at 100. Cuts is 100 minus the mean metric score &mdash; not the sum of the points below, because those are each juror's own deduction off their own 100, and ${escapeHtml(labels.jury.toLowerCase())} cutting 20 each for the same omission is one 20-point cut, not 120.</p>
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
