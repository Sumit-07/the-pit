/**
 * The two surfaces of the buying path: the form, and the refusal.
 *
 * ## Guest checkout, rendered literally
 *
 * `brief §2.1`: "No login at submission." So this page is a `<form method="post">`
 * with five fields and a price, and there is nothing else on the path between a
 * visitor and their purchase — no account step, no email confirmation, no
 * sign-in wall.
 *
 * That sentence is about AUTHENTICATION, and it is worth being exact, because an
 * earlier version of this comment read it as a ban on scripting and then got
 * quoted back as if it were the founder's rule. It never was. What §2.1 forbids
 * is a step between a visitor and their purchase; a `<script>` that fills two
 * fields in for them is the opposite of a step.
 *
 * So the page does carry one now — `AUTOFILL_SCRIPT` below, which reads the
 * product's own page through the guarded fetcher and offers what it finds. It is
 * bound after the markup, touches nothing on the submit path, and fills only
 * fields that are empty.
 *
 * GitHub sits BESIDE it, never in front of it. When a session happens to be
 * present the page says so — the submission will be attributed, and an ownership
 * conflict gets caught before the charge rather than after — and when there is no
 * session the page says nothing about signing in at all. A sign-in prompt on a
 * buying path becomes a step in the buying path.
 *
 * ## Why the refusal is a page and not a status code
 *
 * `brief §2.4` wants the cap expressed as a countdown to the next rebuild rather
 * than as a limit: "next pitch after tonight's rebuild, 02:00 UTC". The
 * difference between that sentence and "limit reached" is the whole design — one
 * tells a user something true about how the board works, the other tells them
 * they are being rationed — and it only exists if there is somewhere to print it.
 * So a rejection renders the message `@the-pit/payments` composed, verbatim, with
 * the wall clock and the duration beside it, and the visitor's typed text still
 * in the form so a re-pitch is an edit rather than a retype.
 *
 * The status is 422 and not 400: the request was well-formed and we understood it
 * completely. It is the submission that cannot be accepted, and the body says
 * why.
 *
 * ## Nothing here was paid for
 *
 * Every path through this file happens before a Dodo session exists. The word
 * that has to survive from `DECISIONS.md` S12 — "you have not been charged" — is
 * printed on the refusal, because a visitor who has just been refused after
 * clicking a button marked $5 has every reason to check their card statement.
 */

import { escapeHtml } from '@the-pit/auth';
import { formatUsd, PURCHASE_TERMS, type PriceTier, type SubmissionRejection } from '@the-pit/payments';

import { panelLabels } from '@/lib/boards/copy';
import type { CategoryPanel } from '@/lib/checkout/panel';
import { PITCH_LIMIT } from '@/lib/checkout/pitch';
import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

/** One sans, one mono, from `lib/theme.ts` — the same two every surface loads. */
const FONTS = FONT_LINKS;

const CSS = `${TOKENS}${BASE}
.wrap{max-width:720px}
/* The submit page, and only the submit page, runs two columns: the form, and the
   jury it will be read by. The refusal page keeps the 720px measure — it has one
   thing to say and no panel beside it. */
.wrap.wide{max-width:1080px}
.wrap.wide header.page{max-width:720px}

header.page h1{margin-top:9px}

/* ---------- the form, and the panel beside it ---------- */
.pitchgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:34px;align-items:start}
@media (min-width:1000px){
  .pitchgrid:not(.alone){grid-template-columns:minmax(0,1fr) 340px;gap:40px}
}
/* Deliberately NOT sticky with its own scrollbar. Twelve entries is taller than
   any viewport, so a pinned column would have become a nested scroll region
   holding the one thing on this page a visitor most needs to read straight
   through. It flows with the form and ends near it. */
.formcol{min-width:0}

/*
 * The panel column is a RECESS, not a card.
 *
 * --sunk is the one surface below the ground, and putting the jury in it says
 * the right thing about the jury: it is not a feature being sold beside the form,
 * it is the floor the form drops into. A raised card here would have read as a
 * third pricing tier.
 */
.panelcol{background:var(--sunk);border:1px solid var(--hair);border-radius:var(--r2);
  padding:18px 18px 20px;box-shadow:inset 0 2px 5px rgb(var(--shade-c) / .5)}
.pnote{font-size:12.5px;line-height:1.65;color:var(--dimmer);margin-top:9px}
.pnote b{color:var(--ink);font-weight:600}
.phead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  margin-top:22px;padding-bottom:8px;border-bottom:1px solid var(--line);
  font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.15em;
  text-transform:uppercase;color:var(--dimmer)}
.phead span:last-child{color:var(--faint);letter-spacing:.1em;text-align:right}
.plist{list-style:none;margin:0;padding:0}
.plist li{padding:12px 0;border-bottom:1px solid var(--hair)}
.plist li:last-child{border-bottom:0}
.plist b{display:block;font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
/* The weight, and the price sensitivity: a fact about the panel's configuration,
   which is why it is mono and quiet rather than a claim about severity. */
.plist .pw{display:block;margin-top:3px;font-family:var(--mono);font-variant-numeric:tabular-nums;
  font-size:10.5px;letter-spacing:.02em;color:var(--faint)}
.plist .pm{display:block;margin-top:6px;font-size:12px;line-height:1.6;color:var(--dim)}
.pfoot{margin-top:14px;font-family:var(--mono);font-size:10.5px;line-height:1.7;color:var(--faint)}

.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:10px}
.tier{display:block;background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
  box-shadow:var(--lip),var(--e1);padding:15px 16px;cursor:pointer;
  transition:box-shadow .15s ease,border-color .15s ease}
.tier:hover{box-shadow:var(--e2);border-color:rgb(var(--ink-c) / .2)}
.tier:has(input:checked){border-color:var(--ink);box-shadow:var(--e2)}
.tier:has(input:focus-visible){outline:2px solid var(--ink);outline-offset:2px}
.tier b{display:flex;align-items:center;gap:9px;font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.tier span{display:block;font-family:var(--mono);font-size:11.5px;color:var(--dimmer);
  margin-top:7px;padding-left:24px}
.tier input{margin:0;flex:0 0 auto;accent-color:var(--ink);width:15px;height:15px}

/* The one button that takes money is the filled one, wherever it appears — and on
   dark "filled" means the lightest surface in the system, with the ground as its
   text. Colouring it would spend the one hue that means "taken". */
button.act{margin-top:22px;font-size:15px;padding:13px 20px;
  background:var(--ink);border-color:var(--ink);color:var(--pit);box-shadow:var(--e2)}
button.act:hover{background:#FFFBF6;border-color:#FFFBF6}
a.act{margin-top:16px}

.warn{border-left:3px solid var(--cut)}
.warn h2{color:var(--cut)}
.when{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;color:var(--ink);
  background:var(--sunk);border-radius:var(--r1);padding:10px 12px;margin-top:12px;display:block;
  box-shadow:inset 0 1px 3px rgb(var(--shade-c) / .45)}
.linked{font-family:var(--mono);font-size:11px;color:var(--dim);
  border:1px solid var(--line);border-radius:999px;padding:3px 9px;display:inline-block}
.terms{margin-top:14px;font-size:14px;line-height:1.65;color:var(--dim);padding-left:1.2rem}
.terms li{margin-top:6px}

/* The URL field's autofill. Three rules, all of them structural — the surfaces,
   the type and the colours are the tokens the rest of the form uses. The icon is
   absolutely positioned inside the field's own box so it reads as part of the
   input rather than as a second control.

   The gutter it sits in is reserved ALWAYS, not only once an icon has arrived.
   Padding that appears with the favicon moves the caret and every character to
   its right in the middle of typing, which is the one moment a text field must
   hold still. Sixteen pixels of empty space is the cheap half of that trade. */
.urlrow{position:relative;display:block}
.urlrow .icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);
  width:16px;height:16px;border-radius:3px;background:var(--rise);object-fit:contain}
.urlrow input{padding-left:37px}
/* The status line. Same mono hint type as every other hint, one shade up so it
   reads as an answer rather than as more instructions.

   The reserved line height is there for the same reason as the gutter: it says something on
   every path now, including while someone is still typing, so it appears and is
   replaced far more often than it used to. Reserving its one line keeps the
   fields below it from stepping down and back up as it does. */
.look{display:block;font-family:var(--mono);font-size:11px;line-height:1.45;color:var(--dim);
  margin-top:6px;min-height:16px}
.look[hidden]{display:none}
`;

/**
 * The ids the autofill binds to.
 *
 * Named once, used by both forms and by the script, so a renamed field cannot
 * quietly detach the enhancement from the markup it enhances.
 */
const FORM_ID = 'pitch-form';
const ROW_ID = 'url-row';
const URL_ID = 'f-url';
const NAME_ID = 'f-name';
const DESC_ID = 'f-description';
const ICON_ID = 'site-icon';
const STATE_ID = 'site-state';

/**
 * How long a pause in typing counts as "they have stopped".
 *
 * 600ms is the middle of the band where a pause stops being a pause and starts
 * being a stop. Lower and the lookup fires between the syllables of a domain
 * somebody is still typing; higher and the icon arrives after they have already
 * tabbed away, which is the behaviour this replaces.
 */
const PAUSE_MS = 600;

/**
 * A pasted value is not a pause — it is a finished value, arriving whole.
 *
 * The short timer exists only because `paste` fires BEFORE the field holds the
 * pasted text; it is a turn of the event loop, not a wait.
 */
const PASTE_MS = 60;

/**
 * The sentences that do not depend on what a site answered.
 *
 * `LIMITED` is the rate limit (`SITE_METADATA_RATE_LIMIT`) said as itself. The
 * endpoint's 429 used to reach the browser as "nothing we could read there",
 * which describes every site in a row as broken and is the kind of thing that
 * gets reported as a bug in the fetcher.
 */
const NOT_A_URL = 'That does not look like a web address — try linear.app, or paste the full https:// one.';
const KEEP_TYPING = 'Waiting for the rest of the address — something like linear.app.';
const LIMITED = 'That is a lot of lookups in a few minutes. Give it a moment, or type the two fields in yourself.';

/**
 * The autofill: read the page the visitor named, and offer what it says.
 *
 * ## What it does, and the four rules it will not break
 *
 * On a pause in typing, on paste, and on `blur`/`change`, it normalizes what is
 * in the URL field and POSTs it to `/api/site-metadata`, which runs it through
 * `@the-pit/fetch`'s guards and answers with a title, a description and a
 * favicon. Then:
 *
 * 1. **It accepts what people actually type.** `linear.app` is what somebody
 *    types when asked for a web address; `https://linear.app` is what a form
 *    designer types. The previous version tested the raw value against
 *    `/^https?:\/\//` and returned if it failed, so the common case did
 *    nothing at all — no fetch, no icon, no message — and read as a feature that
 *    had never been built. `shape()` below now does what the server already does
 *    with the same string (`normalizeUrl` in `@the-pit/engine` defaults a bare
 *    host to `https://`), so the browser is no longer stricter than the thing it
 *    is a front end for.
 * 2. **It fills empty fields only.** `value.trim() === ''` is checked
 *    immediately before every write, not when the request was sent, so a
 *    visitor who typed their own name into the field WHILE the lookup was in
 *    flight keeps it. An autofill that clobbers the sentence you just finished
 *    is the single most annoying way to ship this, and the check is cheap.
 * 3. **It never returns silently.** Every path out of `look()` leaves a visible
 *    state: reading, found, nothing found, not an address, or — for an emptied
 *    field — deliberately blank with the icon gone. That is the rule the old
 *    version broke, and breaking it is what made a working endpoint look like
 *    dead markup.
 * 4. **It never blocks the submission.** Nothing here touches `submit`, nothing
 *    disables the button, and every failure is caught. The worst case is a form
 *    with an empty description that the visitor fills in by hand, which is
 *    exactly the form that shipped before this existed.
 *
 * ## The smaller decisions
 *
 * A monotonic `seq` guards against out-of-order answers: type one URL, correct
 * it, and the slow first response must not overwrite the fast second one's
 * fields or its status line. Clearing the field bumps it too, so an answer that
 * lands after the visitor has wiped the URL paints nothing.
 *
 * `last` suppresses a re-fetch of an unchanged value — tabbing back and forth
 * through a filled form should cost nothing, and the rate limit
 * (`SITE_METADATA_RATE_LIMIT`, twenty per five minutes) is only generous because
 * of it. It holds the NORMALIZED url, so `linear.app`, `linear.app/` and
 * `https://linear.app` are one lookup and not three. It is deliberately cleared
 * on failure so that a retry after a dropped connection is still possible.
 *
 * `blur` also writes the scheme back into the field when the visitor left it
 * out. That is not cosmetic: the input is `type="url" required`, so a bare
 * `linear.app` would be stopped by the browser's own validation at the moment
 * they press the button, having been told all along that we understood it. The
 * server normalizes the same way, so this only makes the field agree with what
 * both ends already decided the value means.
 *
 * The favicon is set through `img.src`, and the text through `.value` and
 * `.textContent` — never `innerHTML`. The endpoint sanitizes on the way out;
 * this is the second half of that, and it means hostile `<meta>` content is
 * inert here by construction rather than by escaping.
 */
const AUTOFILL_SCRIPT = `(function(){
  var form=document.getElementById(${JSON.stringify(FORM_ID)});
  if(!form||typeof window.fetch!=='function')return;
  var url=document.getElementById(${JSON.stringify(URL_ID)});
  var state=document.getElementById(${JSON.stringify(STATE_ID)});
  if(!url||!state)return;
  var nameField=document.getElementById(${JSON.stringify(NAME_ID)});
  var descField=document.getElementById(${JSON.stringify(DESC_ID)});
  var icon=document.getElementById(${JSON.stringify(ICON_ID)});
  var timers=typeof window.setTimeout==='function'&&typeof window.clearTimeout==='function';
  var NOT_A_URL=${JSON.stringify(NOT_A_URL)},KEEP_TYPING=${JSON.stringify(KEEP_TYPING)},LIMITED=${JSON.stringify(LIMITED)};
  var last='',shown='',seq=0,timer=null,pasted=false;
  function say(text){state.textContent=text;state.hidden=text==='';}
  function nothingAt(where){return 'Nothing we could read at '+where+' — type the two fields in yourself.';}
  function hideIcon(){if(icon){icon.onerror=null;icon.hidden=true;}shown='';}
  function showIcon(href,where){
    if(!icon)return;
    if(typeof href!=='string'||!/^https?:\\/\\//i.test(href)){hideIcon();return;}
    icon.onerror=hideIcon;icon.src=href;icon.hidden=false;shown=where;
  }
  function fill(field,text){
    if(!field||typeof text!=='string'||text==='')return false;
    if(field.value.trim()!=='')return false;
    field.value=text;return true;
  }
  /* '' nothing typed, '?' still typing, '!' not an address, anything else is the
     absolute URL to ask about. No real URL can be one of those three. */
  function shape(raw){
    var value=raw.trim();
    if(value==='')return '';
    if(/\\s/.test(value))return '!';
    var absolute=/^[a-z][a-z0-9+.-]*:\\/\\//i.test(value);
    if(absolute&&!/^https?:\\/\\//i.test(value))return '!';
    if(!absolute&&/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(value))return '!';
    var parsed;
    try{parsed=new URL(absolute?value:'https://'+value);}catch(e){return '!';}
    if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')return '!';
    if(parsed.hostname==='')return '!';
    if(/^[0-9.]+$/.test(parsed.hostname))return parsed.href;
    /* No dot yet, or nothing that can be a TLD after the last one: they are
       part way through typing a host, not wrong. */
    if(!/\\.[a-z]{2,}$/i.test(parsed.hostname))return '?';
    return parsed.href;
  }
  function hostOf(value){try{return new URL(value).host;}catch(e){return 'that address';}}
  function reset(){seq++;last='';hideIcon();say('');}
  function look(typing){
    var target=shape(url.value);
    if(target===''){reset();return;}
    if(target==='!'||target==='?'){
      seq++;last='';hideIcon();
      say(target==='?'&&typing?KEEP_TYPING:NOT_A_URL);
      return;
    }
    /* The one quiet return, and only when the line already says the answer for
       exactly this URL. */
    if(target===last&&!state.hidden)return;
    last=target;
    var mine=++seq;
    var where=hostOf(target);
    if(where!==shown)hideIcon();
    say('Reading '+where+'…');
    window.fetch('/api/site-metadata',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({url:target})
    }).then(function(r){return r.ok?r.json():(r.status===429?{status:'limited'}:null);}).then(function(data){
      if(mine!==seq)return;
      if(data&&data.status==='limited'){
        /* The rate limit, said as itself. Reported as "nothing found" it reads
           as every site in a row being unreadable, which is a bug report. */
        last='';hideIcon();say(LIMITED);return;
      }
      if(!data||data.status!=='found'){hideIcon();say(nothingAt(where));return;}
      showIcon(data.faviconUrl,where);
      var filled=[];
      if(fill(nameField,data.title))filled.push('name');
      if(fill(descField,data.description))filled.push('description');
      say(filled.length===0
        ? 'Read '+where+'. Your own words were already there, so nothing was changed.'
        : 'Read '+where+' and filled in the '+filled.join(' and ')+'. Edit anything it got wrong.');
    }).catch(function(){
      if(mine!==seq)return;
      last='';hideIcon();say(nothingAt(where));
    });
  }
  function stop(){if(timer!==null&&timers){window.clearTimeout(timer);}timer=null;}
  function after(ms){
    stop();
    if(!timers){look(true);return;}
    timer=window.setTimeout(function(){timer=null;look(true);},ms);
  }
  function settle(){stop();look(false);}
  url.addEventListener('input',function(){
    var wait=pasted?${String(PASTE_MS)}:${String(PAUSE_MS)};
    pasted=false;
    if(url.value.trim()===''){stop();reset();return;}
    after(wait);
  });
  /* A paste event fires before the value lands, and a paste is a finished
     address rather than a pause in typing — so it only shortens the wait that
     the input event following it is about to schedule. */
  url.addEventListener('paste',function(){pasted=true;});
  url.addEventListener('blur',function(){
    var value=url.value.trim();
    if(value!==url.value)url.value=value;
    var target=shape(value);
    if(target!==''&&target!=='!'&&target!=='?'&&!/^https?:\\/\\//i.test(value)){
      url.value='https://'+value;
    }
    settle();
  });
  url.addEventListener('change',settle);
})();`;

/**
 * Swap the visible panel when the category changes.
 *
 * The panels for every offered category are all in the document already — this
 * only flips the `hidden` attribute. With scripting off the page still shows the
 * panel for the category the `<select>` has selected on arrival, which is the
 * correct one and not a placeholder, and every other panel is present in the
 * markup for ctrl-F and for a screen reader that walks the whole document.
 */
const PANEL_SCRIPT = `(function(){
  var form=document.getElementById(${JSON.stringify(FORM_ID)});
  if(!form)return;
  var select=form.querySelector('select[name="category"]');
  var groups=document.querySelectorAll('[data-panel]');
  if(!select||!groups.length)return;
  function show(){
    for(var i=0;i<groups.length;i++){
      var on=groups[i].getAttribute('data-panel')===select.value;
      if(on)groups[i].removeAttribute('hidden');else groups[i].setAttribute('hidden','');
    }
  }
  select.addEventListener('change',show);
  show();
})();`;

function document_(title: string, body: string, wide = false): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(title)} — The Pit</title>`,
    FONTS,
    `<style>${CSS}</style>`,
    '</head>',
    `<body><div class="wrap${wide ? ' wide' : ''}">`,
    '<nav><a class="mark" href="/">THE P<i>I</i>T</a>',
    '<span class="navr"><a href="/boards">Boards</a><a href="/account">Account</a></span></nav>',
    body,
    '</div>',
    // At the end of the body, so they bind to markup that already exists and so
    // the form is on screen and usable before a byte of either has run.
    `<script>${AUTOFILL_SCRIPT}</script>`,
    // Only where there is something to switch between. `wide` is set exactly when
    // the panel column rendered, so the refusal page and a deployment with no
    // reference files ship no dead script at all.
    wide ? `<script>${PANEL_SCRIPT}</script>` : '',
    '</body>',
    '</html>',
  ].join('');
}

/** What the visitor typed, echoed back so a rejection is an edit and not a retype. */
export interface SubmitFormValues {
  readonly url: string;
  readonly name: string;
  /**
   * What the SITE says.
   *
   * Still the field the panel reads and still capped at `SANITIZE_LIMIT`, but it
   * is now pre-filled from the product's own `<meta name="description">` by
   * `POST /api/site-metadata`, on a pause in typing or on leaving the URL field.
   * Pre-filled, not locked: a founder whose meta description is stale edits it,
   * and a founder who typed first is never overwritten.
   */
  readonly description: string;
  /** What they CLAIM, in their own words. `lib/checkout/pitch.ts`; up to `PITCH_LIMIT`. */
  readonly pitch: string;
  readonly categorySlug: string;
  readonly tier: string;
}

export const EMPTY_FORM: SubmitFormValues = {
  url: '',
  name: '',
  description: '',
  pitch: '',
  categorySlug: '',
  tier: 'single',
};

export interface SubmitPageView {
  readonly categories: readonly string[];
  /**
   * The installed panel for each offered category, from `lib/checkout/panel.ts`.
   *
   * Optional, and empty is a real value: a deployment whose reference files are
   * not mounted renders the form on its own rather than a column of placeholders.
   */
  readonly panels?: readonly CategoryPanel[];
  readonly tiers: readonly PriceTier[];
  readonly values: SubmitFormValues;
  /** The description limit, printed rather than implied. `DECISIONS.md` S5: 300. */
  readonly descriptionLimit: number;
  /**
   * True when a session cookie was present.
   *
   * Only ever used to ADD a line. There is no branch here that withholds the form
   * from a signed-out visitor, and there must never be one.
   */
  readonly signedIn: boolean;
  /**
   * One sentence about why this render is a re-render, when it is one.
   *
   * For the refusals that are OURS rather than `@the-pit/payments`' — an unknown
   * tier, a pitch over the cap. Those are not `SubmissionRejection`s (no rule in
   * that package has an opinion about either) and they do not deserve the whole
   * refusal page, but a 422 that re-renders the form with no explanation is a
   * form that appears to have silently ignored the button.
   */
  readonly notice?: string;
}

function categoryOptions(view: SubmitPageView): string {
  const options = view.categories.map((slug) => {
    const selected = slug === view.values.categorySlug ? ' selected' : '';
    return `<option value="${escapeHtml(slug)}"${selected}>${escapeHtml(slug)}</option>`;
  });
  return options.join('');
}

function tierChoices(view: SubmitPageView): string {
  return view.tiers
    .map((tier) => {
      const checked = tier.id === view.values.tier ? ' checked' : '';
      const detail =
        tier.attempts === 1
          ? 'One run. One verdict. One place on the board.'
          : `${tier.attempts} runs, plus the off-board fit report.`;
      return [
        '<label class="tier">',
        `<b><input type="radio" name="tier" value="${escapeHtml(tier.id)}"${checked}>`,
        `${escapeHtml(tier.label)}</b>`,
        `<span>${escapeHtml(detail)} ${escapeHtml(formatUsd(tier.amountCents))}</span>`,
        '</label>',
      ].join('');
    })
    .join('');
}

/** A metric name, made readable. Mirrors `boards/view.ts`'s `metricLabel`. */
function label(name: string): string {
  const text = name.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "The panel you'll face" — the column the design canvas puts beside this form.
 *
 * Every line is read off the installed reference files by `lib/checkout/panel.ts`
 * and printed verbatim; nothing here is written about a juror. That is the point:
 * this is not a marketing panel describing a jury, it is *the jury*, shown before
 * the charge instead of after it, on a product whose whole claim is that the
 * judging is in the open.
 *
 * The weight line says "weighs X most", never "cuts X hardest". The canvas's
 * roster card carries a median cut per agent across all runs, and that number
 * does not exist here — there are two seeded categories and no run history — so
 * what is shown is the configured weight, which does exist and which is what a
 * submitter can act on.
 *
 * Every panel is rendered; all but the selected one carry `hidden`. `PANEL_SCRIPT`
 * flips that on a category change, and with scripting off the selected category's
 * panel is the one on screen.
 */
function panelColumn(view: SubmitPageView): string {
  const panels = view.panels ?? [];
  if (panels.length === 0) return '';

  const groups = panels.map((panel) => {
    const names = panelLabels(panel.type);
    const jurors = panel.jurors
      .map((juror) =>
        [
          '<li>',
          `<b>${escapeHtml(juror.role)}</b>`,
          juror.heaviest === undefined
            ? ''
            : `<span class="pw">weighs ${escapeHtml(label(juror.heaviest.metric))} most &middot; ${juror.heaviest.weight}/10</span>`,
          `<span class="pm">${escapeHtml(juror.mandate)}</span>`,
          '</li>',
        ].join(''),
      )
      .join('');

    const buyers = panel.personas
      .map((persona) =>
        [
          '<li>',
          `<b>${escapeHtml(persona.name)}</b>`,
          `<span class="pw">price sensitivity ${escapeHtml(persona.priceSensitivity)}</span>`,
          `<span class="pm">${escapeHtml(persona.who)}</span>`,
          '</li>',
        ].join(''),
      )
      .join('');

    const selected = panel.slug === view.values.categorySlug;
    return [
      `<div data-panel="${escapeHtml(panel.slug)}"${selected ? '' : ' hidden'}>`,
      `<div class="phead"><span>${escapeHtml(names.critics)} &middot; ${panel.jurors.length} mandates</span>`,
      `<span>${panel.metrics.length} metrics</span></div>`,
      `<ol class="plist">${jurors}</ol>`,
      `<div class="phead"><span>${escapeHtml(names.buyers)} &middot; ${panel.personas.length}</span>`,
      '<span>forced choice, no ties</span></div>',
      `<ul class="plist">${buyers}</ul>`,
      panel.metrics.length === 0
        ? ''
        : `<p class="pfoot">Scored on ${panel.metrics.map((metric) => escapeHtml(label(metric))).join(' &middot; ')}.</p>`,
      '</div>',
    ].join('');
  });

  return [
    '<aside class="panelcol" aria-label="The panel you will face">',
    '<div class="sh">The panel you&rsquo;ll face</div>',
    '<p class="pnote">This is the jury installed for the category you picked, read off the same files ' +
      'that will score you. Everyone walks in at <b>100</b>; every mandate below takes points off it, ' +
      'with a reason, in public. Change the category and this column changes with it.</p>',
    groups.join(''),
    '</aside>',
  ].join('');
}

/**
 * The form. Four fields, a price, and a button.
 *
 * `novalidate` is deliberately absent and `required` is deliberately present:
 * browser validation is fast feedback and costs nothing. It is not the check.
 * `brief §2.4` calls the server side "authoritative" and the server re-runs every
 * rule on the way in, so a visitor with scripting off, an old browser, or `curl`
 * gets the same answer — just a slower one.
 */
export function renderSubmitPage(view: SubmitPageView): string {
  const panel = panelColumn(view);
  const body = [
    '<header class="page">',
    '<div class="sh">Throw it in</div>',
    '<h1>Five dollars. One honest verdict.</h1>',
    '<p class="lede">Paste the URL, name it, say what it does. Pay. That is the whole form — ' +
      '<b>no account, no login, no waiting on an email</b>. The panel does not know who paid and could not ' +
      'rank you higher if it did.</p>',
    view.signedIn
      ? '<p class="lede"><span class="linked">Signed in</span> This pitch will be attached to your account, ' +
        'and if the product is already listed under someone else we will tell you now rather than after you pay.</p>'
      : '',
    view.notice === undefined
      ? ''
      : `<div class="blk warn"><p><b>${escapeHtml(view.notice)}</b></p></div>`,
    '</header>',

    // Two columns from 1000px: the form, and the jury it will be read by. Below
    // that the panel falls under the form rather than beside it, which is the
    // right order — you fill the fields, then you meet the people.
    `<div class="pitchgrid${panel === '' ? ' alone' : ''}">`,
    '<div class="formcol">',
    '<section>',
    `<form method="post" action="/api/checkout" id="${FORM_ID}">`,

    '<label><span class="sh">Product URL</span>',
    `<span class="urlrow" id="${ROW_ID}">`,
    // `alt=""` and `hidden`: it is decoration until there is one, and a favicon
    // is never information a screen reader needs to hear.
    `<img class="icon" id="${ICON_ID}" alt="" width="16" height="16" hidden>`,
    // The placeholder is a bare domain on purpose. `https://` as a placeholder
    // read as a requirement, and the script that this page ships used to treat
    // it as one; both ends now accept either, and the hint says so.
    `<input type="url" name="url" id="${URL_ID}" required inputmode="url" autocomplete="url" placeholder="linear.app" value="${escapeHtml(view.values.url)}">`,
    '</span>',
    '<span class="hint">We reduce this to an identity — no protocol, no www., no tracking parameters. ' +
      'The same product under two spellings is the same product, so type it however you say it out loud: ' +
      '<b>linear.app</b> is enough. We read the page while you type.</span>',
    // `role="status"` + `aria-live="polite"`: the autofill announces itself to a
    // screen reader without stealing focus from the field being left.
    `<span class="look" id="${STATE_ID}" role="status" aria-live="polite" hidden></span></label>`,

    '<label><span class="sh">Name</span>',
    `<input type="text" name="name" id="${NAME_ID}" required maxlength="200" value="${escapeHtml(view.values.name)}"></label>`,

    '<label><span class="sh">What the site says</span>',
    `<textarea name="description" id="${DESC_ID}" required maxlength="${view.descriptionLimit}">${escapeHtml(view.values.description)}</textarea>`,
    `<span class="hint">Up to ${view.descriptionLimit} characters, pre-filled from your own page when we can read it. ` +
      'This is the text the panel reads, so correct it if your site undersells you. Everyone on the board gets the same room.</span></label>',

    '<label><span class="sh">Your pitch</span>',
    `<textarea name="pitch" maxlength="${PITCH_LIMIT}" placeholder="What does it actually do, and for whom?">${escapeHtml(view.values.pitch)}</textarea>`,
    `<span class="hint">Optional, up to ${PITCH_LIMIT} characters. Your words, not your website's — kept beside the line above, ` +
      'never merged into it. Be specific: "turns an OpenAPI spec into a typed Python client" beats a paragraph of adjectives.</span></label>',

    '<label><span class="sh">Category</span>',
    `<select name="category" required>${categoryOptions(view)}</select>`,
    '<span class="hint">Pick the one your buyers would search. Rank is computed inside a category, so a ' +
      'wrong one is not a shortcut — we check it before you pay and refuse rather than charge you.</span></label>',

    '<div class="sh" style="margin-top:18px">What you are buying</div>',
    `<div class="tiers">${tierChoices(view)}</div>`,

    '<button class="act" type="submit">Take my $5 →</button>',
    '</form>',
    '</section>',

    '<section><h2>The terms, in full</h2>',
    `<ul class="terms">${PURCHASE_TERMS.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    '</section>',
    '</div>',
    panel,
    '</div>',

    '<footer>Verdicts are public and permanent. Your balance and your history are not. ' +
      '<a href="/boards">Read the cuts</a>.</footer>',
  ].join('');

  return document_('Throw it in', body, panel !== '');
}

export interface RejectionView {
  readonly rejection: SubmissionRejection;
  /** Non-null only for `cycle_locked`. `brief §2.4`'s countdown. */
  readonly nextRebuild: { readonly at: Date; readonly humanized: string } | null;
  readonly form: SubmitPageView;
}

/** `2026-08-30T02:00:00Z` -> `02:00 UTC on 30 Aug`. */
function stamp(at: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC on ${at.getUTCDate()} ${months[at.getUTCMonth()] ?? '???'}`;
}

/** The heading. Says what happened; the body says what to do about it. */
function headingFor(rejection: SubmissionRejection): string {
  switch (rejection.code) {
    case 'cycle_locked':
      return 'Already in tonight’s board';
    case 'description_unchanged':
      return 'That is the same pitch';
    case 'category_mismatch':
      return 'Wrong room';
    case 'ownership_conflict':
      return 'Held for review';
    default:
      return 'Not yet';
  }
}

export function renderRejectionPage(view: RejectionView): string {
  const { rejection } = view;

  const body = [
    '<header class="page">',
    '<div class="sh">Not charged</div>',
    `<h1>${escapeHtml(headingFor(rejection))}</h1>`,
    '</header>',

    '<section><div class="blk warn">',
    `<p><b>${escapeHtml(rejection.message)}</b></p>`,
    // The countdown, as a wall clock AND a duration: one to plan around, one to
    // feel. `brief §2.4` asks for a time, not a limit.
    view.nextRebuild === null
      ? ''
      : `<span class="when">Next pitch: ${escapeHtml(stamp(view.nextRebuild.at))} — in ${escapeHtml(view.nextRebuild.humanized)}.</span>`,
    rejection.code === 'category_mismatch'
      ? `<p>We would have filed it under <b>${escapeHtml(rejection.suggested)}</b>. You pick — we only refuse the obvious misses.</p>`
      : '',
    '<p>Nothing was charged. No card was touched and no attempt was spent.</p>',
    '</div></section>',

    '<section><h2>Edit and try again</h2>',
    renderFormOnly(view.form),
    '</section>',

    '<footer><a href="/boards">Read the cuts</a> while you wait.</footer>',
  ].join('');

  return document_(headingFor(rejection), body);
}

/**
 * The same form, without the sales copy above it. Used on the refusal page.
 *
 * It carries the same element ids as the full form, so `AUTOFILL_SCRIPT` binds
 * to it too. That matters more here than on the first render: a visitor who has
 * just been refused is editing, and every field already holds their text — which
 * is exactly the case where the "empty fields only" rule earns its keep.
 */
function renderFormOnly(view: SubmitPageView): string {
  return [
    `<form method="post" action="/api/checkout" id="${FORM_ID}">`,
    '<label><span class="sh">Product URL</span>',
    `<span class="urlrow" id="${ROW_ID}">`,
    `<img class="icon" id="${ICON_ID}" alt="" width="16" height="16" hidden>`,
    `<input type="url" name="url" id="${URL_ID}" required inputmode="url" autocomplete="url" placeholder="linear.app" value="${escapeHtml(view.values.url)}">`,
    '</span>',
    `<span class="look" id="${STATE_ID}" role="status" aria-live="polite" hidden></span></label>`,
    '<label><span class="sh">Name</span>',
    `<input type="text" name="name" id="${NAME_ID}" required maxlength="200" value="${escapeHtml(view.values.name)}"></label>`,
    '<label><span class="sh">What the site says</span>',
    `<textarea name="description" id="${DESC_ID}" required maxlength="${view.descriptionLimit}">${escapeHtml(view.values.description)}</textarea></label>`,
    '<label><span class="sh">Your pitch</span>',
    `<textarea name="pitch" maxlength="${PITCH_LIMIT}">${escapeHtml(view.values.pitch)}</textarea></label>`,
    '<label><span class="sh">Category</span>',
    `<select name="category" required>${categoryOptions(view)}</select></label>`,
    `<div class="tiers">${tierChoices(view)}</div>`,
    '<button class="act" type="submit">Try again →</button>',
    '</form>',
  ].join('');
}
