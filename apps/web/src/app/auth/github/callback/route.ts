/**
 * `GET /auth/github/callback` — the round trip lands here.
 *
 * A GET because that is what GitHub redirects to; we do not get a choice. Safe
 * in a way `/auth/verify` is not, for two independent reasons: an authorization
 * code is single-use AT GITHUB, so a scanner that follows this URL burns the
 * code at the provider rather than spending anything of ours, and the signed
 * state cookie a scanner does not have would refuse it first.
 *
 * Every outcome — signed in, no purchase found, refused, rate limited — clears
 * the state cookie. See `oauth/sign-in.ts`.
 */

import { oauthDeps } from '@/lib/auth/config';
import { handleGitHubCallback } from '@/lib/auth/oauth-handlers';
import { oauthNotConfiguredPage } from '@/lib/auth/pages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
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
  return await handleGitHubCallback(request, deps);
}
