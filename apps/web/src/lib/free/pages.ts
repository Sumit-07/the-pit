/**
 * The three screens the free throw needs that the submit page cannot be.
 *
 * They are plain strings on `lib/theme.ts`, exactly like `lib/auth/pages.ts`, and
 * for the same reason: the confirm page is a `route.ts` exporting both verbs, so
 * the URL in the email and the URL the button posts to are one string.
 *
 * ## The confirm page is the Outlook Safe Links defence, again
 *
 * `brief §2.1` argued it for the magic link and the stake is higher here:
 *
 * > `GET` renders a **button**; a `POST` does the actual verification. Corporate
 * > mail scanners follow GET links and would burn single-use tokens.
 *
 * A scanner that started a run would spend the panel before the founder opened
 * the mail. So `freeConfirmButtonPage` renders a form and nothing else, and the
 * GET handler that serves it is given no dependencies at all — there is no
 * expression on that path that could reach a ledger.
 *
 * ## Escaping
 *
 * `escapeHtml` from `@the-pit/auth`, the same function the email body and the
 * auth screens use. Both hidden fields arrive from a query string, and a query
 * string is attacker-controlled by definition — an unescaped interpolation into a
 * `value=` attribute here would be a reflected XSS on the page that is about to
 * set a 90-day session cookie.
 */

import { escapeHtml } from '@the-pit/auth';

import { BASE, FONT_LINKS, TOKENS } from '@/lib/theme';

const CSS = `${TOKENS}${BASE}
body{min-height:100vh;display:grid;place-items:center;padding:32px 18px}
main{width:100%;max-width:30rem;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r3);box-shadow:var(--e3);padding:32px 30px;position:relative;overflow:hidden}
main::before{content:"";position:absolute;left:0;top:0;height:3px;width:38%;background:var(--cut)}
main h1{font-size:26px;font-weight:700;letter-spacing:-.026em;margin:0 0 10px}
main p{font-size:14.5px;line-height:1.62;color:var(--dim);margin:0 0 20px}
main p:last-child{margin-bottom:0}
main .fine{font-size:13px;color:var(--dimmer)}
main a{color:var(--ink);font-weight:600;text-decoration:none;
  border-bottom:1px solid var(--line);padding-bottom:1px}
main a:hover{border-bottom-color:var(--ink)}
`;

const BUTTON_CLASS = 'act prime';

function document_(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // The token is in this page's URL. `noindex` keeps it out of search results;
    // the route's `Referrer-Policy: no-referrer` keeps it out of the Referer of
    // anything the page loads.
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(title)} — The Pit</title>`,
    FONT_LINKS,
    `<style>${CSS}</style>`,
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>',
  ].join('');
}

/**
 * What the submitter sees the moment the form is accepted.
 *
 * It names the address, because the single most common failure of this flow is a
 * typo nobody can see, and it is the last screen on which a typo is cheap to
 * notice.
 */
export function freeSentPage(email: string): string {
  return document_(
    'Check your inbox',
    [
      '<h1>Check your inbox</h1>',
      `<p>We sent a link to ${escapeHtml(email)}.</p>`,
      '<p>Press it and the panel starts reading.</p>',
      '<p class="fine">The link stops working in 24 hours.</p>',
    ].join(''),
  );
}

/**
 * The page the confirm link lands on: a button, and nothing else.
 *
 * Rendering it starts nothing, grants nothing and writes nothing. Every scanner,
 * antivirus proxy, link preview and offline prefetcher that follows the URL lands
 * here, gets HTML, and goes away — the run is still unstarted when the human
 * arrives and presses, which is a POST.
 */
export function freeConfirmButtonPage(submissionId: string, token: string): string {
  return document_(
    'Start your verdict',
    [
      '<h1>One more press</h1>',
      '<p>Press to send it in.</p>',
      '<form method="post" action="/free/confirm">',
      `<input type="hidden" name="s" value="${escapeHtml(submissionId)}">`,
      `<input type="hidden" name="t" value="${escapeHtml(token)}">`,
      `<button type="submit" class="${BUTTON_CLASS}">Start my verdict</button>`,
      '</form>',
    ].join(''),
  );
}

/**
 * One page for every rejection.
 *
 * Expired, forged, replayed after the day was up, or naming a submission that is
 * not there: all of them render this. The handler distinguishes them for the log;
 * telling the person holding the token which one it was is free reconnaissance
 * for somebody who did not come by it honestly. Same posture as
 * `verifyRejectedPage`.
 */
export function freeConfirmRejectedPage(): string {
  return document_(
    'That link no longer works',
    [
      '<h1>That link no longer works</h1>',
      '<p>Throw it in again and we will send a fresh one.</p>',
      '<p><a href="/submit">Back to the form</a></p>',
    ].join(''),
  );
}
