/**
 * `GET /checkout/success` — where Dodo sends the buyer back, and where the
 * capability URL is handed over.
 *
 * This page grants nothing. `brief §2.2`: attempts come from the signed webhook,
 * never from the success redirect — and this route has no ledger, no webhook
 * store and no way to append anything. It reads a slug the webhook already
 * minted and shows it.
 *
 * It is reachable with no session and no login, because that is the whole point:
 * the buyer paid as a guest and has no way to prove who they are except the
 * payment they just made. See `capability/handoff.ts` for the thirty-minute
 * window and the rate limit that bound how much that proof is worth.
 */

import { handoffDeps } from '@/lib/auth/config';
import { handleCheckoutSuccess } from '@/lib/auth/handoff-handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleCheckoutSuccess(request, handoffDeps());
}
