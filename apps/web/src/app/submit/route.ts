/**
 * `GET /submit` — the form `POST /api/checkout` answers.
 *
 * A route handler rather than a `page.tsx`, for the reason `lib/verdict/page.ts`
 * and `lib/account/page.ts` already give: it is one self-contained HTML document
 * with inline CSS and no script, so it renders with no second request and works
 * with JavaScript disabled. That matters more here than anywhere else in the app
 * — this is the page that takes someone's money, and `brief §2.1` promises
 * nothing sits between a visitor and their purchase on any device.
 *
 * ## And it renders with nothing wired
 *
 * It used to call `checkoutDeps()`, which throws `PaymentsNotWiredError` without
 * a `DATABASE_URL` — so a deployment mid-wiring served a 500 on the one page a
 * visitor has to see before they can pay. That was a read path pulling in a
 * write path's dependencies, the same fault `/boards` was fixed for.
 *
 * `submitPageDeps()` resolves the category roster from the snapshot sink and an
 * optional session keyring, and nothing else. `POST /api/checkout` keeps
 * `checkoutDeps()` and keeps failing loudly when the money path is unwired,
 * because that is the request where the wiring is actually needed.
 */

import { submitPageDeps } from '@/lib/checkout/config';
import { handleSubmitPage } from '@/lib/checkout/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleSubmitPage(request, submitPageDeps());
}
