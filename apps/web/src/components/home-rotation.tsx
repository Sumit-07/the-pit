'use client';

/**
 * The homepage's one clock.
 *
 * `brief` Part 6: "Categories auto-rotate every 7s with a progress bar." That
 * rotation used to be private state inside `<HomeBoard>`, which was correct while
 * the board was the only thing that rotated. The hero's verdict card follows the
 * same rail — the card in the hero and the board below it must always be the same
 * category, or the page is showing two answers to "which board is this" — so the
 * timer moved up here and both surfaces read it.
 *
 * A context and not a prop drilled through the page because the two consumers are
 * not siblings: the card is inside `.hero` and the board is several sections
 * below it, with server-rendered markup in between. `page.tsx` stays a server
 * component and passes that markup through as `children`.
 *
 * ## What is NOT in here
 *
 * The boards themselves. This provider carries an index, a cycle counter and one
 * boolean; every consumer already has its own data. A provider holding the boards
 * would put them in the hydration payload a third time.
 *
 * ## Reduced motion
 *
 * `prefers-reduced-motion: reduce` stops the rotation entirely, not just the
 * transition on it — a board that silently swapped category every seven seconds
 * with no animation would be worse for the person who asked for less motion, not
 * better. The category buttons still work, so nothing becomes unreachable. The
 * check runs in an effect rather than during render because the server has no
 * media query, and a first paint that disagreed with the server's would be a
 * hydration mismatch on the most visible element on the site.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** `brief` Part 6: "Categories auto-rotate every 7s". */
export const ROTATE_MS = 7000;

export interface Rotation {
  /** Index into the rail's boards. Zero on the server, and on the first paint. */
  readonly current: number;
  /**
   * Bumped on every switch, manual or automatic, so a CSS animation keyed on it
   * restarts even when the index happens to repeat.
   */
  readonly cycle: number;
  /** False until the browser says motion is welcome. Nothing rotates while it is false. */
  readonly animate: boolean;
  /** How many boards there are to rotate between. */
  readonly count: number;
  select(index: number): void;
}

const RotationContext = createContext<Rotation>({
  current: 0,
  cycle: 0,
  animate: false,
  count: 0,
  select: () => {},
});

export function useRotation(): Rotation {
  return useContext(RotationContext);
}

export function HomeRotation({ count, children }: { count: number; children: ReactNode }): ReactNode {
  const [current, setCurrent] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [animate, setAnimate] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => setAnimate(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!animate || count < 2) return;
    timer.current = setTimeout(() => {
      setCurrent((index) => (index + 1) % count);
      setCycle((value) => value + 1);
    }, ROTATE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [animate, count, cycle]);

  const value: Rotation = {
    current,
    cycle,
    animate,
    count,
    select: (index: number) => {
      setCurrent(index);
      setCycle((value_) => value_ + 1);
    },
  };

  return <RotationContext.Provider value={value}>{children}</RotationContext.Provider>;
}
