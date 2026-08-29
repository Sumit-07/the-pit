/**
 * `GET /account` — where every sign-in path lands.
 *
 * All three doors answer `303` with `Location: /account` — the magic link's
 * `POST /auth/verify`, `GET /a/<slug>`, and the GitHub callback — so this is the
 * one page in the product that has to exist for any of them to mean anything.
 *
 * A route handler rather than a `page.tsx`, for the reason `lib/auth/pages.ts`
 * and `lib/verdict/page.ts` both give: the document is a single self-contained
 * string with no client JavaScript, and the rotate control is a plain form POST
 * that has to work when everything else has not.
 *
 * `force-dynamic` is not optional here. This page is a function of a session
 * cookie and it displays a bearer URL; a cached render would be one customer's
 * account served to the next.
 */

import { accountDeps } from '@/lib/account/config';
import { handleAccountPage } from '@/lib/account/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleAccountPage(request, accountDeps());
}
