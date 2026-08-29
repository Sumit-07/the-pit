/**
 * The preview board, as one self-contained HTML document.
 *
 * No bundler, no CDN, no font host: `renderPage` returns a single string with
 * its CSS and its script inline, so the server is a `readFile` and a `write` and
 * the page works with the machine offline.
 *
 * ## Where the design comes from
 *
 * The palette, the type treatment and the row anatomy are `the-pit-home.html`'s,
 * taken verbatim — the same eight custom properties, the same Archivo Black /
 * Barlow / IBM Plex Mono stack (with local fallbacks, since a font CDN is not
 * allowed here), the same per-row `--depth` overlay that darkens rows as they
 * descend. The expandable ledger, the metric bar and the picks list follow the
 * board pane of `platform-surfaces-mockup.html`, restated in the dark palette.
 * Nothing here is a new visual idea; both files are the reference.
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
.wrap{max-width:1000px;margin:0 auto;padding:0 14px}

nav{display:flex;justify-content:space-between;align-items:center;padding:13px 0;
  border-bottom:1px solid var(--rule)}
.mark{font-family:var(--disp);font-size:14px;letter-spacing:-.02em}
.mark i{color:var(--blade);font-style:normal}
.navr{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.06em}

/* ---------- head ---------- */
.head{padding:24px 0 4px}
.sh{font-family:var(--mono);font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
h1{font-family:var(--disp);font-size:clamp(27px,6.6vw,46px);line-height:.92;
  letter-spacing:-.035em;text-transform:uppercase;margin-top:8px}
h1 em{font-style:normal;color:var(--blade)}
.headsub{font-size:14px;line-height:1.35;margin-top:10px;max-width:52ch;color:#C9BCB1}
.headsub b{color:var(--bone);font-weight:600}

/* ---------- category switcher (home mockup treatment) ---------- */
.rail{margin-top:20px;border-top:1px solid var(--rule);padding-top:13px}
.railhead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:9px}
.cats{display:flex;gap:5px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:9px}
.cat{font-family:var(--mono);font-size:10.5px;white-space:nowrap;cursor:pointer;
  background:transparent;border:1px solid var(--rule);color:var(--muted);padding:6px 10px;border-radius:1px;
  transition:color .15s,border-color .15s,background .15s}
.cat:hover{color:var(--bone);border-color:var(--muted)}
.cat.on{background:var(--blade);border-color:var(--blade);color:#150C0A;font-weight:600}
.cat:focus-visible{outline:2px solid var(--bone);outline-offset:2px}

/* ---------- stat strip ---------- */
.strip{display:flex;gap:22px;flex-wrap:wrap;background:var(--ground2);border:1px solid var(--rule);
  padding:10px 12px;margin-top:2px}
.strip .k{display:block;font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.strip .v{display:block;font-family:var(--mono);font-size:14px;font-weight:600}
.strip .v.solo{color:var(--coin)}
.strip .v.tb{color:var(--roar)}
.legend{font-family:var(--mono);font-size:10px;line-height:1.6;color:var(--muted);margin-top:9px}
.legend b{color:#C9BCB1;font-weight:500}

/* ---------- the board: a pit ---------- */
.board{margin-top:16px}
.bhead{display:flex;align-items:center;gap:10px;padding:8px 11px;
  font-family:var(--mono);font-size:8.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rule)}
.bhead .c-rk{min-width:30px}
.bhead .c-nm{flex:1}
.bhead .c-x{min-width:52px;text-align:right}
.bhead .c-ch{min-width:20px;text-align:right}
.c-hide{display:none}
@media(min-width:760px){.c-hide{display:block}}
.allbtn{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  background:none;border:1px solid var(--rule);color:var(--muted);padding:3px 7px;cursor:pointer;border-radius:1px}
.allbtn:hover{color:var(--bone);border-color:var(--muted)}

.brow{border-bottom:1px solid var(--rule2);animation:rise .4s cubic-bezier(.2,.8,.3,1) backwards}
@keyframes rise{from{opacity:0;transform:translateY(9px)}}
/* The pit is literal: the board starts at the surface and every row below it is
   further down. The --depth variable is set per row, 0 at rank 1 to 1 at the last, and the
   overlay is what daylight is left. Hovering lifts a row back out of it. */
.rowhead{position:relative;display:flex;align-items:center;gap:10px;padding:11px;width:100%;
  background:var(--ground2);border:0;text-align:left;font-family:inherit;color:inherit;cursor:pointer}
.rowhead::after{content:"";position:absolute;inset:0;pointer-events:none;transition:opacity .18s;
  background:linear-gradient(to bottom,rgba(0,0,0,.30),rgba(0,0,0,.80));opacity:var(--depth,0)}
.rowhead:hover{background:var(--panel)}
.rowhead:hover::after{opacity:0}
.rowhead:focus-visible{outline:2px solid var(--blade);outline-offset:-2px}
.flag{position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--coin);z-index:2}
.rk{font-family:var(--disp);font-size:16px;letter-spacing:-.04em;min-width:30px;
  color:var(--bone);position:relative;z-index:1}
.brow.first .rk{color:var(--blade);font-size:19px}
.nm{flex:1;min-width:0;position:relative;z-index:1}
/* The name may be clipped; the solo/moved marks may never be. */
.nm b{display:flex;align-items:baseline;font-size:13.5px;font-weight:600}
.pname{min-width:0;flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topcut{display:block;font-size:11.5px;line-height:1.4;color:#B3A79C;margin-top:3px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.topcut .pts{font-family:var(--mono);font-size:11px;color:var(--blade);font-weight:600}
.topcut .who{font-family:var(--mono);font-size:10px;color:var(--muted)}
.tags{display:inline-flex;gap:5px;flex:none;margin-left:7px}
.tag{font-family:var(--mono);font-size:8px;letter-spacing:.1em;text-transform:uppercase;
  padding:1px 4px;border-radius:1px;font-weight:500}
.tag.solo{color:var(--coin);border:1px solid rgba(217,164,65,.42)}
.tag.tb{color:var(--roar);border:1px solid rgba(91,158,166,.42)}
.tag.fl{color:var(--muted);border:1px solid var(--rule)}
.cell{min-width:52px;text-align:right;position:relative;z-index:1}
.cell .v{display:block;font-family:var(--mono);font-size:11.5px;color:#C9BCB1}
.cell.cuts .v{color:var(--blade);font-weight:600;font-size:13px}
.cell .v.none{color:var(--coin)}
.chev{position:relative;z-index:1;color:var(--muted);font-size:11px;min-width:20px;text-align:right;
  transition:transform .18s}
.brow.open .chev{transform:rotate(90deg)}

/* ---------- the ledger ---------- */
.detail{display:none;background:var(--ground2);border-top:1px solid var(--rule2);padding:2px 13px 16px}
.brow.open .detail{display:block}
.took{font-size:13px;line-height:1.45;color:#C9BCB1;margin-top:13px}
.took b{color:var(--bone);font-weight:600}
.took a{color:var(--blade);text-decoration:none;font-family:var(--mono);font-size:11px}
.took a:hover{text-decoration:underline}
.sect{font-family:var(--mono);font-size:9px;letter-spacing:.15em;text-transform:uppercase;
  color:var(--muted);margin-bottom:8px}
.ledger{margin-top:15px}
.ledger-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.ledger-h .mt{font-size:12.5px;font-weight:600}
.ledger-h .sc{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.bar{display:flex;height:8px;overflow:hidden;background:var(--rule2);margin-top:6px}
.bar i{display:block;height:100%}
.bar i.kept{background:rgba(237,230,222,.20)}
.bar i.lost{background:var(--blade);opacity:.82}
.ded{display:flex;gap:9px;font-size:12px;line-height:1.5;color:#B3A79C;margin-top:7px}
.ded .pts{font-family:var(--mono);font-size:11px;color:var(--blade);font-weight:600;
  min-width:30px;text-align:right;padding-top:1px}
.ded .who{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.sub{font-family:var(--mono);font-size:10px;color:var(--coin);margin-top:6px}

.blk{margin-top:18px;padding-top:13px;border-top:1px dashed var(--rule)}
.blk p{font-size:12px;line-height:1.5;color:#B3A79C}
.blk p b{color:var(--bone);font-weight:600}
.pick{display:flex;gap:9px;font-size:12px;line-height:1.5;color:#B3A79C;margin-top:7px}
.pick .p{font-family:var(--mono);font-size:9.5px;color:var(--roar);white-space:nowrap;
  border:1px solid rgba(91,158,166,.34);padding:1px 5px;border-radius:1px;align-self:flex-start}
.pick .p.second{color:var(--muted);border-color:var(--rule)}
.pick .who{font-family:var(--mono);font-size:10px;color:var(--muted)}
.solonote{color:var(--coin);font-size:12px;line-height:1.5}
.dnums{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:8px}
.flagnote{font-family:var(--mono);font-size:10.5px;line-height:1.5;color:var(--muted);margin-top:7px}

/* ---------- footer: the honesty block ---------- */
footer{margin-top:34px;border-top:1px solid var(--rule);padding:18px 0 44px}
.fgrid{display:flex;gap:22px;flex-wrap:wrap;background:var(--ground2);border:1px solid var(--rule);padding:11px 12px}
.fgrid .k{display:block;font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.fgrid .v{display:block;font-family:var(--mono);font-size:14px;font-weight:600}
.caveat{background:var(--ground2);border-left:2px solid var(--blade);padding:11px 13px;margin-top:11px}
.caveat .sect{margin-bottom:6px}
.caveat p{font-family:var(--mono);font-size:11px;line-height:1.62;color:#C9BCB1}
.stamp{font-family:var(--mono);font-size:10.5px;line-height:1.7;color:var(--muted);margin-top:13px}
.stamp b{color:#C9BCB1;font-weight:500}
.empty{border:1px solid var(--rule);background:var(--ground2);padding:22px;margin-top:20px;
  font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--muted)}
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
    '<span class="cell cuts" title="100 minus the mean metric score"><span class="v">-' + Math.round(row.cuts) + '</span></span>' +
    '<span class="cell c-hide" title="pure merit composite"><span class="v">' + n2(row.composite) + '</span></span>' +
    '<span class="cell c-hide" title="reduced demand from the floor">' + demand + '</span>' +
    '<span class="cell c-hide" title="the blended score the row is ranked by"><span class="v">' + n2(row.core) + '</span></span>' +
    '<span class="chev">&#9656;</span>' +
    '</button>';
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
      '<div class="bar"><i class="kept" style="width:' + n1(mt.score) + '%"></i>' +
      '<i class="lost" style="width:' + n1(mt.cuts) + '%"></i></div>';
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
