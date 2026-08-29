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
 * - The rotation is on a timer the board owns. It moves on its own schedule, and
 *   the progress bar shows the schedule so the movement is never a surprise.
 *
 * ## Reduced motion
 *
 * `prefers-reduced-motion: reduce` stops the rotation entirely, not just the
 * animation on it — a board that silently swapped category every seven seconds
 * with no transition would be worse for the person who asked for less motion, not
 * better. The category buttons still work, so nothing becomes unreachable. The
 * check runs in an effect rather than during render because the server has no
 * media query, and a first paint that disagreed with the server's would be a
 * hydration mismatch on the most visible element on the site.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { HOME_LEGEND } from '@/lib/boards/copy';
import type { HomeBoard as HomeBoardData, TickerLine } from '@/lib/boards/home';
import { depthOf, rank2, stampUtc } from '@/lib/boards/view';
import { BoardHead, RowLead, RowNumbers } from '@/components/board-parts';

/** `brief` Part 6: "Categories auto-rotate every 7s". */
const ROTATE_MS = 7000;
/** How often a line joins the strip of cuts under the board. */
const TICK_MS = 3200;
/** How many lines the strip holds before the oldest falls off. */
const TICK_ROWS = 5;

export interface HomeBoardProps {
  boards: readonly HomeBoardData[];
  ticker: readonly TickerLine[];
}

export function HomeBoard({ boards, ticker }: HomeBoardProps): ReactNode {
  const [current, setCurrent] = useState(0);
  // Bumped on every switch, manual or automatic, so the progress bar's CSS
  // animation restarts even when the category index happens to repeat.
  const [cycle, setCycle] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [tick, setTick] = useState(0);
  const rotate = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => setAnimate(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!animate || boards.length < 2) return;
    rotate.current = setTimeout(() => {
      setCurrent((index) => (index + 1) % boards.length);
      setCycle((value) => value + 1);
    }, ROTATE_MS);
    return () => {
      if (rotate.current !== null) clearTimeout(rotate.current);
    };
  }, [animate, boards.length, cycle]);

  useEffect(() => {
    if (!animate || ticker.length < 2) return;
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [animate, ticker.length]);

  const board = boards[current];
  if (board === undefined) return null;

  const select = (index: number): void => {
    setCurrent(index);
    setCycle((value) => value + 1);
  };

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
          The progress bar is the rotation's own clock, made visible. Its `key`
          restarts the 7s fill on every switch; without `animate` it never fills,
          because without `animate` nothing rotates.
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
        <div key={board.slug}>
          {board.rows.map((row, index) => (
            <div
              className={index === 0 ? 'brow first' : 'brow'}
              style={{ animationDelay: animate ? `${index * 45}ms` : '0ms' }}
              key={`${row.rank}-${row.name}`}
            >
              <span className="rowhead" style={{ '--depth': depthOf(index, board.rows.length) } as CSSProperties}>
                {row.soloCluster ? <span className="flag" aria-hidden="true" /> : null}
                <span className="rk">{rank2(row.rank)}</span>
                <RowLead row={row} />
                <RowNumbers row={row} set="home" />
              </span>
            </div>
          ))}
        </div>
        <div className="bfoot">
          <span>
            {board.soloCount} of {board.productCount} faced no substitute and rank on merit alone
          </span>
          {/* A literal ↗, not `&nearr;`: the JSX transform does not carry that entity. */}
          <a href={`/boards/${board.slug}`}>full board &middot; every cut ↗</a>
        </div>
        <p className="legend">
          {HOME_LEGEND} Ranked {stampUtc(board.generatedAt)}.
        </p>
      </div>

      <div className="tickwrap">
        <div className="railhead">
          <span className="sh">Cuts on the record</span>
          <span className="sh">nothing here is a rank</span>
        </div>
        <ul className="tick">
          {Array.from({ length: Math.min(TICK_ROWS, ticker.length) }, (_, offset) => {
            const line = ticker[(tick + offset) % ticker.length];
            if (line === undefined) return null;
            return (
              <li key={`${tick + offset}`}>
                <b>{line.product}</b> &middot; {line.category} &middot; <span className="d">&minus;{line.points}</span>{' '}
                &middot; {line.reason} &mdash; {line.role}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
