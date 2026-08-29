/**
 * `GET /submit` — the form `POST /api/checkout` answers.
 *
 * A route handler rather than a `page.tsx`, for the reason `lib/verdict/page.ts`
 * and `lib/account/page.ts` already give: it is one self-contained HTML document
 * with inline CSS and no script, so it renders with no second request and works
 * with JavaScript disabled. That matters more here than anywhere else in the app
 * — this is the page that takes someone's money, and `brief §2.1` promises
 * nothing sits between a visitor and their purchase on any device.
 */

import { checkoutDeps } from '@/lib/checkout/config';
import { handleSubmitPage } from '@/lib/checkout/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleSubmitPage(request, checkoutDeps());
}
