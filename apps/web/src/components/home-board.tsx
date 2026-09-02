'use client';

/**
 * The homepage board — `brief` Part 6's first surface.
 *
 * "The board occupies most of the page, above the fold on mobile. Categories
 * auto-rotate every 7s with a progress bar; rows stagger in on switch. Rows darken
 * as they descend (the pit is literal). Motion comes from *rotating categories and
 * arriving verdicts*, never from rank churn."
 *
 * Every clause of that is implemented literally, and the last one is a
 * prohibition worth spelling out. `brief §1.2`: appending a product shifts the
 * population mean and standard deviation, so **every** existing z-score changes
 * and ranks reshuffle on every placement. A board that animated rows sliding past
 * each other would be turning that instability into the product's most eye-catching
 * feature — and it would be doing it with a number that moved because someone else
 * paid, not because this product got worse. So:
 *
 * - Rows animate **on category switch**, keyed by the category, and at no other
 *   time. The `rise` keyframe is a stagger-in, not a reorder.
 * - The board's contents come from a snapshot that was fixed when it was
 *   published. Nothing here polls, re-sorts or re-ranks, so there is no rank change
 *   for a browser to notice in the first place.
 * - The rotation is on a timer, and the progress bar shows that timer, so the
 *   movement is never a surprise. The timer itself now lives one level up in
 *   `<HomeRotation>`: the hero's verdict card reads the same index, and a card
 *   and a board showing two different categories would be the page contradicting
 *   itself above and below the fold. Reduced motion is handled there too.
 *
 * ## The one animation that is new
 *
 * Each row's health bar draws itself in: the teal head starts at a full hundred
 * and falls to what survived, and the metric blocks land behind it, staggered
 * 40ms a row. That is the page's own mechanic performed once — every product
 * walks in at 100 and the cuts come off — and it is the one motion here that is
 * about the content rather than about the furniture. It is pure CSS driven by
 * `--draw-delay` (`pit.css`), so it costs nothing at runtime and disappears
 * entirely under `prefers-reduced-motion: reduce`.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { HEALTH_NOTE, HOME_LEGEND } from '@/lib/boards/copy';
import type { HomeBoard as HomeBoardData, HomeRow, TickerLine } from '@/lib/boards/home';
import { depthOf, metricLabel, stampUtc } from '@/lib/boards/view';
import { BoardHead, CutMeter, RankCell, RowLead, RowNumbers } from '@/components/board-parts';
import { useRotation } from '@/components/home-rotation';

/** How often a line joins the strip of cuts under the board. */
const TICK_MS = 3200;
/** How many lines the strip holds before the oldest falls off. */
const TICK_ROWS = 5;

export interface HomeBoardProps {
  boards: readonly HomeBoardData[];
  ticker: readonly TickerLine[];
  /** The largest single deduction on any board, from `boardStats`. */
  deepest: number;
}

/**
 * One row of the homepage board, and the whole row is the link.
 *
 * The board's job is to make a reader want a verdict, and until this was an
 * anchor the eight most visible rows on the site were the only ones with no way
 * into the thing they advertise: the name was text, the reason was text, and the
 * only link on the surface was "full board" in the footer. A row that reads like
 * a card and cannot be clicked is a dead end a reader blames themselves for.
 *
 * The anchor wraps the whole `.rowhead` rather than just the name, because the
 * target on a phone is the row and not the fifteen pixels of a product's title.
 * `RowLedger`'s own verdict link on the category board is unaffected — that
 * surface is a `<details>` and its summary already has a job.
 *
 * A row whose product has no verdict yet falls back to its category board, which
 * is where its ledger is written out in full. There is no state here in which the
 * row is inert.
 */
function HomeRowLink({
  row,
  slug,
  children,
}: {
  row: HomeRow;
  slug: string;
  children: ReactNode;
}): ReactNode {
  return (
    <a className="rowlink" href={row.verdictHref ?? `/boards/${slug}`}>
      {children}
    </a>
  );
}

export function HomeBoard({ boards, ticker, deepest }: HomeBoardProps): ReactNode {
  // The rail's clock lives one level up, in `<HomeRotation>`, because the hero's
  // verdict card reads the same index — the card and the board must never be two
  // different categories.
  const { current, cycle, animate, select } = useRotation();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate || ticker.length < 2) return;
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [animate, ticker.length]);

  const board = boards[current];
  if (board === undefined) return null;

  return (
    <>
      <div className="rail">
        <div className="railhead">
          <span className="sh">The boards</span>
          <span className="sh">
            {board.productCount} products &middot; {board.soloCount} on merit alone
          </span>
        </div>
        <div className="cats" role="tablist" aria-label="Category boards">
          {boards.map((entry, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={index === current}
              className={index === current ? 'cat on' : 'cat'}
              onClick={() => select(index)}
              key={entry.slug}
            >
              {entry.category}
            </button>
          ))}
        </div>
        {/*
          The progress bar is the rotation's own clock, made visible, and it is
          drawn as the board's top edge — the same visual verb as the cut meter
          inside every row, so the page has one grammar for a line being consumed.
          Its `key` restarts the 7s fill on every switch; without `animate` it
          never fills, because without `animate` nothing rotates.
        */}
        <div className="prog" aria-hidden="true">
          <i className={animate && boards.length > 1 ? 'run' : ''} key={`${current}-${cycle}`} />
        </div>
      </div>

      <div className="board">
        <BoardHead set="home" />
        {/*
          Keyed by category: switching remounts the rows, which replays the
          stagger. Nothing keyed by rank, because nothing here reacts to a rank
          moving.
        */}
        {/*
          `drawin` is on the FIRST board only — `cycle` counts switches, so it is
          zero exactly until the rail moves or a reader picks a category. The
          health bars draw themselves in once, on arrival, and a rotation after
          that gets the row stagger `brief` Part 6 asks for and nothing more: a
          board that re-performed every bar every seven seconds would be
          advertising the animation rather than the mechanic.
        */}
        <div className={cycle === 0 ? 'boardrows drawin' : 'boardrows'} key={board.slug}>
          {board.rows.map((row, index) => (
            <div
              className={index === 0 ? 'brow first' : 'brow'}
              style={
                {
                  animationDelay: animate ? `${index * 45}ms` : '0ms',
                  // The health bar's own stagger, 40ms a row: the teal head draws
                  // down from a full hundred to what survived and the metric
                  // blocks land behind it, so the board arrives showing the cuts
                  // being taken rather than the state after them. CSS only, off
                  // under `prefers-reduced-motion` — `pit.css` carries both.
                  '--draw-delay': `${index * 40}ms`,
                } as CSSProperties
              }
              key={`${row.rank}-${row.name}`}
            >
              <HomeRowLink row={row} slug={board.slug}>
                <span
                  className="rowhead"
                  style={
                    {
                      '--depth': depthOf(index, board.rows.length),
                    } as CSSProperties
                  }
                >
                  {row.soloCluster ? <span className="flag" aria-hidden="true" /> : null}
                  <RankCell row={row} />
                  <RowLead row={row} />
                  <CutMeter row={row} />
                  <RowNumbers row={row} set="home" />
                </span>
              </HomeRowLink>
            </div>
          ))}
        </div>
        <div className="bfoot">
          <span>
            {board.soloCount} of {board.productCount} ranked on merit alone
          </span>
          {/* A literal ↗, not `&nearr;`: the JSX transform does not carry that entity. */}
          <a href={`/boards/${board.slug}`}>full board &middot; every cut ↗</a>
        </div>
        <p className="legend">
          {HOME_LEGEND} {HEALTH_NOTE} Ranked {stampUtc(board.generatedAt)}.
        </p>
      </div>

      {/*
        The canvas's LIVE CUTS panel, with the word LIVE taken off it.
        `brief` Part 6 wants motion from "rotating categories and arriving
        verdicts", and there are no arriving verdicts to show: checkout is wired
        but nothing has landed, and a pulsing dot over a fabricated stream of
        arrivals is the one dishonest thing available on a page whose whole claim
        is that the board cannot be bought.
        So the panel keeps the canvas's SHAPE — the deduction as a large figure in
        its own column, the pairing as a mono label above, the sentence quoted
        underneath — and fills it with cuts that were actually taken, by jurors
        who are actually named, on products that are actually on the board one
        click away. The heading says which of those two things it is.
      */}
      <div className="tickwrap">
        <div className="railhead">
          <span className="sh">Cuts on the record</span>
          <span className="sh">deepest so far &minus;{deepest}</span>
        </div>
        <ul className="tick">
          {Array.from({ length: Math.min(TICK_ROWS, ticker.length) }, (_, offset) => {
            const line = ticker[(tick + offset) % ticker.length];
            if (line === undefined) return null;
            return (
              <li key={`${tick + offset}`}>
                <span className="d">&minus;{line.points}</span>
                <span className="t">
                  <span className="who">
                    {line.role} &middot; {metricLabel(line.metric)}
                  </span>
                  <span className="q">{line.reason}</span>
                  <a className="on" href={`/boards/${line.slug}`}>
                    {line.product} <i>&middot; {line.category}</i>
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
