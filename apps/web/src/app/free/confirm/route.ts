/**
 * `/free/confirm` — the two-step redemption, applied to a run instead of a
 * sign-in.
 *
 * `brief §2.1` wrote the rule for the magic link:
 *
 * > `GET` renders a **button**; a `POST` does the actual verification. Corporate
 * > mail scanners (Outlook Safe Links) follow GET links and would burn single-use
 * > tokens. Do not skip this.
 *
 * The stake here is larger than a burned token. A scanner that started the run
 * would buy six juror calls, a clustering pass and four forced choices before the
 * founder opened the mail — and the page they eventually reached would tell them
 * their verdict was already on its way to somebody.
 *
 * The two verbs share a file so the URL in the email and the URL the token is
 * posted to are the same string, and so the asymmetry between them is visible in
 * four lines. `GET` is given no dependencies at all: `handleFreeConfirmPage` takes
 * a `Request` and returns a `Response`, so there is no ledger, no account store
 * and no queue in its signature and it cannot start anything however hard a
 * future edit tries.
 */

import { freeConfirmDeps } from '@/lib/free/config';
import { handleFreeConfirm, handleFreeConfirmPage } from '@/lib/free/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Renders the button. Touches nothing. */
export function GET(request: Request): Response {
  return handleFreeConfirmPage(request);
}

/** Creates the account, grants the one attempt, and starts the run. */
export function POST(request: Request): Promise<Response> {
  return handleFreeConfirm(request, freeConfirmDeps());
}
