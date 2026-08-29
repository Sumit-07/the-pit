/**
 * `GET /auth/session` — the gate, on its own.
 *
 * `brief §2.1`: "Public vs private: verdict URLs are public. Attempt balance and
 * history are behind the session."
 *
 * There is no data behind this endpoint. The balance lives in the attempts
 * ledger (`packages/payments`) and the history in the accounts schema, both of
 * which are other agents' work; what this route is for is the other half of that
 * sentence — proving the session check exists, refuses a cookie it did not sign,
 * and is the thing a private surface will sit behind.
 */

import { authDeps } from '@/lib/auth/config';
import { handleSession } from '@/lib/auth/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  return handleSession(request, authDeps());
}
