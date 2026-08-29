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
