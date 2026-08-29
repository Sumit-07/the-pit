import { NextResponse } from 'next/server';

import { loadRunStatus } from '@/lib/pipeline/service';

/**
 * Where a run is — read from what is persisted, every time.
 *
 * `brief` Part 6: "**Status page** — resumable. Someone who closes the tab at 40s
 * returns to live progress, not a spinner or a dead job." This endpoint is what
 * makes that true. It reconstructs state from the version-stamped phase envelopes
 * the pipeline writes as each phase lands, so the answer is identical whether the
 * caller has been watching since the first second or has just opened the URL.
 *
 * ## Polling, not SSE
 *
 * A run is five steps over a few tens of seconds and the payload is a few hundred
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
 * which is the exact failure the page exists to avoid. The board snapshot at
 * `/api/boards/[slug]` is the opposite case and is cached hard.
 *
 * `?version=` names the category snapshot version to judge stored phases against.
 * Omitted, the installed jury's `prompt_version` is used, which is what the CLI
 * defaults to.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const version = new URL(request.url).searchParams.get('version') ?? undefined;

  const lookup = await loadRunStatus(slug, undefined, version);
  if (!lookup.found) {
    return NextResponse.json(
      { error: 'no run', slug, detail: 'no category is seeded under this slug' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(lookup.status, { headers: { 'Cache-Control': 'no-store' } });
}
