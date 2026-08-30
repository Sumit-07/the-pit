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
 * ## The palette is six values and one of them is a colour
 *
 * The pit is dark, and it is dark on purpose rather than by preference: there is
 * one committed theme and no `prefers-color-scheme` branch anywhere in the system.
 * `color-scheme:dark` is declared all the same — that is not a branch, it is how
 * the browser is told to paint scrollbars, form controls and the canvas to match.
 *
 * `--sunk`, `--pit`, `--card` and `--rise` are a real surface stack — four steps
 * of a single warm umber, 4.5 to 7 CIE L* apart, which clears the smallest step that
 * reads as a different surface. **On dark, elevation is lightness**: a raised card
 * is a lighter surface than the ground, not a same-coloured card with a shadow
 * under it. Hairline borders separate where a shadow would have, a raised lip
 * (`--lip`) draws the top edge of anything lifted, and the shadows are occlusion —
 * black, deep, soft, and used sparingly — never a glow.
 *
 * The neutral is warm on purpose. A pit is earth, not outer space, and the warmth
 * is held in *absolute* channel terms (r−b of 11–13 at every step) rather than as
 * a fixed chromaticity, so the floor is as warm as the surfaces above it instead
 * of fading to the blue-black every dark UI ships with.
 *
 * `--ink` is text and, at an alpha, every rule and every muted tone. `--shade-c`
 * is the separate black channel that shadows and `--wash` are built from — on a
 * light ground one channel could do both jobs, but on a dark one a shadow made of
 * the text colour is a glow, so the two are split.
 *
 * There are exactly **two** hues, and each one names one half of the same
 * quantity. Everyone walks in at 100; the bar under every row is that hundred;
 * every point on it either survived or was taken. So:
 *
 * - `--cut` is **taken**. A deduction is `--cut`. A juror's points are `--cut`.
 *   The consumed segments of a meter are `--cut`.
 * - `--held` is **survived**. The kept head of a health bar is `--held`, and the
 *   figure that says how much health is left is `--held`. That is its whole job.
 *
 * Nothing that is merely a *state* gets either of them, which is why the marks
 * that used to be gold and teal are a hairline chip and a filled ink chip — a
 * solo cluster is 32 of 48 products and must not read as an alarm, and "moved by
 * demand" is a fact about arithmetic, not a loss.
 *
 * The second hue was added when the boards started leading with **health
 * remaining** rather than with cuts taken. The meter had always drawn health —
 * a hundred-point track whose head is what a product walked out with — but the
 * head was `rgb(--ink-c / .40)`, a dead grey that read as the empty part of a
 * track rather than as the larger and more important of the two quantities. A
 * bar whose primary number is drawn in the absence of colour and whose secondary
 * number is drawn in the only colour on the page is a bar arguing against its own
 * caption. `--held` fixes that at **identical visual weight**: the kept head is
 * `rgb(--held-c / .70)`, which composites to CIE L* 42.9 over the track where the
 * old grey sat at 41.9. Nothing got louder; one thing acquired a meaning. And it
 * stays quieter than `--cut` (L* 59.1), so what was taken still reads first.
 *
 * There is no third hue. The design canvas this direction came from also carries
 * a sand `#D8C98F` for middling health, banded between the teal and the red — but
 * a band needs a threshold, and this board has none to state: rank comes from
 * `core`, a blend of merit and demand, and health is a fact about the scorecard
 * rather than a pass mark. A colour that implied a passing line the product does
 * not draw would be decoration that lies. So it was left in the canvas.
 *
 * `--cut` is the founder's own vermilion, lifted from `#E2482C` to `#F45C33` —
 * the least that clears 4.5:1 on `--card`, which is the lightest surface that
 * ever sets 12px mono in the accent. `--held` is the canvas's `#5FB9A5` taken
 * three steps down to `#3E9C86` for the same two reasons: at `#5FB9A5` (L* 69.4)
 * the surviving half of every bar would have outshone the cut, and `#3E9C86`
 * clears 4.5:1 on `--card` where the health figure is set in 10.5px mono.
 * `--rise` is a slab surface and carries neither hue as type, which is the one
 * place they do not have to clear AA.
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
 *
 * ## Instrument Serif was tried, and is not here
 *
 * The founder's design canvas sets its display type in Instrument Serif and its
 * data in JetBrains Mono, and the instruction was to read their earlier "don't
 * put a fancy font" as "no decorative face" rather than as a veto on their own
 * choice. So it was tried, on a running page, in the three places it could
 * plausibly have gone. It is not shipped, for one reason that showed up in all
 * three: **Instrument Serif has a single 400 weight and hairline thins, and this
 * theme's ground is CIE L* 7.5.** On a dark ground a hairline serif loses mass,
 * and mass is what every one of those three elements was doing.
 *
 * 1. **The hero.** "You can't outbid the pit." is a taunt, and `brief` Part 5
 *    fixes the homepage register as aggressive. Archivo 800 uppercase shouts it.
 *    Instrument Serif turns it into an epigraph — genuinely handsome, and it
 *    reads as a literary masthead rather than a threat. It also stopped filling
 *    the hero slab, so the slab collapsed around it and the page opened quieter
 *    than the sentence it opens with.
 * 2. **The stats row.** At 44px the numerals are elegant and weightless. The mono
 *    at 600 reads as a measurement; the serif reads as a pull quote. And it would
 *    have split the site's numerals across two families on the rule "is this one
 *    in a column", which is not a rule anyone can hold.
 * 3. **A board title.** This is the one place it genuinely looked better — the
 *    board's register is plain, and "Developer Tools" set in a serif is calm and
 *    editorial. It is still not shipped, because a display face that appears on
 *    the second page and not on the first is not a typographic system; it is an
 *    inconsistency with a nice explanation.
 *
 * The canvas is right about its own artboards. They are fixed 1280px cards on a
 * `#e6e2d9` page at a size where that face has plenty of presence. That is a
 * different problem from setting a shouted headline over a near-black slab, and
 * the answer transferred less well than the health framing did.
 */

/** The stylesheet link for the two families. The only external reference on any page. */
export const FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&amp;' +
    'family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">',
].join('\n');

/**
 * The tokens. Six hex values; everything else is derived from them.
 *
 * The surface stack, deepest first, with its measured CIE L* and what carries the
 * depth at each step:
 *
 * | token    | value     | L*   | what sits on it                          |
 * |----------|-----------|------|------------------------------------------|
 * | `--sunk` | `#0F0A06` |  3.0 | the recess: meter tracks, wells, inputs  |
 * | `--pit`  | `#1A1610` |  7.5 | the ground: the page, and the last row   |
 * | `--card` | `#29241C` | 14.5 | raised: cards, ledgers, the top row      |
 * | `--rise` | `#353129` | 20.5 | the slab: hero, closer, board head       |
 *
 * Steps of 4.5 / 7.0 / 6.0 L*. Depth is never one cue: a raised surface is
 * lighter, *and* takes a `--line` hairline, *and* a `--lip` top edge, *and* an
 * occlusion shadow. The pit's rows run `--card` down to `--pit`, so the last row
 * is literally flush with the page floor while the meter track stays a real
 * recess beneath even that.
 *
 * `--ink-c`, `--cut-c` and `--shade-c` are the space-separated channel triplets
 * the `rgb(… / a)` derivations need. The first two are the same two colours
 * written so an alpha can be attached without a preprocessor; `--shade-c` is the
 * one addition the dark theme needs, because occlusion cannot be made out of the
 * text colour.
 *
 * Contrast, measured, worst case across the whole stack: `--ink` 10.5:1,
 * `--dim` 7.0:1, `--dimmer` 5.5:1, `--faint` 4.9:1, `--cut` 4.7:1 and `--held`
 * 4.6:1 on `--card`. Every one clears WCAG AA for small text on every surface it
 * is used on.
 */
export const TOKENS = `
:root{
  /* One committed scheme, declared so the UA paints its own chrome to match. */
  color-scheme:dark;

  --sunk:#0F0A06;
  --pit:#1A1610;
  --card:#29241C;
  --rise:#353129;
  --ink:#EDE6DE;
  --cut:#F45C33;
  --held:#3E9C86;

  --ink-c:237 230 222;
  --cut-c:244 92 51;
  --held-c:62 156 134;
  --pit-c:26 22 16;
  --shade-c:0 0 0;

  --dim:rgb(var(--ink-c) / .78);
  --dimmer:rgb(var(--ink-c) / .66);
  --faint:rgb(var(--ink-c) / .60);
  --on-lit:rgb(var(--pit-c) / .70);
  --line:rgb(var(--ink-c) / .17);
  --hair:rgb(var(--ink-c) / .09);
  --wash:rgb(var(--shade-c) / .32);

  --lip:inset 0 1px 0 rgb(var(--ink-c) / .07);
  --e1:0 1px 2px rgb(var(--shade-c) / .45);
  --e2:0 2px 6px rgb(var(--shade-c) / .40), 0 10px 26px rgb(var(--shade-c) / .42);
  --e3:0 3px 10px rgb(var(--shade-c) / .45), 0 24px 64px rgb(var(--shade-c) / .55);

  /* Square. Three steps kept as tokens so the corner stays one lever for every
     card, panel, well, input and button — the lever is at zero. Badges and
     status chips are the exception and keep their 999px inline; the meter and
     the bars are square for a reason of their own, given at .meter below.
     app/pit.css holds the long version. */
  --r1:0; --r2:0; --r3:0;

  --sans:"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;

/**
 * The base layer every string surface shares: reset, page, nav, headings, cards,
 * buttons, the meter, and the two accessibility floors.
 *
 * The focus ring is a real one — a bright `--ink` outline with a dark halo behind
 * it, so it is visible on all four surfaces in the stack — because
 * `:focus-visible` on a re-themed page is the first thing a keyboard reader loses
 * and the last thing anyone checks.
 *
 * `prefers-reduced-motion` kills transitions and animations outright rather than
 * shortening them.
 */
export const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--pit);-webkit-text-size-adjust:100%}
body{background:var(--pit);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;
  font-synthesis-weight:none;overflow-x:hidden}
/*
 * On dark, a ring made only of the text colour disappears against a raised
 * surface and a ring made only of the ground disappears against the floor. Two
 * tones — a bright inner ring and a dark outer one — is visible on every surface
 * in the stack, which is the whole point of a focus ring.
 */
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:0;
  box-shadow:0 0 0 4px rgb(var(--shade-c) / .55)}
a{color:inherit}

.wrap{max-width:1020px;margin:0 auto;padding:0 18px 72px}
.wrap.narrow{max-width:720px}

nav{display:flex;justify-content:space-between;align-items:center;
  padding:20px 0 18px;gap:16px}
.mark{font-weight:800;font-size:14px;letter-spacing:.02em;text-transform:uppercase;
  text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.mark::before{content:"";display:inline-block;width:8px;height:8px;border-radius:0;
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
/* Raised: lighter than the ground, with a hairline, a lip and an occlusion
   shadow. Four cues that agree, none of which is a shadow doing the work alone. */
.blk{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--lip),var(--e1);padding:16px 18px;margin-top:16px}
.blk p{font-size:14px;line-height:1.6;color:var(--dim)}
.blk p+p{margin-top:8px}
.blk p b{color:var(--ink);font-weight:600}
.sect{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--dimmer);margin-bottom:8px}
/* Recessed: darker than the ground, and the inset shadow falls from the top edge
   inward, which is the same light behaving the same way. */
.well{background:var(--sunk);border:1px solid var(--hair);border-radius:var(--r2);
  padding:16px 18px;margin-top:16px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}

/* ---------- controls ---------- */
.act{display:inline-flex;align-items:center;gap:7px;font-family:var(--sans);
  font-size:13px;font-weight:600;letter-spacing:-.005em;text-decoration:none;
  color:var(--ink);background:var(--card);border:1px solid var(--line);
  border-radius:var(--r1);padding:9px 14px;box-shadow:var(--lip),var(--e1);cursor:pointer;
  transition:box-shadow .15s ease,transform .15s ease,border-color .15s ease,background .15s ease}
.act:hover{background:var(--rise);box-shadow:var(--lip),var(--e2);border-color:rgb(var(--ink-c) / .28)}
.act:active{transform:translateY(1px)}
/* The primary action inverts the stack: the lightest possible surface, with the
   ground itself as its text. On dark that reads louder than any coloured button,
   and it keeps the accent meaning only "taken". */
.act.prime{background:var(--ink);border-color:var(--ink);color:var(--pit);box-shadow:var(--e2)}
.act.prime:hover{background:#FFFBF6;border-color:#FFFBF6}
.act small{font-family:var(--mono);font-size:11px;font-weight:500;opacity:.72}

label{display:block;margin-top:16px}
label .sh{display:block;margin-bottom:6px}
input[type=text],input[type=url],input[type=email],textarea,select{
  width:100%;background:var(--sunk);border:1px solid var(--line);border-radius:var(--r1);
  color:var(--ink);font-family:var(--sans);font-size:14.5px;padding:10px 12px;
  box-shadow:inset 0 2px 4px rgb(var(--shade-c) / .45)}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--ink);
  outline-offset:1px;border-color:var(--ink)}
textarea{min-height:110px;resize:vertical;line-height:1.55}
.hint{font-family:var(--mono);font-size:11px;color:var(--dimmer);margin-top:6px}

/* ---------- the cut meter ---------- */
/*
 * The track is the recess — --sunk, the one surface below everything, so the
 * hundred points a product walked in with are a groove cut into whatever they
 * are drawn on. The kept head is --held at .70, which composites to L* 42.9 —
 * the same weight the old neutral head carried, now saying which half of the bar
 * it is. The segments are --cut stepped down but FLOORED at .58, because fading
 * an accent toward a dark track by alpha runs it into mud and the smallest block
 * has to still read red.
 *
 * The ends are square, and not merely because the cards are. The track was a
 * 999px pill with overflow:hidden, so the cap was clipping the head and the
 * last segment: the smallest metric's block was drawn narrower than its share,
 * which is exactly the claim this element makes about itself. Square ends give
 * every segment its true width. app/pit.css .meter carries the argument.
 */
.meter{display:block;height:9px;border-radius:0;background:var(--sunk);
  overflow:hidden;box-shadow:inset 0 1px 2px rgb(var(--shade-c) / .55)}
.meter .row{display:flex;height:100%;width:100%}
.meter .kept{background:rgb(var(--held-c) / .70);flex:0 0 auto;height:100%}
.meter .seg{background:var(--cut);flex:0 0 auto;height:100%;
  border-left:1px solid rgb(var(--shade-c) / .55)}
.meter .seg:first-child{border-left:0}
.meter .seg.s2{background:rgb(var(--cut-c) / .90)}
.meter .seg.s3{background:rgb(var(--cut-c) / .80)}
.meter .seg.s4{background:rgb(var(--cut-c) / .71)}
.meter .seg.s5{background:rgb(var(--cut-c) / .64)}
.meter-cap{display:flex;justify-content:space-between;gap:12px;margin-top:6px;
  font-family:var(--mono);font-size:10.5px;color:var(--dimmer);letter-spacing:.02em}

/* ---------- numbers ---------- */
.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pts{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;
  font-size:12px;color:var(--cut)}
/* The other half of the same quantity. .pts is what a juror took; .held is what
   the card walked out with. Both are mono, both are tabular, and they are the
   only two coloured stops in the system. */
.held{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;
  color:var(--held)}
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
