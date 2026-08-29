/**
 * The Pit's theme, in one place, for the surfaces that are HTML strings.
 *
 * Four surfaces in this app are rendered as self-contained documents rather than
 * as React: the verdict page (`brief` Part 6 requires it to be downloadable), the
 * checkout and submit pages, the account page, and the magic-link screens. Until
 * this module existed each of them carried its own copy of the palette and its own
 * copy of the base rules, so "the theme" was four strings that had to be edited
 * together and were not. This is the one copy. `app/pit.css` is the React
 * surfaces' mirror of it and is kept in step by hand, because a `.css` file cannot
 * be interpolated into a `<style>` block that has to survive being saved to disk.
 *
 * `packages/engine/src/board/page.ts` carries a fifth copy on purpose: the engine
 * is a library and `PHASE-0.md §3` forbids it importing from `apps/web`. It also
 * loads no font, because the preview board has to render with no network at all.
 *
 * ## The palette is five values and one of them is a colour
 *
 * `--paper`, `--card`, `--sunk` and `--ink` are a neutral surface stack: a cool
 * grey ground, a white raised surface, a recessed well, and near-black text. Every
 * rule, every shadow and every muted tone in the system is `--ink` at an alpha,
 * which is why there is no `--muted` hex to drift.
 *
 * `--cut` is the only hue on any surface. That is the theme's whole argument and
 * it comes from the subject rather than from a palette: everyone walks in at 100,
 * the product is the list of things that were taken, so **if it is coloured, it
 * was taken**. A deduction is `--cut`. A juror's points are `--cut`. The consumed
 * part of a meter is `--cut`. Nothing else in the system is allowed to be, which
 * is why the marks that used to be gold and teal are now a hairline chip and a
 * filled ink chip — a solo cluster is 32 of 48 products and must not read as an
 * alarm, and "moved by demand" is a fact about arithmetic, not a loss.
 *
 * ## Type is one sans and one mono
 *
 * Archivo — the grotesque, never Archivo Black — carries everything from 800 at
 * 74px down to 400 at 14px. The personality is weight, scale and tracking rather
 * than a characterful face. IBM Plex Mono earns its place on exactly one job:
 * anything that has to line up in a column or be compared digit by digit — ranks,
 * points, scores, versions, timestamps — and it is set `tabular-nums` everywhere
 * so those columns actually line up.
 *
 * Every family declares a real local fallback, so a saved verdict page opened on a
 * machine with no network loses its typeface and nothing else.
 */

/** The stylesheet link for the two families. The only external reference on any page. */
export const FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&amp;' +
    'family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">',
].join('\n');

/**
 * The tokens. Five hex values; everything else is derived from them.
 *
 * `--ink-c` and `--cut-c` are the space-separated channel triplets the `rgb(… / a)`
 * derivations need. They are not a sixth and seventh colour — they are the same
 * two, written so an alpha can be attached without a preprocessor.
 */
export const TOKENS = `
:root{
  --paper:#EDEFF3;
  --card:#FFFFFF;
  --sunk:#DCE0E7;
  --ink:#101317;
  --cut:#9C1B2F;

  --ink-c:16 19 23;
  --cut-c:156 27 47;

  --dim:rgb(var(--ink-c) / .58);
  --dimmer:rgb(var(--ink-c) / .40);
  --line:rgb(var(--ink-c) / .11);
  --hair:rgb(var(--ink-c) / .06);
  --wash:rgb(var(--ink-c) / .035);

  --e1:0 1px 2px rgb(var(--ink-c) / .05), 0 1px 1px rgb(var(--ink-c) / .04);
  --e2:0 2px 4px rgb(var(--ink-c) / .05), 0 8px 20px rgb(var(--ink-c) / .07);
  --e3:0 2px 6px rgb(var(--ink-c) / .06), 0 14px 40px rgb(var(--ink-c) / .12);

  --r1:6px; --r2:10px; --r3:16px;

  --sans:"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;

/**
 * The base layer every string surface shares: reset, page, nav, headings, cards,
 * buttons, the meter, and the two accessibility floors.
 *
 * The focus ring is a real one — a two-tone outline that is visible on paper, on a
 * white card and on the ink slab — because `:focus-visible` on a redesigned page
 * is the first thing a keyboard reader loses and the last thing anyone checks.
 *
 * `prefers-reduced-motion` kills transitions and animations outright rather than
 * shortening them.
 */
export const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper);-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;
  font-synthesis-weight:none;overflow-x:hidden}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
a{color:inherit}

.wrap{max-width:1020px;margin:0 auto;padding:0 18px 72px}
.wrap.narrow{max-width:720px}

nav{display:flex;justify-content:space-between;align-items:center;
  padding:20px 0 18px;gap:16px}
.mark{font-weight:800;font-size:14px;letter-spacing:.02em;text-transform:uppercase;
  text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.mark::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;
  background:var(--cut);flex:0 0 auto}
.mark i{font-style:normal}
.navr{display:flex;gap:18px;align-items:center;font-family:var(--mono);font-size:11px;
  letter-spacing:.04em;color:var(--dim)}
.navr a{text-decoration:none;color:var(--dim);padding:2px 0;border-bottom:1px solid transparent}
.navr a:hover{color:var(--ink);border-bottom-color:var(--line)}

.sh{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.17em;
  text-transform:uppercase;color:var(--dim)}

h1{font-weight:700;font-size:clamp(26px,4.6vw,38px);line-height:1.06;letter-spacing:-.028em}
h2{font-weight:700;font-size:17px;line-height:1.25;letter-spacing:-.015em}
h3{font-weight:600;font-size:14px;letter-spacing:-.005em}
.lede{font-size:14.5px;line-height:1.62;color:var(--dim);margin-top:10px;max-width:68ch}
.lede b{color:var(--ink);font-weight:600}

header.page{padding:8px 0 4px}
section{margin-top:34px}

/* ---------- surfaces ---------- */
.blk{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--e1);padding:16px 18px;margin-top:16px}
.blk p{font-size:14px;line-height:1.6;color:var(--dim)}
.blk p+p{margin-top:8px}
.blk p b{color:var(--ink);font-weight:600}
.sect{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--dimmer);margin-bottom:8px}
.well{background:var(--sunk);border:1px solid var(--line);border-radius:var(--r2);
  padding:16px 18px;margin-top:16px;box-shadow:inset 0 1px 2px rgb(var(--ink-c) / .05)}

/* ---------- controls ---------- */
.act{display:inline-flex;align-items:center;gap:7px;font-family:var(--sans);
  font-size:13px;font-weight:600;letter-spacing:-.005em;text-decoration:none;
  color:var(--ink);background:var(--card);border:1px solid var(--line);
  border-radius:var(--r1);padding:9px 14px;box-shadow:var(--e1);cursor:pointer;
  transition:box-shadow .15s ease,transform .15s ease,border-color .15s ease}
.act:hover{box-shadow:var(--e2);border-color:rgb(var(--ink-c) / .2)}
.act:active{transform:translateY(1px)}
.act.prime{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.act.prime:hover{background:#000}
.act small{font-family:var(--mono);font-size:11px;font-weight:500;opacity:.72}

label{display:block;margin-top:16px}
label .sh{display:block;margin-bottom:6px}
input[type=text],input[type=url],input[type=email],textarea,select{
  width:100%;background:var(--card);border:1px solid var(--line);border-radius:var(--r1);
  color:var(--ink);font-family:var(--sans);font-size:14.5px;padding:10px 12px;
  box-shadow:inset 0 1px 2px rgb(var(--ink-c) / .04)}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--ink);
  outline-offset:1px;border-color:var(--ink)}
textarea{min-height:110px;resize:vertical;line-height:1.55}
.hint{font-family:var(--mono);font-size:11px;color:var(--dimmer);margin-top:6px}

/* ---------- the cut meter ---------- */
.meter{display:block;height:9px;border-radius:999px;background:var(--sunk);
  overflow:hidden;box-shadow:inset 0 1px 1px rgb(var(--ink-c) / .07)}
.meter .row{display:flex;height:100%;width:100%}
.meter .kept{background:rgb(var(--ink-c) / .16);flex:0 0 auto;height:100%}
.meter .seg{background:var(--cut);flex:0 0 auto;height:100%;
  border-left:1px solid var(--card)}
.meter .seg:first-child{border-left:0}
.meter .seg.s2{background:rgb(var(--cut-c) / .82)}
.meter .seg.s3{background:rgb(var(--cut-c) / .66)}
.meter .seg.s4{background:rgb(var(--cut-c) / .52)}
.meter .seg.s5{background:rgb(var(--cut-c) / .40)}
.meter-cap{display:flex;justify-content:space-between;gap:12px;margin-top:6px;
  font-family:var(--mono);font-size:10.5px;color:var(--dimmer);letter-spacing:.02em}

/* ---------- numbers ---------- */
.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pts{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;
  font-size:12px;color:var(--cut)}
.who{font-family:var(--mono);font-size:11px;color:var(--dimmer);white-space:nowrap}

footer{margin-top:48px;border-top:1px solid var(--line);padding-top:20px;
  font-family:var(--mono);font-size:11px;line-height:1.8;color:var(--dimmer)}
footer b{color:var(--dim);font-weight:500}
footer a{color:var(--dim)}

@media (max-width:640px){
  .wrap{padding:0 14px 56px}
  body{font-size:14.5px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}
}
`;

/** Tokens plus base, for a surface that wants the whole theme and nothing else. */
export const THEME_CSS = `${TOKENS}${BASE}`;
