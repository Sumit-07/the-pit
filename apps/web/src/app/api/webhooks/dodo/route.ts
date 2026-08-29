/**
 * `POST /api/webhooks/dodo` — where an account and an attempt come from.
 *
 * `brief §2.2`, and the reason there is no GET here and no handler on the success
 * redirect: "Grant attempts on the **signed webhook**, never on the success
 * redirect." The redirect is a URL the buyer's browser lands on and its query
 * string is whatever the browser was told to send; this is a body signed with a
 * secret only Dodo and this deployment hold.
 *
 * `force-dynamic` and the Node runtime, both required rather than stylistic: the
 * handler reads the raw body and computes an HMAC over it with `node:crypto`, and
 * a cached or edge-rendered version of this route would be a payments endpoint
 * that could not verify a signature.
 */

import { dodoWebhookDeps } from '@/lib/payments/config';
import { handleDodoWebhookRequest } from '@/lib/payments/webhook-handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleDodoWebhookRequest(request, dodoWebhookDeps());
}
