/**
 * `POST /api/free` — the free first throw, and the second writer of `submissions`.
 *
 * The sibling of `POST /api/checkout`, and it runs the same guards in the same
 * order before it writes anything. What it does instead of opening a Dodo session
 * is send one email; nothing is granted, no account exists yet, and the run does
 * not start until somebody presses a button in that inbox.
 *
 * `force-dynamic` and the Node runtime for the reasons the checkout route gives:
 * this reads a request body, touches the database and sends mail, and a cached
 * version of it would be a form that answers one visitor with another's
 * submission id.
 */

import { freeCreateDeps } from '@/lib/free/config';
import { handleFreeRunCreate } from '@/lib/free/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleFreeRunCreate(request, freeCreateDeps());
}
