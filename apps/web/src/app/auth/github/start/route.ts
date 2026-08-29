/**
 * `GET /auth/github/start` — send the browser to GitHub.
 *
 * A plain link, no JavaScript, for the same reason `/auth/sign-in` is a plain
 * form. It is never reachable from the buying path: `brief §2.1` keeps guest
 * checkout free of any login, and on a phone without the GitHub app installed
 * this flow is a password and a 2FA code typed into a mobile browser.
 *
 * `oauthDeps()` returns `null` when no client credentials are configured, which
 * is the state of this repository. That renders a page saying so rather than a
 * 500: the other two paths are unaffected, and the customer should be told which
 * door to use.
 */

import { oauthDeps } from '@/lib/auth/config';
import { handleGitHubStart } from '@/lib/auth/oauth-handlers';
import { oauthNotConfiguredPage } from '@/lib/auth/pages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  const deps = oauthDeps();
  if (deps === null) {
    return new Response(oauthNotConfiguredPage(), {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return handleGitHubStart(request, deps);
}
