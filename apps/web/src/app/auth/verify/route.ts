/**
 * `/auth/verify` — the two-step redemption `brief §2.1` insists on.
 *
 * > `GET /auth/verify` renders a **button**; a `POST` does the actual
 * > verification. Corporate mail scanners (Outlook Safe Links) follow GET links
 * > and would burn single-use tokens. Do not skip this.
 *
 * The two verbs share a file so that the URL in the email and the URL the token
 * is posted to are the same string, and so the asymmetry between them is visible
 * in four lines rather than spread across two directories.
 *
 * `GET` is given no dependencies at all. `handleVerifyPage` takes a `Request`
 * and returns a `Response`; there is no store in its signature, so it cannot
 * spend a token however hard a future edit tries.
 */

import { authDeps } from '@/lib/auth/config';
import { handleVerifyPage, handleVerifySubmit } from '@/lib/auth/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Renders the button. Touches nothing. */
export function GET(request: Request): Response {
  return handleVerifyPage(request);
}

/** Spends the token, once. */
export function POST(request: Request): Promise<Response> {
  return handleVerifySubmit(request, authDeps());
}
