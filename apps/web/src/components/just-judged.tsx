/**
 * "Just judged" — the strip of what most recently came out of the pit.
 *
 * `brief` Part 6: "Motion comes from *rotating categories and arriving
 * verdicts*." The rotation has been on the page since it shipped; the arrivals
 * had nowhere to arrive. A placement is scored and published within minutes and
 * the board rebuilds under it, and until this strip existed a visitor had no way
 * to see that anything had happened at all.
 *
 * ## `DECISIONS.md` S14 is why this is a row of cards and not a table
 *
 * The feed is cross-category, and `01 §9` rule 2 forbids a cross-category
 * leaderboard. The resolution — recorded in `DECISIONS.md` and implemented in
 * `lib/boards/recent.ts` — is that the feed is ordered by TIME and by nothing
 * else, and that each row carries its own category with the rank it was stamped
 * with at delivery.
 *
 * That decision is what shapes this markup, in three ways:
 *
 * 1. **Cards, not rows in a table.** A column of ranks is a leaderboard whatever
 *    the header says. Six cards each holding its own `#12 / 49 · Developer Tools`
 *    cannot be read down; there is nothing to read down.
 * 2. **The category is inside the stamp, not beside it.** `#12 / 49` never
 *    appears without the board it is a rank on, so the number cannot be lifted
 *    off the card and compared with the one next to it.
 * 3. **No control sorts it.** There is no header to click, no `orderBy` reaching
 *    the query (`createPostgresRecentVerdicts` takes none), and no second
 *    ordering anywhere in the module that feeds this.
 *
 * The page does not explain any of that. It says "just judged" and prints what
 * came out.
 *
 * ## The signature, and the one thing removed from it
 *
 * Every card ends on a two-pixel health line: teal for what survived, recess for
 * what came off. That is the board's cut meter reduced to its single claim —
 * everyone walks in at 100, this is what is left — and it is the element that
 * makes a card belong to this site rather than to any other feed. What was tried
 * and taken off again was the full segmented meter: at card width the segments
 * are two pixels each, unreadable, and six of them across a row read as texture.
 * One block, one number beside it, and the whole decomposition one click away.
 *
 * ## Motion
 *
 * The hover lift the board rows already use, and nothing else. No autoplay, no
 * marquee, no pulsing dot. `brief` Part 6 wants motion from arriving verdicts —
 * an arrival is the card appearing, which is a page load, not an animation.
 *
 * ## Scrolling
 *
 * One row, `overflow-x: auto`, scroll-snap on the card edge. On a phone the same
 * row swipes, with the next card deliberately half in frame so the gesture is
 * discoverable without a caption telling anyone to swipe. Keyboard users get
 * every card as a link in tab order, and the scroller is focusable so it can be
 * driven with arrow keys.
 */

import type { CSSProperties, ReactNode } from 'react';

import { relativeTime, stampLine, type RecentVerdict } from '@/lib/boards/recent';
import { metricLabel } from '@/lib/boards/view';
import { RowMark } from '@/components/board-parts';

export interface JustJudgedProps {
  cards: readonly RecentVerdict[];
  /** `wide` is the board index, which has the full column to spend. */
  width?: 'home' | 'wide';
  /**
   * The clock the relative stamps are measured against.
   *
   * Passed in rather than read here so the server and any test agree on one
   * instant across all six cards — six calls to `new Date()` during one render
   * can straddle a minute boundary and print two different labels for one
   * delivery.
   */
  now?: Date;
}

export function JustJudged({ cards, width = 'home', now }: JustJudgedProps): ReactNode {
  if (cards.length === 0) return null;
  const clock = now ?? new Date();

  return (
    <section className={width === 'wide' ? 'justwrap wide' : 'justwrap'}>
      <div className="railhead">
        <span className="sh">Just judged</span>
        {/*
          The stamp, named once for the whole strip. Not an argument for the
          ordering — a label on the number, so nobody reads `#12` as a position in
          this row.

          It read `#rank when judged · newest first` and the second half came off:
          at 390 the two labels filled the row edge to edge with nothing between
          them, and "just judged" already says the feed is recent. The half worth
          keeping is the one that qualifies a number.
        */}
        <span className="sh">#rank when judged</span>
      </div>
      <ul className="juststrip" tabIndex={0} aria-label="Recently judged products">
        {cards.map((card) => (
          <li className="justcard" key={`${card.categorySlug}-${card.href}-${card.rank}`}>
            <a href={card.href}>
              <span className="justname">
                <RowMark row={card} />
                <b>{card.name}</b>
                {card.isNew ? (
                  <span className="tag new" title="Delivered in the last seven days.">
                    new
                  </span>
                ) : null}
              </span>

              {/*
                The stamp. `brief` Part 5 forbids promising a rank, so the rank is
                only ever printed with the board it was a rank ON and the size of
                that board — and the `title` says the rest of the sentence.
              */}
              <span className="juststamp" title={stampLine(card)}>
                <b>#{card.rank}</b>
                <span className="of">/ {card.productCount}</span>
                <i>{card.category}</i>
              </span>

              {/*
                The reason and the juror are two elements, not one, and the reason
                is the only one that clamps.

                They started as one clamped block and the juror was the line the
                clamp ate: a three-line reason filled the box and `The Terminal
                Minimalist · Problem…` was what came out the bottom. `brief`
                Part 6 requires every deduction to show the juror who took it, so
                the attribution is the one part of a cut that may never be
                truncated to fit. Long prose loses its tail; the name never does.
              */}
              <span className="justcut">
                {card.cut === null ? (
                  'nothing came off this card'
                ) : (
                  <>
                    <span className="pts">&minus;{card.cut.points}</span> {card.cut.reason}
                  </>
                )}
              </span>
              {card.cut === null ? null : (
                <span className="justwho">
                  {card.cut.role} &middot; {metricLabel(card.cut.metric)}
                </span>
              )}

              <span className="justfoot">
                {/* The mechanic, at two pixels. `aria-hidden` because the figure
                    beside it is the same fact in text. */}
                <span className="justmeter" aria-hidden="true">
                  <i style={{ '--held-w': `${Math.max(0, Math.min(100, card.health))}%` } as CSSProperties} />
                </span>
                <span className="justheld">
                  <b>{Math.round(card.health)}</b> health left
                </span>
                <time dateTime={card.deliveredAt}>{relativeTime(card.deliveredAt, clock)}</time>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
