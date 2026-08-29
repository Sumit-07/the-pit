/**
 * `POST /auth/capability/rotate` — replace the account link.
 *
 * POST only, and there is deliberately no GET. A GET that replaced a credential
 * could be fired by any `<img src>` on any page the customer visits, and by
 * every prefetcher, link preview and mail scanner that follows a URL — the same
 * class of failure that made `GET /auth/verify` render a button rather than
 * consume a token. Because the session cookie is `SameSite=Lax`, it is withheld
 * from a cross-site POST, so the verb is the CSRF defence.
 *
 * The route is gated on the session, not on holding the slug being replaced:
 * after a real leak the leaker holds the slug too, and letting possession
 * authorize a rotation would let them lock the customer out of their own
 * account. See `capability/access.ts`.
 */

import { capabilityDeps } from '@/lib/auth/config';
import { handleCapabilityRotate } from '@/lib/auth/capability-handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleCapabilityRotate(request, capabilityDeps());
}
