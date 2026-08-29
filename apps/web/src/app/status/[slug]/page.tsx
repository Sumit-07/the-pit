import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { loadRunStatus } from '@/lib/pipeline/service';

import { RunProgress } from './progress';

/**
 * The status page — resumable, in the specific sense `brief` Part 6 means:
 *
 * > "Someone who closes the tab at 40s returns to live progress, not a spinner or
 * > a dead job."
 *
 * The whole design is in the order of two lines below. The server reads the run's
 * REAL state first, out of the version-stamped phase envelopes the pipeline
 * persists as each phase lands, and hands it to the client as the first paint.
 * Only then does the client start polling for changes.
 *
 * The tempting inverse — render a shell, connect a stream, fill it in — is
 * correct for a viewer who never left and wrong for the one this requirement is
 * about. A stream cannot replay the Score phase that landed while the tab was
 * closed, so the reloading customer gets an empty list under a spinner: exactly
 * the "dead job" impression, on the page whose job is to dispel it.
 *
 * `force-dynamic` because the answer is about a run in flight. A statically
 * evaluated version of this page would be a permanently stale verdict about a
 * job that has since finished.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Run status — ${slug}` };
}

export default async function StatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const query = await searchParams;
  const version = typeof query['version'] === 'string' ? query['version'] : undefined;

  const lookup = await loadRunStatus(slug, undefined, version);
  if (!lookup.found) notFound();

  return (
    <main>
      <h1>{lookup.status.slug}</h1>
      {/*
        The initial state is the server's reconstruction, not an empty shell.
        That single prop is what makes a mid-run reload land on live progress.
      */}
      <RunProgress initial={lookup.status} />
      <p>
        <small>
          Everyone walks in at 100. Fewest cuts wins. Disliking the result is not a failure — only a run
          that never finished is.
        </small>
      </p>
    </main>
  );
}
