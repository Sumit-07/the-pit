/**
 * A category board — `brief` Part 6's second surface.
 *
 * "Free, CDN-cached, deduction ledgers expandable per row. Lead with deductions
 * and reasons, not composites. Numeric ratings stay small and secondary."
 *
 * Every part of that is structural here rather than stylistic:
 *
 * - **Free and CDN-cached.** No auth, no session, no fetch. The whole page is one
 *   prerendered document built from one JSON file (`lib/boards/source.ts`), so a
 *   visitor browsing is a cache hit and nothing behind it wakes up.
 * - **Expandable per row.** `<details>`, so the ledger opens with JavaScript off
 *   and the cached HTML is complete on arrival.
 * - **Deductions first.** The row's largest text is a juror's sentence; the
 *   composites are 11px mono at the right-hand edge, and two of the three drop out
 *   below 760px.
 *
 * The footer is the honest half. `brief` Part 5 forbids promising a rank, and
 * `brief §1.2` reshuffles every rank on every placement, so the board carries a
 * timestamp, a product count, the versions it was computed under, its own health
 * numbers, and — for the seeded categories — the provenance caveat verbatim from
 * the run that produced it. A leaderboard that is rebuilt under the reader has to
 * say so.
 */

import type { ReactNode } from 'react';

import { BOARD_LEDE, STAMP_NOTE } from '@/lib/boards/copy';
import { depthOf, n1, n2, stampUtc, type BoardView } from '@/lib/boards/view';
import { BoardHead, BoardRow } from '@/components/board-parts';

/**
 * The panel labels for a category.
 *
 * `brief` Part 4: categories carry a `type`, and it drives panel labels — "B2B
 * boards can say 'The Panel' and 'The Buyers' where consumer boards say 'The Six'
 * and 'The Floor'. Same data, register that fits the room."
 */
export function panelLabels(type: string): { critics: string; buyers: string } {
  return type === 'b2b'
    ? { critics: 'The Panel', buyers: 'The Buyers' }
    : { critics: 'The Six', buyers: 'The Floor' };
}

function StatStrip({ board }: { board: BoardView }): ReactNode {
  return (
    <div className="strip">
      <div>
        <span className="k">Products</span>
        <span className="v">{board.productCount}</span>
      </div>
      <div>
        <span className="k">Ranked on merit alone</span>
        <span className="v solo">
          {board.soloCount} / {board.productCount}
        </span>
      </div>
      <div>
        <span className="k">Moved by demand</span>
        <span className="v tb">
          {board.tiebrokenCount} / {board.productCount}
        </span>
      </div>
      <div>
        <span className="k">Metrics</span>
        <span className="v">{board.metricNames.length}</span>
      </div>
      <div>
        <span className="k">Clusters</span>
        <span className="v">{board.clusterCount}</span>
      </div>
      <div>
        <span className="k">Room</span>
        <span className="v">{board.type}</span>
      </div>
    </div>
  );
}

/**
 * The footer: health, provenance, and the sentence that refuses to promise a rank.
 *
 * `brief` Part 3 asks for `discrimination` and `avg_metric_spread` to be monitored
 * as drift alarms. Publishing them is cheap and it is the difference between a
 * leaderboard and a record.
 */
function BoardFooter({ board }: { board: BoardView }): ReactNode {
  const labels = panelLabels(board.type);
  return (
    <footer className="boardfoot">
      <div className="fgrid">
        <div>
          <span className="k">Discrimination</span>
          <span className="v">{n2(board.health.discrimination)}</span>
        </div>
        <div>
          <span className="k">Demand discrimination</span>
          <span className="v">{n2(board.health.demand_discrimination)}</span>
        </div>
        <div>
          <span className="k">Avg metric spread</span>
          <span className="v">{n1(board.health.avg_metric_spread)}</span>
        </div>
        <div>
          <span className="k">Solo clusters</span>
          <span className="v solo">
            {board.soloCount} / {board.productCount}
          </span>
        </div>
        <div>
          <span className="k">Tiebroken</span>
          <span className="v tb">{board.health.tiebreak_count}</span>
        </div>
      </div>

      <div className="caveat">
        <div className="sect">Where these scores came from</div>
        <p>
          {board.caveat ??
            'This run stored no seeding provenance. Treat its absolute score levels as unverified.'}
        </p>
      </div>

      <p className="stamp">
        <b>{board.category}</b> &middot; {board.productCount} products &middot; ranked{' '}
        {stampUtc(board.generatedAt)}
        <br />
        prompt {board.promptVersion} &middot; demand {board.demandVersion} &middot; uniqueness{' '}
        {board.uniquenessVersion} &middot; category snapshot {board.categoryVersion}
        {board.engineVersion === undefined ? '' : ` · engine ${board.engineVersion}`}
        <br />
        weights: merit {board.weights.merit}, demand {board.weights.demand}, uniqueness lambda{' '}
        {board.weights.uniqueness_lambda}
        <br />
        {labels.buyers}: {board.personas.join(' · ')}
        <br />
        {STAMP_NOTE}
      </p>
    </footer>
  );
}

/** The whole board, head to footer. */
export function CategoryBoard({ board }: { board: BoardView }): ReactNode {
  const labels = panelLabels(board.type);
  return (
    <>
      <div className="head">
        <span className="sh">The board</span>
        <h1>{board.category}</h1>
        <p className="headsub">
          Everyone walked in at 100. <b>{board.productCount} products</b> walked out with less.{' '}
          {BOARD_LEDE}
        </p>
      </div>

      <StatStrip board={board} />

      <p className="legend">
        <b>Cuts</b> is 100 minus the mean metric score &mdash; every product walks in at 100 in front of{' '}
        {labels.critics}, and this is what came off. The points inside a ledger are each juror&rsquo;s own
        deduction off their own 100, so six jurors cutting 20 for the same omission is one 20-point cut on
        the board, not 120.
        <br />
        <b>Solo cluster</b> (gold edge) means nobody from {labels.buyers} was ever shown this product beside
        a substitute, so its rank is merit alone. <b>Moved</b> means demand and scarcity pulled the row off
        its pure-merit position.
      </p>

      <div className="board">
        <BoardHead set="board" />
        <div>
          {board.rows.map((row, index) => (
            <BoardRow
              row={row}
              depth={depthOf(index, board.rows.length)}
              first={index === 0}
              key={`${row.rank}-${row.name}`}
            />
          ))}
        </div>
      </div>

      <BoardFooter board={board} />
    </>
  );
}
