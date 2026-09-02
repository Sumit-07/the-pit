'use client';

/**
 * The right half of the hero: whoever is #1 on the board the rail is showing.
 *
 * The hero was a headline and four hundred pixels of empty slab. The honest thing
 * to put in that space is not an illustration of a product — it is a product: the
 * current leader of the current category, wearing the same health bar every row
 * on the page wears, with the sharpest thing a juror said about it underneath.
 * The page's claim is that the top of the board cannot be bought; showing the top
 * of the board, cuts and all, is that claim rendered rather than asserted.
 *
 * ## It follows the rail, and it is complete without JavaScript
 *
 * The index comes from `useRotation()` — the same clock the board reads, so the
 * card and the board are never two different categories. Every card is in the
 * document at once, stacked in one grid cell, and only the current one is opaque:
 * that is what makes the change a crossfade rather than a reflow, and it is why
 * the first card is server-rendered complete. A visitor with JavaScript off gets
 * card zero, drawn, linked and readable; the rail simply never advances, which is
 * the same thing `prefers-reduced-motion: reduce` gets.
 *
 * The cards that are not showing are `visibility: hidden` and `aria-hidden`, so
 * a screen reader gets one card and a tab key never lands on a link nobody can
 * see. `pit.css` says why the stack is a grid and not absolute positioning: the
 * hero's height then comes from the tallest card and does not jump when a
 * two-line juror reason follows a one-line one.
 */

import type { CSSProperties, ReactNode } from 'react';

import type { HeroCard } from '@/lib/boards/home';
import { metricLabel, n1 } from '@/lib/boards/view';
import { RowMark, segClass } from '@/components/board-parts';
import { useRotation } from '@/components/home-rotation';

function HeroCardView({ card, on, index }: { card: HeroCard; on: boolean; index: number }): ReactNode {
  const cuts = Math.max(0, Math.min(100, card.cuts));
  const kept = 100 - cuts;
  const count = Math.max(1, card.metrics.length);
  // The board is the fallback destination, not a dead card: a product whose
  // verdict has not been issued still has a row to be read on.
  const href = card.verdictHref ?? `/boards/${card.slug}`;

  return (
    <a
      className={on ? 'herocard on' : 'herocard'}
      href={href}
      aria-hidden={on ? undefined : 'true'}
      tabIndex={on ? undefined : -1}
      // The stagger the bars below the fold get, applied to the one above it, so
      // the hero's bar and the board's read as one gesture rather than two.
      style={{ '--draw-delay': `${120 + index * 40}ms` } as CSSProperties}
    >
      <span className="hcwho">
        <RowMark row={card} />
        <b className="hcname">{card.name}</b>
      </span>
      <span className="hcrank">
        #1 / {card.productCount} &middot; {card.category}
      </span>

      <span className="hcbar" aria-hidden="true">
        <i className="kept" style={{ width: `${kept}%` }} />
        {card.metrics.map((metric, position) => (
          <i
            className={segClass(position)}
            style={{ width: `${Math.max(0, metric.cuts) / count}%` }}
            key={metric.metric}
          />
        ))}
      </span>
      <span className="hccap">
        <b className="held">{Math.round(kept)}</b> of 100 health left &middot; &minus;{n1(cuts)} in cuts
      </span>

      <span className="hccut">
        {card.headline === null ? (
          <span className="who">nothing came off this card</span>
        ) : (
          <>
            <span className="pts">&minus;{card.headline.points}</span> {card.headline.reason}{' '}
            <span className="who">
              {card.headline.role} &middot; {metricLabel(card.headline.metric)}
            </span>
          </>
        )}
      </span>
      <span className="hcgo">Read the verdict &rarr;</span>
    </a>
  );
}

export function HeroVerdict({ cards }: { cards: readonly HeroCard[] }): ReactNode {
  const { current } = useRotation();
  if (cards.length === 0) return null;
  return (
    <div className="herostack">
      <span className="sh hcsh">Currently first</span>
      <div className="hcdeck">
        {cards.map((card, index) => (
          <HeroCardView card={card} on={index === current} index={index} key={card.slug} />
        ))}
      </div>
    </div>
  );
}
