/**
 * The HTML the auth routes serve.
 *
 * Plain strings rather than React components, because these three pages are
 * rendered by route handlers rather than by the App Router — and they are route
 * handlers for a reason. `brief §2.1`:
 *
 * > `GET /auth/verify` renders a **button**; a `POST` does the actual
 * > verification.
 *
 * A `page.tsx` and a `route.ts` cannot share a path in the App Router, so the
 * GET page and the POST that redeems the token would have to live at two
 * different URLs — which means the URL in the email is not the URL the token is
 * posted to, and one more thing has to stay in sync for the flow to work. One
 * `route.ts` exporting both verbs keeps the pair together and keeps the GET
 * handler visibly incapable of touching a database.
 *
 * ## Escaping
 *
 * `escapeHtml` comes from `@the-pit/auth` — the same function the email body
 * uses, so there is one answer to "what does escaping mean here". The token is
 * base64url and needs none of it today; it is escaped anyway, because the value
 * arrives from a query string and query strings are attacker-controlled by
 * definition. An unescaped interpolation of `?token=` into a `value=` attribute
 * is a reflected XSS on the one page in the product that is about to set a
 * 90-day session cookie.
 */

import { escapeHtml } from '@the-pit/auth';

/** `brief` Part 5 fixes the voice. Everyone walks in at 100; fewest cuts wins. */
const STYLE = [
  'margin:0;min-height:100vh;display:grid;place-items:center;',
  'background:#0b0b0c;color:#e8e8ea;',
  'font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif',
].join('');

const CARD = 'max-width:32rem;padding:2rem;text-align:left';
const BUTTON = [
  'display:inline-block;padding:.75rem 1.25rem;border:0;border-radius:4px;',
  'background:#e8e8ea;color:#0b0b0c;font:inherit;font-weight:600;cursor:pointer',
].join('');
const FIELD = [
  'display:block;width:100%;padding:.75rem;margin:0 0 1rem;border-radius:4px;',
  'border:1px solid #3a3a3e;background:#141416;color:inherit;font:inherit',
].join('');

function document_(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // The token is in this page's URL. `noindex` keeps it out of search results
    // and out of any crawler's log; `Referrer-Policy: no-referrer` (set as a
    // header by the route) keeps it out of the Referer of anything the page
    // loads.
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(title)} — The Pit</title>`,
    '</head>',
    `<body style="${STYLE}"><main style="${CARD}">${body}</main></body>`,
    '</html>',
  ].join('');
}

/** The sign-in form. Posts an address to `/auth/request`. */
export function signInPage(): string {
  return document_(
    'Sign in',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Sign in to The Pit</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">We will send a link to the address on your receipt. ',
      'There is no password — there never was one.</p>',
      '<form method="post" action="/auth/request">',
      `<label for="email" style="display:block;margin:0 0 .5rem">Email</label>`,
      `<input id="email" name="email" type="email" autocomplete="email" required style="${FIELD}">`,
      `<button type="submit" style="${BUTTON}">Send me a link</button>`,
      '</form>',
    ].join(''),
  );
}

/**
 * The one sentence, `brief §2.1`. Rendered identically whether or not the
 * address has an account — `message` is `CHECK_YOUR_INBOX` in both cases and the
 * caller never passes anything address-specific.
 */
export function requestResultPage(message: string): string {
  return document_(
    'Check your inbox',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Check your inbox</h1>',
      `<p style="margin:0 0 1.5rem">${escapeHtml(message)}</p>`,
      '<p style="margin:0;opacity:.75">The link works once and stops working after 15 minutes.</p>',
    ].join(''),
  );
}

/**
 * The page `GET /auth/verify` serves: a button and nothing else.
 *
 * This is the Outlook Safe Links defence, and it only works because rendering it
 * consumes nothing. Every scanner, antivirus proxy, link preview and offline
 * prefetcher that follows the URL in the email lands here, gets HTML, and goes
 * away — the token is still unspent when the human arrives and presses the
 * button, which is a POST.
 */
export function verifyButtonPage(token: string): string {
  return document_(
    'Confirm sign-in',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">One more press</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Mail scanners open every link in a message. ',
      'This one does nothing until you press the button, so yours is still waiting for you.</p>',
      '<form method="post" action="/auth/verify">',
      `<input type="hidden" name="token" value="${escapeHtml(token)}">`,
      `<button type="submit" style="${BUTTON}">Sign me in</button>`,
      '</form>',
    ].join(''),
  );
}

/**
 * One page for every rejection.
 *
 * Expired, already used, never existed, and "no account for that address" all
 * render this. `verifyMagicLink` distinguishes them for the log; telling the
 * person holding the token which one it was is free reconnaissance for someone
 * who did not come by that token honestly.
 */
export function verifyRejectedPage(): string {
  return document_(
    'That link has expired',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">That link no longer works</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Sign-in links last 15 minutes and work once. ',
      'Ask for a fresh one and it will be in your inbox in a moment.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Send me a new link</a></p>`,
    ].join(''),
  );
}

/** The verify-side rate limit. Depends on the caller, not on any account. */
export function verifyRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Too many attempts</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Give it a few minutes and try your link again.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Send me a new link</a></p>`,
    ].join(''),
  );
}

// ---------------------------------------------------------------------------
// The capability path.
// ---------------------------------------------------------------------------

/**
 * The success page, immediately after payment. The most important screen in the
 * capability design, because it is the only place the URL is handed over while
 * the customer is certain to be looking.
 *
 * The copy has one job — get them to bookmark it — and it says what the thing is
 * rather than what it is called. "Your account link", not "your capability URL".
 *
 * Note what it does NOT say: nothing about a balance. `brief §2.2` grants
 * attempts on the signed webhook, which may not have landed yet, and
 * `resolveSuccessRedirect` in `@the-pit/payments` is explicit that the redirect
 * must never imply it knows the balance.
 */
export function capabilityHandoffPage(input: { url: string; email: string }): string {
  const safeUrl = escapeHtml(input.url);
  return document_(
    'Payment received',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Payment received</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Your run starts the moment the payment settles.</p>',
      '<h2 style="font-size:1.1rem;margin:0 0 .5rem">Bookmark this — it is your account</h2>',
      '<p style="margin:0 0 1rem;opacity:.75">No password, no expiry. It is how you reach your ',
      'remaining attempts, your history, and a re-pitch.</p>',
      `<p style="margin:0 0 1.5rem;word-break:break-all"><a href="${safeUrl}" style="color:#e8e8ea">${safeUrl}</a></p>`,
      `<p style="margin:0 0 1.5rem;font-size:.9rem;opacity:.6">We have also emailed it to ${escapeHtml(input.email)} as a backup. `,
      'Treat the link like a key: anyone who has it can reach your account, and you can replace it from your account page at any time.</p>',
      '<p style="margin:0;font-size:.9rem;opacity:.6">Your verdict page will be public and shareable on its own. ',
      'You do not need this link to show anyone your results.</p>',
    ].join(''),
  );
}

/**
 * The success page when the handover window has closed, or the payment id does
 * not resolve.
 *
 * One page for both, because distinguishing them would confirm to someone
 * holding a guessed payment id that it was real. It is deliberately not an
 * error: the customer's account exists and their run is running, and the page
 * says so before it offers the two other ways in.
 */
export function capabilityUnavailablePage(): string {
  return document_(
    'Payment received',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Payment received</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Your run starts the moment the payment settles.</p>',
      '<p style="margin:0 0 1.5rem">We cannot show your account link on this page any more — it is only ',
      'shown for a short while after payment, so that a link left in a browser history does not become a way in.</p>',
      '<p style="margin:0 0 1rem;opacity:.75">It was emailed to the address on your receipt. If that has not arrived, ',
      'ask for a sign-in link instead.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Email me a sign-in link</a></p>`,
    ].join(''),
  );
}

/**
 * What `/a/<slug>` renders when the slug does not resolve.
 *
 * One page for "malformed" and "no such account" alike — see
 * `capability/access.ts`. It offers the other two doors rather than dead-ending,
 * because the person reading it is most likely a customer whose bookmark is from
 * before a rotation.
 */
export function capabilityRejectedPage(): string {
  return document_(
    'That link no longer works',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">That link no longer works</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Account links stop working when they are replaced. ',
      'If you replaced yours, use the new one; otherwise sign in with the address on your receipt.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Email me a sign-in link</a></p>`,
    ].join(''),
  );
}

/** The capability-side rate limit. Depends on the caller, not on any account. */
export function capabilityRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Too many attempts</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Give it a few minutes and try your link again.</p>',
    ].join(''),
  );
}

/** After a rotation: the new URL, and what just happened to the old one. */
export function capabilityRotatedPage(url: string): string {
  const safeUrl = escapeHtml(url);
  return document_(
    'New account link',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Here is your new account link</h1>',
      '<p style="margin:0 0 1rem;opacity:.75">The old one stopped working the moment this page loaded. ',
      'Replace your bookmark.</p>',
      `<p style="margin:0 0 1.5rem;word-break:break-all"><a href="${safeUrl}" style="color:#e8e8ea">${safeUrl}</a></p>`,
      '<p style="margin:0;font-size:.9rem;opacity:.6">Anyone still signed in on another device stays signed in until ',
      'their session expires. Replacing the link stops new sign-ins through the old one.</p>',
    ].join(''),
  );
}

// ---------------------------------------------------------------------------
// The GitHub path.
// ---------------------------------------------------------------------------

/**
 * A verified GitHub identity that has never bought anything.
 *
 * This page is the reason the flow does not create an account, so it has to
 * carry the explanation rather than just refusing. It names the addresses that
 * were checked — which is the difference between a customer who understands
 * what happened and one who files a ticket — and it names the ones that were
 * ignored for being unverified, because "I signed in with the right GitHub and
 * it says no" is otherwise inexplicable.
 */
export function oauthNoPurchasePage(input: {
  verifiedEmails: readonly string[];
  ignoredEmails: readonly string[];
}): string {
  const list = (emails: readonly string[]): string =>
    `<ul style="margin:0 0 1rem;padding-left:1.2rem">${emails
      .map((email) => `<li>${escapeHtml(email)}</li>`)
      .join('')}</ul>`;

  const checked =
    input.verifiedEmails.length === 0
      ? '<p style="margin:0 0 1rem;opacity:.75">GitHub did not give us a single verified address to check.</p>'
      : `<p style="margin:0 0 .5rem;opacity:.75">We checked these verified addresses:</p>${list(input.verifiedEmails)}`;

  const ignored =
    input.ignoredEmails.length === 0
      ? ''
      : `<p style="margin:0 0 .5rem;opacity:.75">We ignored these, because GitHub has not confirmed you own them:</p>${list(
          input.ignoredEmails,
        )}`;

  return document_(
    'No purchase found',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">No purchase found</h1>',
      checked,
      ignored,
      '<p style="margin:0 0 1.5rem">There is no account here yet — accounts are made by a purchase, not by signing in. ',
      'If you have paid, the receipt email has your account link in it; open that and connect GitHub afterwards, ',
      'and this will work next time.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Email me a sign-in link instead</a></p>`,
    ].join(''),
  );
}

/** Every OAuth failure that is not "no purchase". One page, several causes. */
export function oauthRejectedPage(): string {
  return document_(
    'That sign-in did not complete',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">That sign-in did not complete</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Either it took too long, or GitHub did not confirm it. ',
      'Nothing has changed on your account.</p>',
      `<p style="margin:0 0 1rem"><a href="/auth/github/start" style="color:#e8e8ea">Try GitHub again</a></p>`,
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Email me a sign-in link instead</a></p>`,
    ].join(''),
  );
}

/** The OAuth-side rate limit. */
export function oauthRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Too many attempts</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">Give it a few minutes and try again.</p>',
    ].join(''),
  );
}

/** Told plainly when GitHub is not configured, rather than a 500. */
export function oauthNotConfiguredPage(): string {
  return document_(
    'GitHub sign-in is not available',
    [
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">GitHub sign-in is not available</h1>',
      '<p style="margin:0 0 1.5rem;opacity:.75">It is not switched on here. The other two ways in still work.</p>',
      `<p style="margin:0"><a href="/auth/sign-in" style="color:#e8e8ea">Email me a sign-in link</a></p>`,
    ].join(''),
  );
}
