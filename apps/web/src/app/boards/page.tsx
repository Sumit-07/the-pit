/**
 * The board index — every category with a published board.
 *
 * Small on purpose. It exists because the homepage's rail rotates and a rotating
 * control is a poor way to find a specific category, and because a board needs a
 * permanent, linkable parent. Like every other read on this surface it is one
 * pass over snapshot JSON: no database, no model, no request-time work.
 *
 * Each card leads with what the category cost its products — the connective word
 * is *cuts*, on this surface as on every other — and states the solo-cluster count
 * as a property of the board rather than burying it.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { defaultBoardSource } from '@/lib/boards/source';
import { stampUtc, toBoardView, type BoardView } from '@/lib/boards/view';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'The boards',
  description: 'Every category, every cut, and the juror who took it.',
};

async function loadBoards(): Promise<BoardView[]> {
  const source = defaultBoardSource();
  const views: BoardView[] = [];
  for (const slug of await source.list()) {
    const document_ = await source.read(slug);
    if (document_ !== undefined) views.push(toBoardView(document_));
  }
  return views.sort((a, b) => b.productCount - a.productCount || a.category.localeCompare(b.category));
}

/**
 * The card's one line of substance, in `brief` Part 5's register: "Runlet took 97
 * in cuts." An empty board is possible — a delivered run with no products would
 * produce one — so the line degrades rather than throwing on `Math.max` of
 * nothing.
 */
function deepestCut(board: BoardView): string {
  const worst = board.rows.reduce<BoardView['rows'][number] | undefined>(
    (deepest, row) => (deepest === undefined || row.cuts > deepest.cuts ? row : deepest),
    undefined,
  );
  if (worst === undefined) return 'No products on this board yet.';
  return `Deepest cut on the board: ${worst.name} took ${Math.round(worst.cuts)} in cuts.`;
}

export default async function Boards(): Promise<ReactNode> {
  const boards = await loadBoards();

  return (
    <div className="wrap">
      <nav>
        <a className="mark" href="/">
          THE <i>PIT</i>
        </a>
        <span className="navr">
          <span className="navlink">boards</span>
        </span>
      </nav>

      <div className="head">
        <span className="sh">The boards</span>
        <h1>Every cut, on the record.</h1>
        <p className="headsub">
          Free to read, and there is nothing to buy on them. Open a category, open a row, and the ledger is
          the whole thing: every deduction, the reason it was taken, and the juror who took it.
        </p>
      </div>

      {boards.length === 0 ? (
        <div className="empty">
          No board has been published yet. A board is written only for a DELIVERED run.
        </div>
      ) : (
        <div className="blist">
          {boards.map((board) => (
            <a className="bcard" href={`/boards/${board.slug}`} key={board.slug}>
              <h2>{board.category}</h2>
              <div className="meta">
                {board.productCount} products &middot; {board.metricNames.length} metrics &middot;{' '}
                {board.clusterCount} clusters &middot; {board.type}
                <br />
                {board.soloCount} ranked on merit alone &middot; ranked {stampUtc(board.generatedAt)}
              </div>
              <p className="lead">{deepestCut(board)}</p>
            </a>
          ))}
        </div>
      )}

      <footer>
        <span>THE PIT</span>
        <span>boards are snapshots &middot; rebuilt on every placement</span>
      </footer>
    </div>
  );
}
