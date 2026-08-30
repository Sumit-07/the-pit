/**
 * `GET /submit` — the form `POST /api/checkout` answers.
 *
 * A route handler rather than a `page.tsx`, for the reason `lib/verdict/page.ts`
 * and `lib/account/page.ts` already give: it is one self-contained HTML document
 * with inline CSS, so it renders with no second request and no client bundle.
 * That matters more here than anywhere else in the app — this is the page that
 * takes someone's money.
 *
 * ## What `brief §2.1` actually promises, and what it does not
 *
 * §2.1 is "no login at submission — nothing sits between a visitor and their
 * purchase". That is a rule about AUTHENTICATION. This comment used to read it
 * as a ban on scripting and say the page therefore had none, and that inference
 * was then treated by later work as if it were the founder's requirement. It
 * was not, and it has been retired: the page now carries one inline script,
 * `AUTOFILL_SCRIPT` in `lib/checkout/page.ts`, which reads the pasted URL's own
 * `<title>` and `<meta name="description">` through `@the-pit/fetch`'s guarded
 * fetcher and pre-fills the empty fields with them.
 *
 * The promise §2.1 does make is still kept, and more cheaply than before: the
 * autofill removes typing from the buying path rather than adding a step to it.
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
