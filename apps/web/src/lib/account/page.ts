/**
 * The account page, as one self-contained HTML document.
 *
 * ## Why a string and not a component
 *
 * The same three reasons `lib/verdict/page.ts` and `lib/auth/pages.ts` are
 * strings, and one more that is specific to this page.
 *
 * The shared reasons: it is served by a route handler, its CSS is inline so
 * nothing it renders depends on a second request, and it runs no script. The
 * specific one is the rotate control. Rotation must be a POST — a GET that
 * replaced a credential is triggerable by any `<img>` on any page the customer
 * visits — and a plain `<form method="post">` is a POST that works with
 * JavaScript disabled, on a page whose whole job is to be reachable when
 * something else has gone wrong.
 *
 * ## Where the design comes from
 *
 * `the-pit-home.html`'s eight custom properties, verbatim, and its type stack:
 * Archivo Black for the few display lines, Barlow for prose, IBM Plex Mono for
 * every label and every number. That is the same restatement
 * `packages/engine/src/board/page.ts` and `lib/verdict/page.ts` already made, so
 * the board, the verdict and the account read as one product.
 *
 * The REGISTER is the plain one. `brief` Part 5: "aggressive on the homepage,
 * plain everywhere behind it." Nothing here shouts, nothing here sells, and the
 * one word that carries over from the loud surface is **cuts** — the connective
 * word, used where it is literally what the customer is being offered: the
 * ledger of cuts their pitch took.
 *
 * ## Escaping
 *
 * Product names, URLs and email addresses are user-submitted. `escapeHtml` is
 * `@the-pit/auth`'s — the same function the magic-link email, the auth pages and
 * the verdict page use, so there is one answer in this app to what escaping means
 * — and every interpolation of stored text goes through it. `linkHref` is the
 * second half: a `javascript:` URL in a product's `url` column would be a stored
 * XSS on the one page that is guaranteed to be viewed with a live session.
 *
 * ## What this page must never do
 *
 * Gate a verdict. `brief §2.1` puts verdict URLs on the public side of the line
 * and the balance and history on the private side, and this page links OUT to
 * `/v/<slug>` without decorating those links with anything — no token, no
 * signature, no `?from=account`. A customer who copies a link out of this page
 * must be handing their reader the same URL a stranger would get.
 */

import { escapeHtml } from '@the-pit/auth';
import { formatUsd, PURCHASE_TERMS } from '@the-pit/payments';

import type { AccountListing, AccountPurchase, AccountView } from '@/lib/account/view';

/** The palette and the type stack, `the-pit-home.html` verbatim. */
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
.navr{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.06em;
  display:flex;gap:14px;align-items:center}
.navr a{color:var(--muted);text-decoration:none}
.navr a:hover{color:var(--bone)}

.sh{font-family:var(--mono);font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}

header{padding:26px 0 4px}
header h1{font-family:var(--disp);font-size:clamp(20px,5.2vw,28px);line-height:1.05;
  letter-spacing:-.03em;text-transform:uppercase;margin-top:6px}
header .who{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:8px;word-break:break-all}

section{margin-top:30px}
h2{font-family:var(--disp);font-size:15px;letter-spacing:-.02em;text-transform:uppercase}
.lede{font-size:12.5px;line-height:1.6;color:#B3A79C;margin-top:7px;max-width:64ch}
.lede b{color:var(--bone);font-weight:600}

/* ---------- attempts ---------- */
.bal{display:flex;align-items:baseline;gap:13px;flex-wrap:wrap;margin-top:14px;
  border:1px solid var(--rule);background:var(--ground2);padding:16px}
.bal .big{font-family:var(--disp);font-size:46px;line-height:.82;letter-spacing:-.05em;color:var(--blade)}
.bal .of{font-size:12.5px;line-height:1.45;color:var(--muted);max-width:38ch}
.bal .of b{display:block;color:var(--bone);font-size:13px;font-weight:600}
.terms{margin-top:12px;font-size:12px;line-height:1.6;color:#B3A79C;padding-left:1.1rem}
.terms li{margin-top:5px}

/* ---------- rows ---------- */
.rows{margin-top:14px;border-top:1px solid var(--rule2)}
.row{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;
  padding:11px 0;border-bottom:1px solid var(--rule2)}
.row .nm{flex:1;min-width:200px}
.row .nm b{display:block;font-size:13.5px;font-weight:600}
.row .nm span{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);
  margin-top:3px;word-break:break-all}
.row .meta{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.row .amt{font-family:var(--mono);font-size:12px;font-weight:600;white-space:nowrap;min-width:64px;text-align:right}
.pitch{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--coin);border:1px solid rgba(217,164,65,.42);padding:1px 5px}
.pending{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--muted);border:1px solid var(--rule);padding:1px 5px}
.empty{font-family:var(--mono);font-size:11.5px;line-height:1.7;color:var(--muted);
  border:1px solid var(--rule);background:var(--ground2);padding:14px;margin-top:14px}

/* ---------- links and buttons ---------- */
a.act,button.act{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;
  text-decoration:none;color:var(--bone);border:1px solid var(--rule);padding:7px 11px;
  background:transparent;cursor:pointer}
a.act:hover,button.act:hover{border-color:var(--muted)}
a.act.prime,button.act.prime{background:var(--blade);border-color:var(--blade);color:#150C0A;font-weight:600}
.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px;align-items:center}

/* ---------- panels ---------- */
.blk{background:var(--ground2);border:1px solid var(--rule);padding:14px 15px;margin-top:14px}
.blk p{font-size:12.5px;line-height:1.6;color:#B3A79C}
.blk p+p{margin-top:8px}
.blk p b{color:var(--bone);font-weight:600}
.key{font-family:var(--mono);font-size:11px;color:var(--bone);word-break:break-all;
  background:var(--panel);border:1px solid var(--rule);padding:9px 10px;margin-top:10px;display:block}
.warn{border-left:2px solid var(--coin)}
.warn p b{color:var(--coin)}
.perks{margin-top:10px;padding-left:1.1rem;font-size:12.5px;line-height:1.6;color:#B3A79C}
.perks li{margin-top:6px}
.perks b{color:var(--bone);font-weight:600}
.linked{font-family:var(--mono);font-size:11px;color:var(--roar);
  border:1px solid rgba(91,158,166,.34);padding:2px 6px;display:inline-block}

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
    // This page displays a bearer URL in its body. `no-referrer` in a meta tag as
    // well as in the response header, for the same reason `lib/auth/pages.ts`
    // does it: anything the page loads would otherwise receive this page's URL,
    // and a font host is still a third party.
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(title)} — The Pit</title>`,
    FONTS,
    `<style>${CSS}</style>`,
    '</head>',
    '<body><div class="wrap">',
    '<nav><a class="mark" href="/">THE P<i>I</i>T</a>',
    '<span class="navr"><a href="/boards">Boards</a></span></nav>',
    body,
    '</div></body>',
    '</html>',
  ].join('');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `27 Aug 2026` — UTC, never local.
 *
 * The same choice `lib/verdict/page.ts` made and for a related reason: a purchase
 * date a customer quotes to support has to be the date support sees.
 */
function stampDate(value: Date): string {
  if (Number.isNaN(value.getTime())) return '—';
  return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()] ?? '???'} ${value.getUTCFullYear()}`;
}

/** Only `http(s)` becomes an href. Anything else is printed as text. */
function linkHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
}

/** `1` -> `1 attempt`, `3` -> `3 attempts`. */
function attempts(count: number): string {
  return `${count} ${count === 1 ? 'attempt' : 'attempts'}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The balance.
 *
 * `PURCHASE_TERMS` is imported rather than restated. `brief §2.3` requires those
 * lines on the purchase page and `packages/payments` keeps them next to the code
 * that enforces them precisely so they cannot drift; the account page is where a
 * customer goes when they are counting, so it is the second place the same
 * sentences have to be true.
 */
function balanceSection(view: AccountView): string {
  // Deliberately not a restatement of the terms below it. The number says how
  // many; this says what one IS, and the list says how one behaves.
  const line =
    view.balance === 0
      ? 'Nothing left to throw.'
      : 'One attempt puts one pitch in front of the panel.';

  return [
    '<section>',
    '<span class="sh">Attempts</span>',
    '<h2>What you have left</h2>',
    '<div class="bal">',
    `<span class="big">${view.balance}</span>`,
    `<span class="of"><b>${escapeHtml(attempts(view.balance))} remaining</b>${escapeHtml(line)}</span>`,
    '</div>',
    '<p class="lede" style="margin-top:16px"><span class="sh">How an attempt behaves</span></p>',
    `<ul class="terms">${PURCHASE_TERMS.map((term) => `<li>${escapeHtml(term)}</li>`).join('')}</ul>`,
    '</section>',
  ].join('');
}

/**
 * One listing row.
 *
 * The verdict link is a bare `/v/<slug>` — see the module header. The label uses
 * `brief` Part 5's connective word, because that is literally what is behind the
 * link: the ledger of cuts the pitch took.
 */
function listingRow(listing: AccountListing): string {
  // The product's own URL, linked only when it is `http(s)`. A `javascript:` in
  // that column would be a stored XSS on the one page guaranteed to be viewed
  // with a live session, and `rel` keeps the outbound hop from carrying anything.
  const href = linkHref(listing.url);
  const site =
    href === null
      ? `<span>${escapeHtml(listing.url)}</span>`
      : `<span><a href="${href}" rel="noreferrer nofollow noopener" target="_blank" style="color:inherit">${escapeHtml(listing.url)}</a></span>`;

  const pitch =
    listing.attemptNumber === null
      ? '<span class="pending">In the pit</span>'
      : `<span class="pitch">${listing.attemptNumber === 1 ? '1st' : listing.attemptNumber === 2 ? '2nd' : listing.attemptNumber === 3 ? '3rd' : `${listing.attemptNumber}th`} pitch</span>`;

  const verdict =
    listing.verdictSlug === null
      ? '<span class="meta">no verdict yet</span>'
      : `<a class="act" href="/v/${escapeHtml(listing.verdictSlug)}">Read the cuts</a>`;

  return [
    '<div class="row">',
    `<span class="nm"><b>${escapeHtml(listing.name)}</b>${site}</span>`,
    `<span class="meta">${escapeHtml(listing.categorySlug)}</span>`,
    pitch,
    verdict,
    '</div>',
  ].join('');
}

function listingsSection(view: AccountView): string {
  const body =
    view.listings.length === 0
      ? '<p class="empty">Nothing in the pit yet. A listing appears here the moment a payment settles.</p>'
      : `<div class="rows">${view.listings.map(listingRow).join('')}</div>`;

  return [
    '<section>',
    '<span class="sh">Listings</span>',
    '<h2>What you have thrown in</h2>',
    '<p class="lede">Every verdict below has a <b>public permanent URL</b>. It works logged out and it is ' +
      'yours to share — nobody needs an account here to read what the panel cut you for.</p>',
    body,
    '</section>',
  ].join('');
}

function purchaseRow(purchase: AccountPurchase): string {
  const extra = purchase.includesFitReport ? ' + fit report' : '';
  return [
    '<div class="row">',
    `<span class="nm"><b>${escapeHtml(attempts(purchase.attemptsGranted))}${escapeHtml(extra)}</b>` +
      `<span>${escapeHtml(stampDate(purchase.createdAt))}</span></span>`,
    `<span class="amt">${escapeHtml(formatUsd(purchase.amountCents))}</span>`,
    '</div>',
  ].join('');
}

function purchasesSection(view: AccountView): string {
  const body =
    view.purchases.length === 0
      ? '<p class="empty">No purchases on this account yet.</p>'
      : `<div class="rows">${view.purchases.map(purchaseRow).join('')}</div>`;

  return [
    '<section>',
    '<span class="sh">History</span>',
    '<h2>What you paid</h2>',
    body,
    '</section>',
  ].join('');
}

/**
 * The capability URL, and the rotate control.
 *
 * Rotation is the ONLY revocation a bearer URL has — `capability/slug.ts` and
 * `schema/accounts.ts` both say so — which is why the control is on the page
 * rather than behind a support request. And because it is the only one, the page
 * has to be exact about its limit rather than reassuring: the session cookie is
 * signed, stateless and good for 90 days (`session/cookie.ts`), so it cannot be
 * revoked one at a time, and rotating the URL stops the next entry through it
 * without ending a session somebody already opened.
 *
 * Saying that plainly is not a disclaimer. A customer who believes rotation logs
 * everyone out will rotate and stop worrying; one who is told the truth will also
 * change what the leaked link could reach.
 */
function capabilitySection(view: AccountView): string {
  const url =
    view.capabilityUrl === null
      ? '<p class="empty">This account has no link right now. Ask for a sign-in link by email instead.</p>'
      : `<code class="key">${escapeHtml(view.capabilityUrl)}</code>`;

  return [
    '<section>',
    '<span class="sh">Your account link</span>',
    '<h2>The link that is your key</h2>',
    '<div class="blk">',
    '<p>This URL signs you in on its own — no password, no email, no expiry. Bookmark it, and treat it ' +
      'like a key: <b>anyone who has it can reach this page</b>.</p>',
    url,
    '</div>',
    '<div class="blk warn">',
    '<p><b>Replacing it is the only way to revoke it.</b> There is one link per account, so writing a new ' +
      'one deletes the old one in the same instant. Bookmarks pointing at the old link stop working.</p>',
    '<p>What replacing it does <b>not</b> do: it does not sign anybody out. Sessions here are a signed ' +
      'cookie that is good for 90 days and is checked without asking the database, so a session someone ' +
      'already opened through the old link stays open until it expires. Replacing the link stops the next ' +
      'entry through it, not the one already inside.</p>',
    '<form method="post" action="/auth/capability/rotate" class="actions">',
    '<button class="act prime" type="submit">Replace my account link</button>',
    '</form>',
    '</div>',
    '</section>',
  ].join('');
}

/**
 * GitHub: connected, or what connecting is for.
 *
 * Every perk below is procedural or informational. None of them touches rank, and
 * that is a rule rather than a coincidence — see `DECISIONS.md` S15. A login that
 * bought a rank advantage would be the same violation as a payment that bought
 * one, in a different currency, on the product whose entire promise is "$5 to
 * enter. That's all money does here."
 */
function githubSection(view: AccountView): string {
  if (view.github.linked) {
    const links = view.github.identities
      .map((identity) => `<span class="linked">${escapeHtml(identity.provider)} · ${escapeHtml(identity.linkedEmail)}</span>`)
      .join(' ');

    return [
      '<section>',
      '<span class="sh">GitHub</span>',
      '<h2>Connected</h2>',
      '<div class="blk">',
      `<p>${links}</p>`,
      '<p>You can sign in with GitHub from any device now, and it will land on this account — the link is ' +
        'keyed to your GitHub account id, so changing your GitHub email later does not break it.</p>',
      '</div>',
      '</section>',
    ].join('');
  }

  return [
    '<section>',
    '<span class="sh">GitHub</span>',
    '<h2>Not connected</h2>',
    '<div class="blk">',
    '<p>Connecting GitHub is optional and you can do it at any time — including now, having already paid ' +
      'as a guest on a phone. It attaches to <b>this</b> account rather than opening a second one.</p>',
    '<ul class="perks">',
    '<li><b>Ownership, proven.</b> A listing whose repository is on your GitHub skips the review hold ' +
      'we place on a submission that looks like it might be someone else’s product.</li>',
    '<li><b>Claiming a seeded listing.</b> If your product is already on a board as unclaimed, this is ' +
      'how you take it over instead of filing a support request.</li>',
    '<li><b>The verified-builder marker.</b> Your listing says the person who pitched it is the person ' +
      'who ships it.</li>',
    '<li><b>Re-pitching without a round trip.</b> One button instead of finding an email.</li>',
    '</ul>',
    '<p>None of it moves you up. <b>Rank is not for sale and it is not for logging in either</b> — ' +
      'connecting an account changes what we can verify about you and never what the panel cut you for.</p>',
    '<div class="actions"><a class="act prime" href="/auth/github/start">Connect GitHub</a></div>',
    '</div>',
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The account page, for a verified session. */
export function renderAccountPage(view: AccountView): string {
  return document_(
    'Your account',
    [
      '<header>',
      '<span class="sh">Account</span>',
      '<h1>Everyone walks in at 100</h1>',
      `<p class="who">${escapeHtml(view.email)}</p>`,
      '</header>',
      balanceSection(view),
      listingsSection(view),
      purchasesSection(view),
      capabilitySection(view),
      githubSection(view),
      '<footer>',
      'Verdict pages are public and permanent. This page is not — your balance and your history sit ' +
        'behind the session, and nothing here is shared when you share a verdict.<br>',
      '<a href="/boards">Boards</a> · <a href="/">The Pit</a>',
      '</footer>',
    ].join(''),
  );
}

/**
 * What `/account` serves with no valid session.
 *
 * It renders no balance, no history, no listing and no link, because it is handed
 * none of them: `handleAccountPage` returns this BEFORE it reads a store, so
 * there is no version of this page that has the data and declines to print it.
 *
 * It offers all three doors rather than only the email one — the capability URL
 * exists precisely because email delivery is the thing most likely to be broken
 * when someone is standing here unable to get in.
 */
export function renderSignedOutPage(): string {
  return document_(
    'Sign in',
    [
      '<header>',
      '<span class="sh">Account</span>',
      '<h1>You are not signed in</h1>',
      '</header>',
      '<div class="blk">',
      '<p>Your balance and your history sit behind a session. Your verdicts do not — those pages are ' +
        'public and permanent, and they work with no account at all.</p>',
      '<p>Three ways back in: the account link from your receipt, a fresh sign-in link by email, or ' +
        'GitHub if you have connected it.</p>',
      '<div class="actions">',
      '<a class="act prime" href="/auth/sign-in">Email me a sign-in link</a>',
      '<a class="act" href="/auth/github/start">Sign in with GitHub</a>',
      '</div>',
      '</div>',
      '<footer><a href="/boards">Boards</a> · <a href="/">The Pit</a></footer>',
    ].join(''),
  );
}
