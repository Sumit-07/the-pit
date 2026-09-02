import type { SubmissionStatusView } from '@/lib/pipeline/service';

import { RunProgress } from './run-progress';

/**
 * The buyer's status page, as a document.
 *
 * Separated from the route for the same reason `lib/verdict/page.ts` and
 * `lib/checkout/page.ts` are: the route resolves a run out of a database and
 * decides who may see it, and this renders one. Only the second half can be
 * asserted on, and it is the half `brief` Part 6 is about.
 *
 * It renders inside the site shell — `.wrap`, the nav, the palette in `pit.css`
 * — because a customer who has just paid five dollars should land somewhere that
 * looks like the thing they bought it from. The version it replaced was a bare
 * `<main><h1>` with no nav and no styling.
 */

/**
 * Usually about two minutes.
 *
 * Three sequential rounds of model calls: six jurors at once, then one
 * clustering pass, then the Floor. The two arithmetic steps buy nothing. Said
 * once, at the top, and never repeated beside a step — a wait restated on every
 * line reads as an apology.
 */
export const EXPECTED_WAIT = 'Usually about two minutes.';

export function RunStatusPage({
  view,
  token,
}: {
  view: SubmissionStatusView;
  token?: string | undefined;
}): React.JSX.Element {
  // Both halves, deliberately. A `delivered` state with no verdict row is a run
  // whose board is published and whose settlement has not landed; there is
  // nothing to link to yet, and a dead link is worse than a moment more waiting.
  const verdict = view.status.state === 'delivered' && view.verdictSlug !== null ? view.verdictSlug : null;

  return (
    <div className="wrap runstatus">
      <nav>
        <a className="mark" href="/">
          THE <i>PIT</i>
        </a>
        <span className="navr">
          <a className="navlink" href="/how-it-works">
            how it works
          </a>
          <a className="navlink" href="/boards">
            boards
          </a>
        </span>
      </nav>

      <div className="head">
        <span className="sh">Your run</span>
        <h1>{view.name}</h1>
        <p className="headsub">
          In <b>{view.categorySlug}</b>. {EXPECTED_WAIT}
        </p>
      </div>

      {verdict !== null && (
        <div className="verdictout">
          <a className="cta" href={`/v/${verdict}`}>
            Read your verdict
          </a>
          <span className="terms">Everyone walks in at 100. Fewest cuts wins.</span>
        </div>
      )}

      {/*
        The initial state is the server's reconstruction, not an empty shell.
        That single prop is what makes a mid-run reload land on live progress.
      */}
      <RunProgress initial={view.status} submissionId={view.submissionId} token={token} />

      <div className="blk">
        <div className="sect">Your account</div>
        <p>
          The link on your receipt reaches every verdict you have bought.{' '}
          <a href="/auth/sign-in">Lost it?</a>
        </p>
      </div>

      <footer>
        <span>THE PIT</span>
        <span>boards are snapshots &middot; rebuilt on every placement</span>
      </footer>
    </div>
  );
}
