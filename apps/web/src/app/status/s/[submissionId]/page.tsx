import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RUN_STATUS_TOKEN_PARAM } from '@the-pit/auth';

import { RunStatusPage } from '@/components/run-status';
import { loadSubmissionStatus, submissionRunSource } from '@/lib/pipeline/service';
import { mayReadRunStatus } from '@/lib/pipeline/status-access';

/**
 * `/status/s/<submission>` — the page a buyer lands on after paying.
 *
 * ## Keyed on the submission, not on the category
 *
 * The page this replaces was keyed on the category slug and read phases at the
 * category's CURRENT `category_snapshot_version`. A run is stamped with the
 * version it read at enqueue, and every placement that lands afterwards moves the
 * category's (`brief §1.2`), so the first stranger to deliver blanked the waiting
 * customer's page: five steps pending, no failure, no explanation. Every version
 * this page reads at comes off the buyer's own job row — see
 * `lib/pipeline/service.ts`.
 *
 * ## Resumable, in the sense `brief` Part 6 means
 *
 * > "Someone who closes the tab at 40s returns to live progress, not a spinner
 * > or a dead job."
 *
 * The server reads the run's REAL state first, out of the version-stamped phase
 * envelopes the pipeline persists as each phase lands, and hands it to the client
 * as the first paint. Only then does the client poll. A page that mounted empty
 * and waited for a stream would show a spinner to exactly the person this
 * requirement is about.
 *
 * `force-dynamic` because the answer is about a run in flight: a statically
 * evaluated version of this page would be a permanently stale claim about a job
 * that has since finished. `noindex` because the URL carries a signature.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your run',
  robots: { index: false, follow: false },
};

export default async function SubmissionStatusRoute({
  params,
  searchParams,
}: {
  params: Promise<{ submissionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { submissionId } = await params;
  const query = await searchParams;
  const raw = query[RUN_STATUS_TOKEN_PARAM];
  const token = typeof raw === 'string' ? raw : undefined;

  // Before the lookup, not after. A refusal that depended on whether the
  // submission exists would tell whoever guessed an id which it was.
  if (!mayReadRunStatus(submissionId, token)) notFound();

  const lookup = await loadSubmissionStatus(submissionId, submissionRunSource());
  if (!lookup.found) notFound();

  return <RunStatusPage view={lookup.view} token={token} />;
}
