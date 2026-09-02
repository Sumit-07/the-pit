'use client';

import { useEffect, useState } from 'react';

import type { RunState, RunStatus, StepStatus } from '@/lib/pipeline/status';

/**
 * The live half of the status page.
 *
 * It is handed `initial` — the run's REAL state, reconstructed on the server from
 * the persisted phase envelopes — and then polls for changes. That order is the
 * whole point of `brief` Part 6: "Someone who closes the tab at 40s returns to
 * live progress, not a spinner or a dead job." A component that mounted empty and
 * waited for its first message would show a spinner to exactly the person the
 * requirement is about, and would show it for as long as the next phase takes.
 *
 * So this component never renders an unknown state. Its first paint is the
 * server's, its subsequent paints are polls, and a failed poll leaves the last
 * known state on screen rather than blanking it — a dropped connection is not
 * evidence that a run stopped.
 *
 * Polling stops on a terminal state. `delivered` and `needs_support` do not move
 * again without a new run or a person, and a page left open on a delivered
 * verdict should not keep a function warm all afternoon.
 */

/** How often to ask. A run is five steps over tens of seconds; this is fast enough to feel live. */
const POLL_MS = 2000;

/** States that never change again on their own. */
const TERMINAL: readonly RunState[] = ['delivered', 'needs_support'];

export function RunProgress({ initial }: { initial: RunStatus }): React.JSX.Element {
  const [status, setStatus] = useState<RunStatus>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (TERMINAL.includes(status.state)) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/runs/${encodeURIComponent(status.slug)}/status`, {
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const next = (await response.json()) as RunStatus;
          if (!cancelled) {
            setStatus(next);
            setStale(false);
          }
        } catch {
          // Keep the last known state on screen. A poll that failed says something
          // about the network, not about the run — and blanking the page would
          // recreate the dead-job impression this page exists to prevent.
          if (!cancelled) setStale(true);
        }
      })();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status.state, status.slug]);

  return (
    <section aria-label="Run progress" aria-live="polite">
      <p>
        <strong>{HEADLINE[status.state]}</strong>
      </p>

      <progress value={status.completed} max={status.total}>
        {status.completed} of {status.total} steps
      </progress>

      <ol>
        {status.steps.map((step) => (
          <li key={step.step}>
            <StepLine step={step} />
          </li>
        ))}
      </ol>

      {status.failure !== undefined && (
        <p role="status">
          {status.failure.retryable
            ? // `brief §2.3`: a retryable failure is a FREE retry, and the word
              // free is the whole message — a customer watching a step go red
              // needs the purchase page's promise kept where they are looking,
              // not restated as a paragraph.
              'Retrying. Free.'
            : 'This one needs a person. Nothing has been charged.'}{' '}
          {status.failure.message}
        </p>
      )}

      {stale && <p role="status">Reconnecting…</p>}
    </section>
  );
}

/** The one line at the top, in the plain register `brief` Part 5 asks for behind the homepage. */
const HEADLINE: Record<RunState, string> = {
  queued: 'Queued. Nothing has started yet.',
  running: 'In the pit.',
  retrying: 'A step failed. Retrying, free.',
  delivered: 'Done. Every cut is in.',
  needs_support: 'Stopped. This one needs a person.',
};

/** What each step is called, in words rather than in the engine's phase names. */
const STEP_LABEL: Record<StepStatus['step'], string> = {
  score: 'The Six take their cuts',
  cluster: 'Finding what it competes with',
  persona: 'The Floor picks',
  rank: 'Working out where it lands',
  deliver: 'Publishing the board',
};

function StepLine({ step }: { step: StepStatus }): React.JSX.Element {
  return (
    <>
      <span>{STEP_LABEL[step.step]}</span> — <span>{STATE_LABEL[step.state]}</span>
      {step.detail !== undefined && (
        <>
          {' '}
          <small>{step.detail}</small>
        </>
      )}
    </>
  );
}

const STATE_LABEL: Record<StepStatus['state'], string> = {
  pending: 'waiting',
  done: 'done',
  // `DECISIONS.md` S11: a skip is a terminal, SUCCESSFUL status, and the word has
  // to say so. "Skipped" alone reads like something went missing.
  skipped: 'complete',
  failed: 'failed',
};
