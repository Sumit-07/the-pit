/**
 * The preview board, as one self-contained HTML document.
 *
 * No bundler, no CDN, no font host: `renderPage` returns a single string with
 * its CSS and its script inline, so the server is a `readFile` and a `write` and
 * the page works with the machine offline.
 *
 * ## Where the design comes from
 *
 * `apps/web/src/lib/theme.ts`, restated. Five values — `--paper`, `--card`,
 * `--sunk`, `--ink` and one hue, `--cut` — with every rule, shadow and muted tone
 * derived from `--ink` at an alpha. One sans and one mono, declared with local
 * fallbacks and loaded from nowhere, because this page must render with the
 * machine offline. `--cut` is the only colour in the system and it means exactly
 * one thing: this was taken.
 *
 * The copy is deliberate, not an oversight. `PHASE-0.md §3` forbids the engine
 * importing from `apps/web`, so the preview board and the public board are kept in
 * step by hand — as they have been since this file was written. The two are meant
 * to look like one product, because they publish the same verdict.
 *
 * `brief` Part 6's "rows darken as they descend (the pit is literal)" is read as
 * depth in the surface stack rather than as mud in the palette: `--depth` runs 0
 * at rank 1 to 1 at the last row, and the row's ground sinks from `--card` toward
 * `--sunk` as it goes. Hovering lifts it back out.
 *
 * The signature is the **cut meter**: every product walked in at 100, the graphite
 * head is what survived, and each segment after it is one metric's exact share of
 * the loss. Inside an open row the same bar splits again by juror. Both
 * decompositions are exact — `cuts = 100 - mean(metric score)`, and a metric's
 * score is the mean of its jurors' own 100s — which is what makes the drawing a
 * statement about the mechanic rather than a decoration on it.
 *
 * ## What `brief` Part 6 requires of it
 *
 * - The board is the page, not a section of one.
 * - Rows lead with a deduction and its reason. The collapsed row carries the
 *   heaviest single cut and the juror who took it; the composites are the small
 *   mono numbers on the right.
 * - Every row opens into the full ledger: each deduction with its points, its
 *   reason and its role, the per-metric score and cross-juror spread, the cluster
 *   the product was judged inside, and which personas picked it.
 * - Solo-cluster rows are marked, because 32 of 48 Developer Tools products faced
 *   no buyers at all and that is a property of the board, not an error.
 * - Tiebroken rows are marked, because demand or scarcity moved them.
 * - The footer carries the health numbers, the seeding caveat verbatim, and the
 *   timestamp and product count `brief` Part 5 requires — no rank is permanent.
 */

import type { BoardPayload } from './model.js';

/**
 * JSON safe to sit inside a `<script type="application/json">` block.
 *
 * `</script>` anywhere in a juror's reason would close the block early, and
 * `<!--` opens an HTML comment inside it. Both are escaped at the `<`, which
 * JSON accepts as `\u003c` and `JSON.parse` returns unchanged.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

const CSS = `
:root{
  --paper:#EDEFF3; --card:#FFFFFF; --sunk:#DCE0E7; --ink:#101317; --cut:#9C1B2F;
  --ink-c:16 19 23; --cut-c:156 27 47;
  --dim:rgb(var(--ink-c) / .58); --dimmer:rgb(var(--ink-c) / .40);
  --line:rgb(var(--ink-c) / .11); --hair:rgb(var(--ink-c) / .06); --wash:rgb(var(--ink-c) / .035);
  --e1:0 1px 2px rgb(var(--ink-c) / .05), 0 1px 1px rgb(var(--ink-c) / .04);
  --e2:0 2px 4px rgb(var(--ink-c) / .05), 0 8px 20px rgb(var(--ink-c) / .07);
  --e3:0 2px 6px rgb(var(--ink-c) / .06), 0 14px 40px rgb(var(--ink-c) / .12);
  --r1:6px; --r2:10px; --r3:16px;
  --sans:"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper);-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;
  line-height:1.55;-webkit-font-smoothing:antialiased;font-synthesis-weight:none;overflow-x:hidden}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
.wrap{max-width:1080px;margin:0 auto;padding:0 18px}

nav{display:flex;justify-content:space-between;align-items:center;padding:20px 0 18px}
.mark{font-weight:800;font-size:14px;letter-spacing:.02em;text-transform:uppercase;
  display:inline-flex;align-items:center;gap:7px}
.mark::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--cut)}
.mark i{font-style:normal}
.navr{font-family:var(--mono);font-size:11px;color:var(--dim);letter-spacing:.04em}

/* ---------- head ---------- */
.head{padding:8px 0 0}
.sh{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.17em;
  text-transform:uppercase;color:var(--dim)}
h1{font-weight:700;font-size:clamp(28px,5vw,44px);line-height:1.04;letter-spacing:-.03em;margin-top:10px}
h1 em{font-style:normal;color:var(--dim)}
.headsub{font-size:15px;line-height:1.6;margin-top:12px;max-width:66ch;color:var(--dim)}
.headsub b{color:var(--ink);font-weight:600}

/* ---------- category switcher ---------- */
.rail{margin-top:26px}
.railhead{display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:12px}
.cats{display:flex;gap:8px;flex-wrap:wrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px}
.cat{font-family:var(--sans);font-size:13px;font-weight:600;letter-spacing:-.005em;white-space:nowrap;
  cursor:pointer;background:transparent;border:1px solid var(--line);color:var(--dim);
  padding:8px 13px;border-radius:var(--r1);transition:color .16s,background .16s,box-shadow .16s}
.cat:hover{color:var(--ink);background:var(--card)}
.cat.on{background:var(--ink);border-color:var(--ink);color:var(--paper);box-shadow:var(--e1)}

/* ---------- stat strip ---------- */
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--e1);overflow:hidden;margin-top:14px}
.strip > div{background:var(--card);padding:13px 14px;min-width:0}
.strip .k{display:block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dimmer)}
.strip .v{display:block;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:19px;
  font-weight:600;letter-spacing:-.02em;margin-top:7px}
.legend{font-size:13px;line-height:1.7;color:var(--dim);margin-top:16px;background:var(--sunk);
  border:1px solid var(--line);border-radius:var(--r2);padding:14px 16px;
  box-shadow:inset 0 1px 2px rgb(var(--ink-c) / .05)}
.legend b{color:var(--ink);font-weight:600}

/* ---------- the board ---------- */
.board{margin-top:18px;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r3);box-shadow:var(--e3);overflow:hidden}
.bhead{display:grid;grid-template-columns:38px 1fr auto;gap:14px;align-items:center;
  padding:12px 18px;background:var(--wash);border-bottom:1px solid var(--line);
  font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--dimmer)}
.bhead .c-x{display:none}
.bhead .c-ch{justify-self:end}
.c-hide{display:none}
@media(min-width:760px){.c-hide{display:block}}
.allbtn{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;background:var(--card);border:1px solid var(--line);color:var(--dim);
  padding:5px 10px;cursor:pointer;border-radius:var(--r1);box-shadow:var(--e1)}
.allbtn:hover{color:var(--ink)}

.brow{border-top:1px solid var(--line);animation:rise .34s cubic-bezier(.2,.7,.3,1) backwards}
.brow:first-of-type{border-top:0}
@keyframes rise{from{opacity:0;transform:translateY(7px)}}

/*
 * The pit is literal, and on paper it is depth rather than darkness: --depth runs
 * 0 at rank 1 to 1 at the last row, and the row's ground sinks from the raised
 * white card toward the recessed floor. Hovering lifts it back out.
 */
.rowhead{--depth:0;position:relative;display:grid;
  grid-template-columns:38px minmax(0,1fr) auto;
  grid-template-areas:"rank name cuts" "rank lead nums" "rank meter meter";
  column-gap:16px;row-gap:2px;align-items:start;width:100%;padding:15px 18px 14px;
  border:0;text-align:left;font-family:inherit;color:inherit;cursor:pointer;
  background:color-mix(in srgb, var(--card) calc(100% - var(--depth) * 62%), var(--sunk));
  transition:background .16s ease}
.rowhead:hover{background:color-mix(in srgb, var(--card) calc(100% - var(--depth) * 40%), var(--sunk))}
.rowhead:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}
.flag{position:absolute;left:0;top:10px;bottom:10px;width:2px;border-radius:0 2px 2px 0;
  background:rgb(var(--ink-c) / .22)}
.rk{grid-area:rank;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:13px;
  font-weight:600;color:var(--dim);letter-spacing:-.02em;padding-top:1px}
.nm{grid-area:name;min-width:0}
.nm b{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:15px;font-weight:600;
  letter-spacing:-.012em;line-height:1.3}
.pname{min-width:0;flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topcut{grid-area:lead;display:block;font-size:14px;line-height:1.5;color:var(--dim);margin-top:6px}
.topcut .pts{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12.5px;
  color:var(--cut);font-weight:600;margin-right:3px}
.topcut .who{font-family:var(--mono);font-size:11px;color:var(--dimmer);white-space:nowrap}
.tags{display:inline-flex;gap:6px;flex-wrap:wrap;flex:none}
.tag{font-family:var(--mono);font-size:9.5px;font-weight:500;letter-spacing:.1em;
  text-transform:uppercase;padding:3px 8px;border-radius:999px;white-space:nowrap}
.tag.solo{border:1px solid var(--line);color:var(--dim)}
.tag.tb{background:rgb(var(--ink-c) / .86);color:var(--card)}
.tag.fl{border:1px solid rgb(var(--cut-c) / .40);color:var(--cut);background:rgb(var(--cut-c) / .06)}

/* ---------- the signature: the cut meter ---------- */
.meterwrap{grid-area:meter;min-width:0;margin-top:9px}
.meter{display:flex;height:10px;border-radius:999px;background:var(--sunk);overflow:hidden;
  box-shadow:inset 0 1px 1px rgb(var(--ink-c) / .07)}
.meter .kept{background:rgb(var(--ink-c) / .24);height:100%;flex:0 0 auto}
.meter .seg{background:var(--cut);height:100%;flex:0 0 auto;box-shadow:-1px 0 0 var(--card)}
.meter .seg.s2{background:rgb(var(--cut-c) / .82)}
.meter .seg.s3{background:rgb(var(--cut-c) / .66)}
.meter .seg.s4{background:rgb(var(--cut-c) / .52)}
.meter .seg.s5{background:rgb(var(--cut-c) / .40)}
.meter .seg.s6{background:rgb(var(--cut-c) / .30)}
.metercap{display:flex;justify-content:space-between;gap:14px;margin-top:7px;
  font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:10.5px;
  letter-spacing:.02em;color:var(--dimmer)}
.metercap .heaviest{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.cell{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11.5px;
  color:var(--dimmer);white-space:nowrap}
.cell .v{color:var(--dim)}
.cell.cuts{grid-area:cuts;font-size:15px;font-weight:600;letter-spacing:-.02em;
  text-align:right;padding-top:1px}
.cell.cuts .v{color:var(--cut)}
.nums{grid-area:nums;display:flex;gap:11px;align-items:baseline;justify-content:flex-end;
  align-self:start;padding-top:4px}
.nums .k{color:rgb(var(--ink-c) / .30);margin-right:3px}
.chev{position:absolute;left:20px;top:38px;font-size:10px;line-height:1;color:var(--dimmer);
  transition:transform .16s}
.brow.open .chev{transform:rotate(90deg)}

/* ---------- the ledger ---------- */
.detail{display:none;background:var(--wash);border-top:1px solid var(--hair);padding:4px 18px 22px}
.brow.open .detail{display:block}
.took{font-size:14px;line-height:1.6;color:var(--dim);padding:12px 0 4px}
.took b{color:var(--ink);font-weight:600}
.took a,.took .who{font-family:var(--mono);font-size:11.5px;color:var(--dim);overflow-wrap:anywhere}
.sect{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--dimmer);margin-bottom:9px}
.ledger{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--e1);padding:14px 16px 12px;margin-top:12px}
.ledger-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.ledger-h .mt{font-size:14px;font-weight:600;letter-spacing:-.008em}
.ledger-h .sc{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;
  color:var(--dimmer);white-space:nowrap}
.bar{display:flex;height:10px;border-radius:999px;background:var(--sunk);overflow:hidden;
  margin-top:10px;box-shadow:inset 0 1px 1px rgb(var(--ink-c) / .07)}
.bar i{display:block;height:100%}
.bar i.kept{background:rgb(var(--ink-c) / .24)}
.bar i.lost{background:var(--cut)}
.bar i.j{background:var(--cut);box-shadow:-1px 0 0 var(--card)}
.bar i.j.s2{background:rgb(var(--cut-c) / .82)}
.bar i.j.s3{background:rgb(var(--cut-c) / .66)}
.bar i.j.s4{background:rgb(var(--cut-c) / .52)}
.bar i.j.s5{background:rgb(var(--cut-c) / .40)}
.bar i.j.s6{background:rgb(var(--cut-c) / .30)}
.barcap{display:block;margin-top:7px;font-family:var(--mono);font-size:10.5px;color:var(--dimmer)}
.ded{display:grid;grid-template-columns:42px minmax(0,1fr);gap:12px;font-size:14px;line-height:1.5;
  color:var(--dim);margin-top:10px;padding-top:10px;border-top:1px solid var(--hair)}
.barcap + .ded{border-top:0}
.ded .pts{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;color:var(--cut);
  font-weight:600;text-align:right;padding-top:1px}
.ded .who{font-family:var(--mono);font-size:11px;color:var(--dimmer);white-space:nowrap}
.sub{font-family:var(--mono);font-size:11px;color:var(--dim);margin-top:12px;padding:8px 10px;
  background:var(--sunk);border-radius:var(--r1)}

.blk{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--e1);padding:15px 16px;margin-top:12px}
.blk p{font-size:14px;line-height:1.6;color:var(--dim)}
.blk p b{color:var(--ink);font-weight:600}
.pick{display:grid;grid-template-columns:auto minmax(0,1fr);gap:11px;font-size:14px;line-height:1.5;
  color:var(--dim);margin-top:11px}
.pick .p{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--card);background:rgb(var(--ink-c) / .86);
  border-radius:999px;padding:3px 8px;white-space:nowrap;align-self:start}
.pick .p.second{background:transparent;color:var(--dim);border:1px solid var(--line)}
.pick .who{font-family:var(--mono);font-size:11px;color:var(--dimmer)}
.solonote{color:var(--dim);font-size:14px;line-height:1.6}
.dnums{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;color:var(--dimmer);
  margin-top:14px;padding-top:11px;border-top:1px solid var(--hair)}
.flagnote{font-family:var(--mono);font-size:11.5px;line-height:1.7;color:var(--dim);
  margin-top:8px;overflow-wrap:anywhere}

/* ---------- footer: the honesty block ---------- */
footer{margin-top:34px;padding:0 0 56px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:var(--r2);overflow:hidden}
.fgrid > div{background:var(--card);padding:12px 14px;min-width:0}
.fgrid .k{display:block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dimmer)}
.fgrid .v{display:block;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:16px;
  font-weight:600;margin-top:6px}
.caveat{background:var(--sunk);border-radius:var(--r2);padding:15px 16px;margin-top:16px}
.caveat p{font-size:13.5px;line-height:1.65;color:var(--dim)}
.stamp{font-family:var(--mono);font-size:11px;line-height:1.85;color:var(--dimmer);margin-top:18px;
  overflow-wrap:anywhere}
.stamp b{color:var(--dim);font-weight:500}
.empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--e1);padding:28px;margin-top:24px;font-size:14px;line-height:1.7;color:var(--dim)}

@media (max-width:760px){
  .wrap{padding:0 14px}
  .nums{display:none}
  .rowhead{grid-template-columns:32px minmax(0,1fr) auto;column-gap:11px;padding:14px 14px 15px}
  .detail{padding:4px 14px 20px}
  .bhead{grid-template-columns:32px 1fr auto;padding:11px 14px}
  .chev{display:none}
}
@media (max-width:560px){
  /* Two mono captions side by side at 390px is two truncated captions. Stack. */
  .metercap{flex-direction:column;gap:2px}
  .metercap .heaviest{text-align:left}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const SCRIPT = `
var PAYLOAD = JSON.parse(document.getElementById('payload').textContent);
var BOARDS = PAYLOAD.boards;
var cur = 0;
var $ = function (id) { return document.getElementById(id); };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/*
 * Metric names come from the installed jury and are not written for a reader:
 * Developer Tools has "Problem Sharpness", Health & Fitness has "claim_backing".
 * This is a display transform only — the raw name stays in the title attribute,
 * and nothing downstream of the page ever sees the prettified form.
 */
function metricLabel(name) {
  var text = String(name).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function n2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
function n1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
function pad(n) { return n < 10 ? '0' + n : String(n); }
function stamp(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.getUTCDate() + ' ' +
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + ' ' +
    d.getUTCFullYear() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
}

/* ---- collapsed row: the rank, the name, the heaviest cut, small numbers ---- */
function rowHead(row, depth, index) {
  var tags = '';
  if (row.soloCluster) tags += '<span class="tag solo" title="No buyers convened: cluster of one. Ranked on merit alone.">solo cluster</span>';
  if (row.tiebroken) tags += '<span class="tag tb" title="Demand and scarcity moved this row off its pure-merit position.">moved</span>';
  if (row.flagged.length) tags += '<span class="tag fl" title="A juror reason matched the injection alarm. Logged, never dropped.">flagged</span>';
  if (tags) tags = '<span class="tags">' + tags + '</span>';

  var cut = row.headline
    ? '<span class="pts">-' + row.headline.points + '</span> ' + esc(row.headline.reason) +
      ' <span class="who">' + esc(row.headline.role) + ' &middot; ' + esc(metricLabel(row.headline.metric)) + '</span>'
    : '<span class="who">nothing came off this card</span>';

  var demand = typeof row.demand === 'number'
    ? '<span class="v">' + n2(row.demand) + '</span>'
    : '<span class="v none">none</span>';

  return '<button class="rowhead" aria-expanded="false" data-i="' + index + '" style="--depth:' + depth + '">' +
    (row.soloCluster ? '<span class="flag"></span>' : '') +
    '<span class="rk">' + pad(row.rank) + '</span>' +
    '<span class="nm"><b><span class="pname">' + esc(row.name) + '</span>' + tags + '</b>' +
    '<span class="topcut">' + cut + '</span></span>' +
    cutMeter(row) +
    '<span class="cell cuts" title="100 minus the mean metric score"><span class="v">-' + Math.round(row.cuts) + '</span></span>' +
    '<span class="nums">' +
    '<span class="cell c-hide" title="pure merit composite"><span class="k">merit</span><span class="v">' + n2(row.composite) + '</span></span>' +
    '<span class="cell c-hide" title="reduced demand from the floor"><span class="k">demand</span>' + demand + '</span>' +
    '<span class="cell c-hide" title="the blended score the row is ranked by"><span class="k">core</span><span class="v">' + n2(row.core) + '</span></span>' +
    '</span>' +
    '<span class="chev">&#9656;</span>' +
    '</button>';
}

/* ---- the signature: a hundred points, and the metrics that ate them ---- */
/*
 * Exact, not illustrative. cuts = 100 - mean(metric score), so a metric's share is
 * metricCuts / metricCount and the segments sum to the bar. Metrics arrive sorted
 * heaviest-first, so the widest block sits against the boundary, and the widest one
 * is named in the caption because a segment identifiable only by hovering is a
 * segment a touch screen cannot read.
 */
function segClass(i, base) {
  return i === 0 ? base : base + ' s' + Math.min(i + 1, 6);
}
function cutMeter(row) {
  var count = row.metrics.length;
  var cuts = Math.max(0, Math.min(100, row.cuts));
  var kept = 100 - cuts;
  var h = '<span class="meterwrap"><span class="meter" aria-hidden="true">' +
    '<i class="kept" style="width:' + kept + '%"></i>';
  for (var i = 0; i < count; i++) {
    var mt = row.metrics[i];
    var share = Math.max(0, mt.cuts) / count;
    var worst = mt.deductions.length ? mt.deductions[0] : null;
    var title = metricLabel(mt.metric) + ' - ' + n1(mt.cuts) + ' off 100, ' + n1(share) + " of this card's cuts" +
      (worst ? '. -' + worst.points + ' ' + worst.reason + ' - ' + worst.role : '. Nothing came off this metric.');
    h += '<i class="' + segClass(i, 'seg') + '" style="width:' + share + '%" title="' + esc(title) + '"></i>';
  }
  h += '</span><span class="metercap"><span>' +
    (count === 0
      ? 'no metrics scored'
      : Math.round(kept) + ' of 100 left &middot; ' + count + (count === 1 ? ' metric' : ' metrics')) +
    '</span>' +
    (count === 0
      ? ''
      : '<span class="heaviest">widest: ' + esc(metricLabel(row.metrics[0].metric)) + ' -' + n1(row.metrics[0].cuts) + '</span>') +
    '</span></span>';
  return h;
}

/* ---- one metric's loss, split by the juror who caused it ---- */
/*
 * Exact for the same reason: a metric's merged score is the mean of its jurors'
 * own 100s, so juror J contributes (J's points / jurorCount) and the shares sum to
 * the loss. The juror is a measurable width, not a byline.
 */
function jurorBar(mt) {
  var jurors = Math.max(1, mt.jurors);
  var lost = Math.max(0, Math.min(100, mt.cuts));
  var byRole = {};
  var order = [];
  for (var d = 0; d < mt.deductions.length; d++) {
    var role = mt.deductions[d].role;
    if (!(role in byRole)) { byRole[role] = 0; order.push(role); }
    byRole[role] += mt.deductions[d].points;
  }
  if (order.length === 0) {
    return '<div class="bar"><i class="kept" style="width:100%"></i></div>' +
      '<span class="barcap">nothing came off this metric</span>';
  }
  order.sort(function (a, b) { return byRole[b] - byRole[a]; });

  var h = '<div class="bar"><i class="kept" style="width:' + (100 - lost) + '%"></i>';
  for (var i = 0; i < order.length; i++) {
    h += '<i class="' + segClass(i, 'j') + '" style="width:' + (byRole[order[i]] / jurors) + '%" title="' +
      esc(order[i] + ' - ' + byRole[order[i]] + ' points off their own 100') + '"></i>';
  }
  return h + '</div><span class="barcap">' + order.length + ' of ' + jurors +
    ' jurors cut here &middot; widest block is ' + esc(order[0]) + '</span>';
}

/* ---- expanded row: the whole ledger, built on first open ---- */
function detailHtml(row) {
  /* Only http(s) becomes a link; anything else is printed as text, never as an href. */
  var safe = /^https?:\\/\\//i.test(row.url);
  var link = safe
    ? '<a href="' + esc(row.url) + '" target="_blank" rel="noopener noreferrer">' + esc(row.url) + '</a>'
    : '<span class="who">' + esc(row.url) + '</span>';
  var h = '<p class="took"><b>' + esc(row.name) + '</b> took ' + Math.round(row.cuts) +
    ' in cuts across ' + row.metrics.length + ' metrics. ' + link + '</p>';

  for (var m = 0; m < row.metrics.length; m++) {
    var mt = row.metrics[m];
    h += '<div class="ledger"><div class="ledger-h">' +
      '<span class="mt" title="' + esc(mt.metric) + '">' + esc(metricLabel(mt.metric)) + '</span>' +
      '<span class="sc">' + n1(mt.score) + ' / 100 &middot; spread &plusmn;' + n1(mt.spread) +
      ' &middot; ' + mt.jurors + ' jurors</span></div>' +
      jurorBar(mt);
    for (var d = 0; d < mt.deductions.length; d++) {
      var de = mt.deductions[d];
      h += '<div class="ded"><span class="pts">-' + de.points + '</span>' +
        '<span>' + esc(de.reason) + ' <span class="who">&mdash; ' + esc(de.role) + '</span></span></div>';
    }
    if (mt.substituted.length) {
      h += '<div class="sub">no answer from ' + esc(mt.substituted.join(', ')) +
        ' &mdash; substituted 50, and counted that way in the rank</div>';
    }
    h += '</div>';
  }

  h += '<div class="blk"><div class="sect">Judged inside</div>' +
    '<p><b>' + esc(row.cluster.label) + '</b> &middot; ' + row.cluster.size +
    (row.cluster.size === 1 ? ' product' : ' products') +
    ' &middot; uniqueness ' + row.cluster.uniqueness + '/100</p>' +
    '<p style="margin-top:5px">' + esc(row.cluster.reason) + '</p></div>';

  h += '<div class="blk"><div class="sect">The floor</div>';
  if (row.demandDetail) {
    var picks = row.demandDetail.picks;
    if (picks.length === 0) {
      h += '<p>The panel convened but named no persona on this product.</p>';
    }
    for (var p = 0; p < picks.length; p++) {
      var pk = picks[p];
      var label = pk.pick === 'first' ? '1st' : '2nd';
      if (typeof pk.strength === 'number') label += ' &middot; ' + pk.strength;
      h += '<div class="pick"><span class="p' + (pk.pick === 'second' ? ' second' : '') + '">' + label + '</span>' +
        '<span>' + esc(pk.reason) + ' <span class="who">&mdash; ' + esc(pk.persona) + '</span></span></div>';
    }
    h += '<div class="dnums">demand ' + n2(row.demandDetail.demand) +
      ' &middot; breadth ' + n2(row.demandDetail.breadth) +
      ' &middot; intensity ' + n2(row.demandDetail.intensity) +
      ' &middot; capture ' + n2(row.demandDetail.capture) +
      ' &middot; share ' + n2(row.demandDetail.share) + '</div>';
  } else {
    h += '<p class="solonote">No buyers faced this one. Its cluster holds ' + row.cluster.size +
      ' product' + (row.cluster.size === 1 ? '' : 's') +
      ', so there was no forced choice to run and the rank is merit only.</p>';
  }
  h += '</div>';

  if (row.flagged.length) {
    h += '<div class="blk"><div class="sect">Injection alarm &middot; logged, not dropped</div>';
    for (var f = 0; f < row.flagged.length; f++) {
      h += '<div class="flagnote">' + esc(row.flagged[f].source) + ' matched "' +
        esc(row.flagged[f].matched) + '" in: ' + esc(row.flagged[f].reason) + '</div>';
    }
    h += '</div>';
  }
  return '<div class="detail">' + h + '</div>';
}

function render() {
  var b = BOARDS[cur];
  $('cats').innerHTML = BOARDS.map(function (x, i) {
    return '<button class="cat' + (i === cur ? ' on' : '') + '" data-i="' + i + '">' + esc(x.category) + '</button>';
  }).join('');
  $('cats').querySelectorAll('.cat').forEach(function (el) {
    el.onclick = function () {
      cur = Number(el.dataset.i);
      if (history.replaceState) history.replaceState(null, '', '#' + BOARDS[cur].slug);
      render();
      window.scrollTo(0, 0);
    };
  });

  document.title = b.category + ' - The Pit';
  $('boardtitle').innerHTML = esc(b.category);
  $('headsub').innerHTML = 'Everyone walked in at 100. <b>' + b.productCount +
    ' products</b> walked out with less. Open a row for the ledger: every cut, its reason, and the juror who took it.';
  $('strip').innerHTML =
    '<div><span class="k">Products</span><span class="v">' + b.productCount + '</span></div>' +
    '<div><span class="k">Solo cluster</span><span class="v solo">' + b.soloCount + ' / ' + b.productCount + '</span></div>' +
    '<div><span class="k">Moved by demand</span><span class="v tb">' + b.tiebrokenCount + ' / ' + b.productCount + '</span></div>' +
    '<div><span class="k">Metrics</span><span class="v">' + b.metrics.length + '</span></div>' +
    '<div><span class="k">Clusters</span><span class="v">' + b.clusters.length + '</span></div>' +
    '<div><span class="k">Type</span><span class="v">' + esc(b.type) + '</span></div>';

  var n = b.rows.length;
  $('rows').innerHTML = b.rows.map(function (row, i) {
    var depth = n > 1 ? (i / (n - 1)).toFixed(3) : '0';
    return '<div class="brow' + (i === 0 ? ' first' : '') + '" style="animation-delay:' +
      Math.min(i * 14, 620) + 'ms">' + rowHead(row, depth, i) + '</div>';
  }).join('');

  $('foot').innerHTML =
    '<div class="fgrid">' +
    '<div><span class="k">Discrimination</span><span class="v">' + n2(b.health.discrimination) + '</span></div>' +
    '<div><span class="k">Demand discrimination</span><span class="v">' + n2(b.health.demand_discrimination) + '</span></div>' +
    '<div><span class="k">Avg metric spread</span><span class="v">' + n1(b.health.avg_metric_spread) + '</span></div>' +
    '<div><span class="k">Solo clusters</span><span class="v solo">' + b.soloCount + ' / ' + b.productCount + '</span></div>' +
    '<div><span class="k">Tiebroken</span><span class="v tb">' + b.health.tiebreak_count + '</span></div>' +
    '</div>' +
    '<div class="caveat"><div class="sect">Where these scores came from</div><p>' +
    (b.caveat ? esc(b.caveat) : 'This run stored no seeding provenance. Treat its absolute score levels as unverified.') +
    '</p></div>' +
    '<p class="stamp"><b>' + esc(b.category) + '</b> &middot; ' + b.productCount +
    ' products &middot; ranked ' + stamp(b.rankedAt) + ' &middot; read from disk ' + stamp(PAYLOAD.readAt) +
    '<br>prompt ' + esc(b.promptVersion) + ' &middot; demand ' + esc(b.demandVersion) +
    ' &middot; uniqueness ' + esc(b.uniquenessVersion) +
    ' &middot; weights: merit ' + b.weights.merit + ', demand ' + b.weights.demand +
    ', uniqueness lambda ' + b.weights.uniqueness_lambda +
    '<br>the floor: ' + b.personas.map(esc).join(' &middot; ') +
    '<br>No rank here is permanent. The board is rebuilt on every placement and every re-rank, ' +
    'which is why this line carries a time and a product count.</p>';
}

/* One delegated handler for the whole board; details are built on first open. */
function toggle(head) {
  var brow = head.parentElement;
  var open = brow.classList.contains('open');
  if (!open && !brow.querySelector('.detail')) {
    brow.insertAdjacentHTML('beforeend', detailHtml(BOARDS[cur].rows[Number(head.dataset.i)]));
  }
  brow.classList.toggle('open', !open);
  head.setAttribute('aria-expanded', String(!open));
}

document.addEventListener('click', function (event) {
  var head = event.target.closest ? event.target.closest('.rowhead') : null;
  if (head) toggle(head);
});

$('openall').onclick = function () {
  var heads = $('rows').querySelectorAll('.rowhead');
  var opening = $('openall').dataset.state !== 'open';
  for (var i = 0; i < heads.length; i++) {
    if (heads[i].parentElement.classList.contains('open') !== opening) toggle(heads[i]);
  }
  $('openall').dataset.state = opening ? 'open' : 'shut';
  $('openall').textContent = opening ? 'close all' : 'open all';
};

if (BOARDS.length > 0) {
  var want = decodeURIComponent(location.hash.replace('#', ''));
  for (var i = 0; i < BOARDS.length; i++) if (BOARDS[i].slug === want) cur = i;
  render();
}
`;

/** Render the whole preview board as one self-contained document. */
export function renderPage(payload: BoardPayload): string {
  if (payload.boards.length === 0) {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Pit — no boards</title><style>${CSS}</style></head>
<body><div class="wrap">
<nav><span class="mark">THE <i>PIT</i></span><span class="navr">preview board</span></nav>
<div class="head"><span class="sh">The boards</span><h1>Nothing <em>in the pit</em> yet.</h1></div>
<div class="empty">No ranking.json was found under the runs directory.<br><br>
A ranking is only written for a DELIVERED run. Seed a category, then:<br>
&nbsp;&nbsp;pnpm engine rank --category "Developer Tools"<br><br>
This page re-reads the files on every refresh, so a re-rank shows up without restarting the server.</div>
</div></body></html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>The Pit — category board</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

<nav>
  <span class="mark">THE <i>PIT</i></span>
  <span class="navr">preview board &middot; local</span>
</nav>

<div class="head">
  <span class="sh">The board</span>
  <h1 id="boardtitle"></h1>
  <p class="headsub" id="headsub"></p>
</div>

<div class="rail">
  <div class="railhead"><span class="sh">Categories</span><span class="sh">read from disk on every refresh</span></div>
  <div class="cats" id="cats"></div>
</div>

<div class="strip" id="strip"></div>
<p class="legend">
  <b>Cuts</b> is 100 minus the mean metric score &mdash; everyone walks in at 100, this is what came off.
  The points inside a ledger are each juror's own deduction off their own 100, so six jurors cutting 20 for
  the same omission is one 20-point cut on the board, not 120.<br>
  <b>Solo cluster</b> (gold edge) means no buyers were ever shown this product beside a substitute, so its
  rank is merit only. <b>Moved</b> means demand and scarcity pulled the row off its pure-merit position.
</p>

<div class="board">
  <div class="bhead">
    <span class="c-rk">#</span>
    <span class="c-nm">Product &middot; heaviest cut and who took it</span>
    <span class="c-x">Cuts</span>
    <span class="c-x c-hide">Merit</span>
    <span class="c-x c-hide">Demand</span>
    <span class="c-x c-hide">Core</span>
    <span class="c-ch"><button class="allbtn" id="openall">open all</button></span>
  </div>
  <div id="rows"></div>
</div>

<footer id="foot"></footer>

</div>
<script id="payload" type="application/json">${embedJson(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
