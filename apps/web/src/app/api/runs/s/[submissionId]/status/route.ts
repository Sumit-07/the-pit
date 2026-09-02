import { NextResponse } from 'next/server';

import { RUN_STATUS_TOKEN_PARAM } from '@the-pit/auth';

import { loadSubmissionStatus, submissionRunSource } from '@/lib/pipeline/service';
import { mayReadRunStatus } from '@/lib/pipeline/status-access';

/**
 * Where one buyer's run is — read from what is persisted, every time.
 *
 * `brief` Part 6: "**Status page** — resumable. Someone who closes the tab at 40s
 * returns to live progress, not a spinner or a dead job." This endpoint is what
 * makes that true. It reconstructs state from the version-stamped phase envelopes
 * the pipeline writes as each phase lands, so the answer is identical whether the
 * caller has been watching since the first second or has just opened the URL.
 *
 * ## Keyed on the submission, and gated on the same signature as the page
 *
 * Both take the token out of the query string and both refuse with a 404. An
 * endpoint that answered where the page would not would be the leak the page was
 * written to prevent, and it is the one of the two that is easy to forget.
 *
 * ## Polling, not SSE
 *
 * A run is five steps over a couple of minutes and the payload is a few hundred
 * bytes. An open SSE connection per waiting customer would hold a serverless
 * function open for the whole run — on Vercel that is billed wall-clock time for
 * a stream that changes five times — and it would still need this same endpoint
 * behind it for the reload case, because a stream cannot replay what happened
 * before it was opened. So the page polls this, and the reconstruction is the
 * only mechanism rather than a fallback for one.
 *
 * ## Never cached
 *
 * `no-store` is not a default worth inheriting here. A CDN holding this response
 * for even a few seconds would show a customer a run that has already moved,
 * which is the exact failure the page exists to avoid — and the URL carries a
 * signature, so a shared cache entry would be one buyer's run under another
 * buyer's key.
 */
export const dynamic = 'force-dynamic';

const NO_STORE: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

function notFound(): NextResponse {
  // One body for "no such submission" and for "not your submission". Telling the
  // two apart is free reconnaissance for whoever guessed the id.
  return NextResponse.json({ error: 'no run' }, { status: 404, headers: NO_STORE });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<NextResponse> {
  const { submissionId } = await context.params;
  const token = new URL(request.url).searchParams.get(RUN_STATUS_TOKEN_PARAM) ?? undefined;

  if (!mayReadRunStatus(submissionId, token)) return notFound();

  const lookup = await loadSubmissionStatus(submissionId, submissionRunSource());
  if (!lookup.found) return notFound();

  return NextResponse.json(lookup.view.status, { headers: NO_STORE });
}
