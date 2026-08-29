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
 * Structure and hierarchy are the verdict pane of `platform-surfaces-mockup.html`,
 * beat for beat: the dark header strip carrying the category and the name, the
 * oversized rank with "of N products" beside it, the four summary lines, the
 * pull-quote from the sharpest juror with its citation, and the mono footer strip
 * with the timestamp and the versions. The palette is `the-pit-home.html`'s eight
 * custom properties, taken verbatim — the same restatement in the dark palette
 * that `board/page.ts` already made, so the board and the verdict it links to
 * look like one product. Nothing here is a new visual idea.
 *
 * The card ends where the mockup's card ends. Everything below it is the evidence
 * `brief` Part 6 enumerates, in the mockup's own ledger treatment: the metric
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

import type { Verdict, VerdictDeduction } from './model';

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
 * `the-pit-home.html` loads exactly these three families from the same host, and
 * `app/layout.tsx` loads them for every React surface, so a verdict page without
 * them would be the one screen in the product set in Arial. It is a `<link>` and
 * not a `next/font` import because this document is served by a route handler and
 * has to be a single file.
 *
 * It does not cost the page its offline guarantee: every family in `CSS` is
 * declared with a real local fallback stack, so a saved copy on a machine with no
 * network loses its typeface and nothing else. There is still no script, no image
 * and no stylesheet the layout depends on.
 */
const FONTS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&amp;' +
    'family=Barlow:wght@400;500;600&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">',
].join('\n');

const CSS = `
:root{
  --ground:#120E0C; --ground2:#191411; --panel:#211A16; --rule:#33291F; --rule2:#241D18;
  --bone:#EDE6DE; --muted:#93857A; --blade:#E2482C; --coin:#D9A441; --roar:#5B9EA6;
  --body:"Barlow","Helvetica Neue",Helvetica,Arial,sans-serif;
  --disp:"Archivo Black","Arial Black","Helvetica Neue",Impact,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--ground)}
body{background:var(--ground);color:var(--bone);font-family:var(--body);
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:760px;margin:0 auto;padding:0 14px 56px}

nav{display:flex;justify-content:space-between;align-items:center;padding:13px 0;
  border-bottom:1px solid var(--rule)}
.mark{font-family:var(--disp);font-size:14px;letter-spacing:-.02em;color:var(--bone);text-decoration:none}
.mark i{color:var(--blade);font-style:normal}
.navr{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.06em}

.sh{font-family:var(--mono);font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}

/* ---------- the card: platform-surfaces-mockup.html, dark ---------- */
.vcard{border:1px solid var(--rule);background:var(--ground2);margin-top:22px;overflow:hidden}
.vtop{background:var(--panel);border-bottom:1px solid var(--rule);padding:13px 16px 12px}
.vtop .lbl{font-family:var(--mono);font-size:9px;letter-spacing:.17em;text-transform:uppercase;color:var(--muted)}
.vtop h1{font-family:var(--disp);font-size:clamp(20px,5.2vw,30px);line-height:1.04;
  letter-spacing:-.03em;margin-top:6px;word-break:break-word}
.vtop .purl{display:block;margin-top:7px}
.plink{font-family:var(--mono);font-size:10.5px;color:var(--muted);text-decoration:none;word-break:break-all}
a.plink:hover{color:var(--bone);text-decoration:underline}

.vrank{display:flex;align-items:baseline;gap:13px;flex-wrap:wrap;
  padding:17px 16px 14px;border-bottom:1px solid var(--rule2)}
.vrank .big{font-family:var(--disp);font-size:52px;line-height:.82;letter-spacing:-.05em;color:var(--blade)}
.vrank .of{font-size:12.5px;line-height:1.45;color:var(--muted)}
.vrank .of b{display:block;color:var(--bone);font-size:13px;font-weight:600}
.pitch{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--coin);border:1px solid rgba(217,164,65,.42);padding:2px 6px;align-self:center}

.vbody{padding:13px 16px 16px}
.vline{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:6px 0;
  border-bottom:1px solid var(--rule2)}
.vline:last-of-type{border-bottom:0}
.vline span:first-child{color:var(--muted)}
.vline span:last-child{font-family:var(--mono);font-weight:600;text-align:right}
.vline .none{color:var(--coin);font-weight:500}
.vquote{font-size:13px;line-height:1.55;color:#C9BCB1;border-left:2px solid var(--blade);
  padding-left:11px;margin-top:14px}
.vquote cite{display:block;font-style:normal;font-family:var(--mono);font-size:9.5px;
  color:var(--muted);margin-top:6px;letter-spacing:.04em}
.vfoot{background:var(--panel);border-top:1px solid var(--rule);padding:9px 16px;
  font-family:var(--mono);font-size:9.5px;line-height:1.7;color:var(--muted);
  display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}

.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:13px}
.act{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-decoration:none;
  color:var(--bone);border:1px solid var(--rule);padding:7px 11px;background:transparent}
.act:hover{border-color:var(--muted)}
.act.prime{background:var(--blade);border-color:var(--blade);color:#150C0A;font-weight:600}

/* ---------- the evidence ---------- */
section{margin-top:30px}
h2{font-family:var(--disp);font-size:15px;letter-spacing:-.02em;text-transform:uppercase}
.lede{font-size:12.5px;line-height:1.6;color:#B3A79C;margin-top:7px;max-width:64ch}
.lede b{color:var(--bone);font-weight:600}

.ledger{margin-top:17px;border-top:1px solid var(--rule2);padding-top:12px}
.ledger-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.ledger-h .mt{font-size:13px;font-weight:600}
.ledger-h .sc{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.bar{display:flex;height:8px;overflow:hidden;background:var(--rule2);margin-top:7px}
.bar i{display:block;height:100%}
.bar i.kept{background:rgba(237,230,222,.20)}
.bar i.lost{background:var(--blade);opacity:.82}
.ded{display:flex;gap:10px;font-size:12.5px;line-height:1.55;color:#B3A79C;margin-top:8px}
.ded .pts{font-family:var(--mono);font-size:11.5px;color:var(--blade);font-weight:600;
  min-width:32px;text-align:right;padding-top:1px}
.ded .who{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.subs{font-family:var(--mono);font-size:10px;color:var(--coin);margin-top:8px}

.blk{background:var(--ground2);border:1px solid var(--rule);padding:13px 14px;margin-top:14px}
.blk p{font-size:12.5px;line-height:1.6;color:#B3A79C}
.blk p+p{margin-top:7px}
.blk p b{color:var(--bone);font-weight:600}
.pick{display:flex;gap:10px;font-size:12.5px;line-height:1.55;color:#B3A79C;margin-top:9px}
.pick .p{font-family:var(--mono);font-size:9.5px;color:var(--roar);white-space:nowrap;
  border:1px solid rgba(91,158,166,.34);padding:1px 5px;align-self:flex-start}
.pick .p.second{color:var(--muted);border-color:var(--rule)}
.pick .who{font-family:var(--mono);font-size:10px;color:var(--muted)}
.solo{border-left:2px solid var(--coin)}
.solo p b{color:var(--coin)}
.dnums{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:11px;
  padding-top:9px;border-top:1px solid var(--rule2)}

footer{margin-top:34px;border-top:1px solid var(--rule);padding-top:16px;
  font-family:var(--mono);font-size:10.5px;line-height:1.75;color:var(--muted)}
footer b{color:#C9BCB1;font-weight:500}
footer a{color:var(--muted)}
.notfound{border:1px solid var(--rule);background:var(--ground2);padding:24px;margin-top:24px;
  font-family:var(--mono);font-size:12px;line-height:1.7;color:var(--muted)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
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

/** The four summary lines of the mockup's card body. */
function summaryLines(verdict: Verdict): string {
  const labels = panelLabels(verdict);
  const demand =
    verdict.floor.kind === 'convened'
      ? `<span>${n2(verdict.floor.demand)}</span>`
      : `<span class="none">no ${labels.buyers} convened</span>`;
  const picked =
    verdict.floor.kind === 'convened'
      ? `<span>${verdict.floor.firstPicks} first &middot; ${verdict.floor.secondPicks} runner-up</span>`
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
        `<div class="bar"><i class="kept" style="width:${n1(Math.max(0, metric.score))}%"></i>`,
        `<i class="lost" style="width:${n1(Math.max(0, metric.cuts))}%"></i></div>`,
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
