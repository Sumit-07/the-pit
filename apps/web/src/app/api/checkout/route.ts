/**
 * `POST /api/checkout` — the buying path, and the only writer of `submissions`.
 *
 * `brief §2.1` is guest checkout: URL, name, description, pay. There is no
 * session gate on this route and there must never be one. A GitHub session, when
 * one happens to be present, only makes the answer better — it lets an ownership
 * conflict be refused before the charge instead of held after it.
 *
 * `force-dynamic` and the Node runtime for the same reasons the webhook route
 * gives: this reads a request body, opens a session against a third party and
 * touches the database, and a cached version of it would be a checkout that hands
 * two buyers the same payment link.
 */

import { checkoutDeps } from '@/lib/checkout/config';
import { handleCheckoutCreate } from '@/lib/checkout/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleCheckoutCreate(request, checkoutDeps());
}
