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

import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

/** One sans, one mono, from `lib/theme.ts` — the same two every surface loads. */
const FONTS = FONT_LINKS;

const CSS = `${TOKENS}${BASE}
.wrap{max-width:720px}

header.page h1{margin-top:9px}

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
