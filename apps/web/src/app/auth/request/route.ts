/**
 * `POST /auth/request` — `brief §2.1`.
 *
 * Two lines, on purpose. Everything that could be wrong here is in
 * `@/lib/auth/handlers`, which is testable with a hand-built `Request`; a route
 * file that grew logic would be logic that only a running Next.js server can
 * exercise.
 *
 * There is no `GET`. An endpoint that sends mail on a GET would send one for
 * every crawler, prefetcher and mail scanner that saw the URL.
 */

import { authDeps } from '@/lib/auth/config';
import { handleAuthRequest } from '@/lib/auth/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request, authDeps());
}
