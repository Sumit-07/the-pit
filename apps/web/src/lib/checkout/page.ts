/**
 * The two surfaces of the buying path: the form, and the refusal.
 *
 * ## Guest checkout, rendered literally
 *
 * `brief §2.1`: "No login at submission." So this page is a `<form method="post">`
 * with four fields and a price, and there is nothing else on the path between a
 * visitor and their purchase — no account step, no email confirmation, no
 * JavaScript. It works on a phone with a dead battery and a hostile network,
 * because the only thing it needs the browser to do is submit a form.
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

/** `the-pit-home.html`'s eight custom properties and its type stack, verbatim. */
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
.wrap{max-width:660px;margin:0 auto;padding:0 14px 56px}
nav{display:flex;justify-content:space-between;align-items:center;padding:13px 0;
  border-bottom:1px solid var(--rule)}
.mark{font-family:var(--disp);font-size:14px;letter-spacing:-.02em;color:var(--bone);text-decoration:none}
.mark i{color:var(--blade);font-style:normal}
.navr{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.06em;display:flex;gap:14px}
.navr a{color:var(--muted);text-decoration:none}
.navr a:hover{color:var(--bone)}
.sh{font-family:var(--mono);font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
header{padding:26px 0 4px}
header h1{font-family:var(--disp);font-size:clamp(20px,5.2vw,28px);line-height:1.05;
  letter-spacing:-.03em;text-transform:uppercase;margin-top:6px}
.lede{font-size:12.5px;line-height:1.6;color:#B3A79C;margin-top:9px;max-width:64ch}
.lede b{color:var(--bone);font-weight:600}
section{margin-top:26px}
h2{font-family:var(--disp);font-size:15px;letter-spacing:-.02em;text-transform:uppercase}
label{display:block;margin-top:14px}
label .sh{display:block;margin-bottom:5px}
input[type=text],input[type=url],textarea,select{width:100%;background:var(--panel);
  border:1px solid var(--rule);color:var(--bone);font-family:var(--body);font-size:13.5px;
  padding:9px 10px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--muted)}
textarea{min-height:96px;resize:vertical;line-height:1.55}
.hint{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px}
.tiers{display:flex;gap:9px;flex-wrap:wrap;margin-top:8px}
.tier{flex:1;min-width:200px;border:1px solid var(--rule);background:var(--ground2);padding:12px}
.tier b{display:block;font-size:13.5px;font-weight:600}
.tier span{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:4px}
.tier input{margin-right:7px}
button.act{display:inline-block;font-family:var(--mono);font-size:11px;letter-spacing:.05em;
  border:1px solid var(--blade);background:var(--blade);color:#150C0A;font-weight:600;
  padding:10px 15px;margin-top:18px;cursor:pointer}
a.act{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;
  text-decoration:none;color:var(--bone);border:1px solid var(--rule);padding:7px 11px;margin-top:14px}
a.act:hover{border-color:var(--muted)}
.blk{background:var(--ground2);border:1px solid var(--rule);padding:14px 15px;margin-top:14px}
.blk p{font-size:12.5px;line-height:1.6;color:#B3A79C}
.blk p+p{margin-top:8px}
.blk p b{color:var(--bone);font-weight:600}
.warn{border-left:2px solid var(--coin)}
.warn h2{color:var(--coin)}
.when{font-family:var(--mono);font-size:11.5px;color:var(--coin);border:1px solid rgba(217,164,65,.42);
  padding:8px 10px;margin-top:11px;display:block}
.linked{font-family:var(--mono);font-size:11px;color:var(--roar);
  border:1px solid rgba(91,158,166,.34);padding:2px 6px;display:inline-block}
.terms{margin-top:11px;font-size:12px;line-height:1.6;color:#B3A79C;padding-left:1.1rem}
.terms li{margin-top:4px}
footer{margin-top:34px;border-top:1px solid var(--rule);padding-top:16px;
  font-family:var(--mono);font-size:10.5px;line-height:1.75;color:var(--muted)}
footer a{color:var(--muted)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function document_(title: string, body: string): string {
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
    '<body><div class="wrap">',
    '<nav><a class="mark" href="/">THE P<i>I</i>T</a>',
    '<span class="navr"><a href="/boards">Boards</a><a href="/account">Account</a></span></nav>',
    body,
    '</div></body>',
    '</html>',
  ].join('');
}

/** What the visitor typed, echoed back so a rejection is an edit and not a retype. */
export interface SubmitFormValues {
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly categorySlug: string;
  readonly tier: string;
}

export const EMPTY_FORM: SubmitFormValues = {
  url: '',
  name: '',
  description: '',
  categorySlug: '',
  tier: 'single',
};

export interface SubmitPageView {
  readonly categories: readonly string[];
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
  const body = [
    '<header>',
    '<div class="sh">Throw it in</div>',
    '<h1>Five dollars. One honest verdict.</h1>',
    '<p class="lede">Paste the URL, name it, say what it does. Pay. That is the whole form — ' +
      '<b>no account, no login, no waiting on an email</b>. The panel does not know who paid and could not ' +
      'rank you higher if it did.</p>',
    view.signedIn
      ? '<p class="lede"><span class="linked">Signed in</span> This pitch will be attached to your account, ' +
        'and if the product is already listed under someone else we will tell you now rather than after you pay.</p>'
      : '',
    '</header>',

    '<section>',
    '<form method="post" action="/api/checkout">',

    '<label><span class="sh">Product URL</span>',
    `<input type="url" name="url" required inputmode="url" autocomplete="url" placeholder="https://" value="${escapeHtml(view.values.url)}">`,
    '<span class="hint">We reduce this to an identity — no protocol, no www., no tracking parameters. ' +
      'The same product under two spellings is the same product.</span></label>',

    '<label><span class="sh">Name</span>',
    `<input type="text" name="name" required maxlength="200" value="${escapeHtml(view.values.name)}"></label>`,

    '<label><span class="sh">What it does</span>',
    `<textarea name="description" required maxlength="${view.descriptionLimit}">${escapeHtml(view.values.description)}</textarea>`,
    `<span class="hint">Up to ${view.descriptionLimit} characters. Everyone on the board gets the same room.</span></label>`,

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

    '<footer>Verdicts are public and permanent. Your balance and your history are not. ' +
      '<a href="/boards">Read the cuts</a>.</footer>',
  ].join('');

  return document_('Throw it in', body);
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
    '<header>',
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

/** The same form, without the sales copy above it. Used on the refusal page. */
function renderFormOnly(view: SubmitPageView): string {
  return [
    '<form method="post" action="/api/checkout">',
    '<label><span class="sh">Product URL</span>',
    `<input type="url" name="url" required value="${escapeHtml(view.values.url)}"></label>`,
    '<label><span class="sh">Name</span>',
    `<input type="text" name="name" required maxlength="200" value="${escapeHtml(view.values.name)}"></label>`,
    '<label><span class="sh">What it does</span>',
    `<textarea name="description" required maxlength="${view.descriptionLimit}">${escapeHtml(view.values.description)}</textarea></label>`,
    '<label><span class="sh">Category</span>',
    `<select name="category" required>${categoryOptions(view)}</select></label>`,
    `<div class="tiers">${tierChoices(view)}</div>`,
    '<button class="act" type="submit">Try again →</button>',
    '</form>',
  ].join('');
}
