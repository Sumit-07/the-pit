/**
 * `/a/<slug>` — the capability URL. The path that works when email does not.
 *
 * Short on purpose: `/a/` rather than `/account/link/` because this is a URL
 * people are asked to bookmark, read off a receipt, and occasionally type.
 *
 * GET only. There is no POST here and there must not be one: this is the URL a
 * customer bookmarks, and a bookmark is a GET. That makes it the opposite of
 * `/auth/verify`, whose two-step exists because a single-use token behind a GET
 * gets burned by mail scanners — a capability slug is NOT single use, so a
 * scanner following it does no damage beyond spending a rate-limit slot.
 *
 * The response is a 303 to `/account`, so the credential never becomes the URL
 * of a page the customer sits on. See `capability-handlers.ts` for the four ways
 * a URL leaks and how each is closed.
 */

import { capabilityDeps } from '@/lib/auth/config';
import { handleCapabilityOpen } from '@/lib/auth/capability-handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  return await handleCapabilityOpen(request, slug, capabilityDeps());
}
