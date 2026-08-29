import { hasDatabaseUrl } from '@the-pit/db';
import { NextResponse } from 'next/server';

import { ENGINE } from '@/lib/engine';

/**
 * Is this deployment wired up?
 *
 * The one route in the Phase 2 shell, and it exists because of the specific state
 * this project is in: there is no database provisioned (`brief` Part 7 budgets
 * Neon; nothing has been created), so the first thing anyone will want from the
 * first deployment is a straight answer to "is `DATABASE_URL` set here".
 *
 * It reads the variable through `hasDatabaseUrl`, which does not throw and does
 * not connect. Reporting `database: "not configured"` with a 200 is deliberate:
 * an unconfigured preview deployment is expected, not broken, and a health check
 * that 500s on it trains people to ignore it. It also never echoes the value —
 * the password is in the URL.
 *
 * `force-dynamic` because the answer is about the running environment. Without
 * it Next would evaluate this at build time and serve a permanently stale
 * verdict about a variable that is set per environment.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({
    status: 'ok',
    engine: ENGINE.version,
    database: hasDatabaseUrl() ? 'configured' : 'not configured',
  });
}
