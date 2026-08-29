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

import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

/**
 * The magic-link screens, on the same theme as everything else.
 *
 * These four pages used to carry a palette of their own — `#0b0b0c` on `#e8e8ea`,
 * system-ui, inline `style=` attributes — which made them the only screens in the
 * product that looked like a different product. They now render `lib/theme.ts`,
 * so a person who arrives here from a receipt lands somewhere they recognise.
 *
 * Still one file, still no script: `brief §2.1`'s GET-renders-a-button defence
 * works because rendering this page consumes nothing, and a page that needed
 * JavaScript to show its button would be a page a mail scanner could see and a
 * human could not.
 */
const CSS = `${TOKENS}${BASE}
body{min-height:100vh;display:grid;place-items:center;padding:32px 18px}
main{width:100%;max-width:30rem;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r3);box-shadow:var(--e3);padding:32px 30px;position:relative;overflow:hidden}
main::before{content:"";position:absolute;left:0;top:0;height:3px;width:38%;background:var(--cut)}
main h1{font-size:26px;font-weight:700;letter-spacing:-.026em;margin:0 0 10px}
main p{font-size:14.5px;line-height:1.62;color:var(--dim);margin:0 0 20px}
main p:last-child{margin-bottom:0}
main label{display:block;margin:0 0 7px;font-family:var(--mono);font-size:10px;
  font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
main input[type=email]{margin:0 0 18px}
main a{color:var(--ink);font-weight:600;text-decoration:none;
  border-bottom:1px solid var(--line);padding-bottom:1px}
main a:hover{border-bottom-color:var(--ink)}
main h2{font-size:17px;font-weight:700;letter-spacing:-.015em;margin:0 0 10px}
main .urlline{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
main .fine{font-size:13px;color:var(--dimmer)}
main .list{margin:0 0 18px;padding-left:1.2rem;font-size:14px;line-height:1.7;color:var(--dim)}
main .list li{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
`;

const BUTTON_CLASS = 'act prime';

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
    FONT_LINKS,
    `<style>${CSS}</style>`,
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>',
  ].join('');
}

/** The sign-in form. Posts an address to `/auth/request`. */
export function signInPage(): string {
  return document_(
    'Sign in',
    [
      '<h1>Sign in to The Pit</h1>',
      '<p>We will send a link to the address on your receipt. ',
      'There is no password — there never was one.</p>',
      '<form method="post" action="/auth/request">',
      `<label for="email">Email</label>`,
      `<input id="email" name="email" type="email" autocomplete="email" required>`,
      `<button type="submit" class="${BUTTON_CLASS}">Send me a link</button>`,
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
      '<h1>Check your inbox</h1>',
      `<p>${escapeHtml(message)}</p>`,
      '<p>The link works once and stops working after 15 minutes.</p>',
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
      '<h1>One more press</h1>',
      '<p>Mail scanners open every link in a message. ',
      'This one does nothing until you press the button, so yours is still waiting for you.</p>',
      '<form method="post" action="/auth/verify">',
      `<input type="hidden" name="token" value="${escapeHtml(token)}">`,
      `<button type="submit" class="${BUTTON_CLASS}">Sign me in</button>`,
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
      '<h1>That link no longer works</h1>',
      '<p>Sign-in links last 15 minutes and work once. ',
      'Ask for a fresh one and it will be in your inbox in a moment.</p>',
      `<p><a href="/auth/sign-in">Send me a new link</a></p>`,
    ].join(''),
  );
}

/** The verify-side rate limit. Depends on the caller, not on any account. */
export function verifyRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1>Too many attempts</h1>',
      '<p>Give it a few minutes and try your link again.</p>',
      `<p><a href="/auth/sign-in">Send me a new link</a></p>`,
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
      '<h1>Payment received</h1>',
      '<p>Your run starts the moment the payment settles.</p>',
      '<h2>Bookmark this — it is your account</h2>',
      '<p>No password, no expiry. It is how you reach your ',
      'remaining attempts, your history, and a re-pitch.</p>',
      `<p class="urlline"><a href="${safeUrl}">${safeUrl}</a></p>`,
      `<p class="fine">We have also emailed it to ${escapeHtml(input.email)} as a backup. `,
      'Treat the link like a key: anyone who has it can reach your account, and you can replace it from your account page at any time.</p>',
      '<p class="fine">Your verdict page will be public and shareable on its own. ',
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
      '<h1>Payment received</h1>',
      '<p>Your run starts the moment the payment settles.</p>',
      '<p>We cannot show your account link on this page any more — it is only ',
      'shown for a short while after payment, so that a link left in a browser history does not become a way in.</p>',
      '<p>It was emailed to the address on your receipt. If that has not arrived, ',
      'ask for a sign-in link instead.</p>',
      `<p><a href="/auth/sign-in">Email me a sign-in link</a></p>`,
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
      '<h1>That link no longer works</h1>',
      '<p>Account links stop working when they are replaced. ',
      'If you replaced yours, use the new one; otherwise sign in with the address on your receipt.</p>',
      `<p><a href="/auth/sign-in">Email me a sign-in link</a></p>`,
    ].join(''),
  );
}

/** The capability-side rate limit. Depends on the caller, not on any account. */
export function capabilityRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1>Too many attempts</h1>',
      '<p>Give it a few minutes and try your link again.</p>',
    ].join(''),
  );
}

/** After a rotation: the new URL, and what just happened to the old one. */
export function capabilityRotatedPage(url: string): string {
  const safeUrl = escapeHtml(url);
  return document_(
    'New account link',
    [
      '<h1>Here is your new account link</h1>',
      '<p>The old one stopped working the moment this page loaded. ',
      'Replace your bookmark.</p>',
      `<p class="urlline"><a href="${safeUrl}">${safeUrl}</a></p>`,
      '<p class="fine">Anyone still signed in on another device stays signed in until ',
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
    `<ul class="list">${emails
      .map((email) => `<li>${escapeHtml(email)}</li>`)
      .join('')}</ul>`;

  const checked =
    input.verifiedEmails.length === 0
      ? '<p>GitHub did not give us a single verified address to check.</p>'
      : `<p>We checked these verified addresses:</p>${list(input.verifiedEmails)}`;

  const ignored =
    input.ignoredEmails.length === 0
      ? ''
      : `<p>We ignored these, because GitHub has not confirmed you own them:</p>${list(
          input.ignoredEmails,
        )}`;

  return document_(
    'No purchase found',
    [
      '<h1>No purchase found</h1>',
      checked,
      ignored,
      '<p>There is no account here yet — accounts are made by a purchase, not by signing in. ',
      'If you have paid, the receipt email has your account link in it; open that and connect GitHub afterwards, ',
      'and this will work next time.</p>',
      `<p><a href="/auth/sign-in">Email me a sign-in link instead</a></p>`,
    ].join(''),
  );
}

/** Every OAuth failure that is not "no purchase". One page, several causes. */
export function oauthRejectedPage(): string {
  return document_(
    'That sign-in did not complete',
    [
      '<h1>That sign-in did not complete</h1>',
      '<p>Either it took too long, or GitHub did not confirm it. ',
      'Nothing has changed on your account.</p>',
      `<p><a href="/auth/github/start">Try GitHub again</a></p>`,
      `<p><a href="/auth/sign-in">Email me a sign-in link instead</a></p>`,
    ].join(''),
  );
}

/** The OAuth-side rate limit. */
export function oauthRateLimitedPage(): string {
  return document_(
    'Too many attempts',
    [
      '<h1>Too many attempts</h1>',
      '<p>Give it a few minutes and try again.</p>',
    ].join(''),
  );
}

/** Told plainly when GitHub is not configured, rather than a 500. */
export function oauthNotConfiguredPage(): string {
  return document_(
    'GitHub sign-in is not available',
    [
      '<h1>GitHub sign-in is not available</h1>',
      '<p>It is not switched on here. The other two ways in still work.</p>',
      `<p><a href="/auth/sign-in">Email me a sign-in link</a></p>`,
    ].join(''),
  );
}
