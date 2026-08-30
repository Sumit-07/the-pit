/**
 * The mark an anonymous product wears. **This file is a seam, not a generator.**
 *
 * The decision it serves is in `lib/boards/identity.ts`: a product submitted
 * anonymously keeps every cut, every reason and every juror in public, and
 * withholds only its name, its URL and its favicon. In place of the favicon it
 * shows a robot drawn deterministically from its product id — the same product,
 * the same robot, every time, so a reader can follow one listing across a board
 * without ever learning who it is.
 *
 * That generator is somebody else's work in progress. What is here is the
 * CONTRACT it plugs into, and it is deliberately minimal so that replacing the
 * body of `RobotAvatar` is the whole integration:
 *
 * - **`seed`** is `ProductIdentity.seed` — the product id as a string. Stable
 *   across re-ranks, which is what makes the robot stable.
 * - **The box is fixed.** Whatever is drawn must fill exactly `size` pixels
 *   square and no more. A row's mark gutter is reserved at 16px whether the row
 *   shows a favicon, a robot or a fallback, so that nothing on the board moves
 *   depending on which of the three a product turned out to have. A generator
 *   that returned a differently-sized element would reintroduce the layout shift
 *   the gutter exists to prevent.
 * - **It is decoration.** The wrapper is `aria-hidden`, because the row already
 *   states the product's pseudonym in text beside it. A generator should not add
 *   a `title`, an `alt` or a label of its own.
 * - **No network, no dependency.** `02 §4` and `brief` Part 3: a board read
 *   computes nothing and fetches nothing. The robot must be produced in-process
 *   from the seed — inline SVG or a `data:` URL built here — and never from an
 *   avatar service.
 *
 * Until the generator lands, this draws a neutral placeholder in the right box,
 * so the three-way branch in `<RowMark>` is live, testable and visibly correct
 * rather than waiting on someone else's file to exist.
 */

import type { ReactNode } from 'react';

export interface RobotAvatarProps {
  /** `ProductIdentity.seed`. The only input; the same seed must always draw the same robot. */
  seed: string;
  /** Edge length in CSS pixels. The board's mark gutter is 16. */
  size?: number;
}

export function RobotAvatar({ seed, size = 16 }: RobotAvatarProps): ReactNode {
  return (
    <span className="favbot" style={{ width: size, height: size }} data-seed={seed}>
      {/*
        A placeholder, not a robot: two eyes and a mouth in the row's own muted
        ink, at the size the real one will be. It borrows neither hue — `--cut`
        is what was taken and `--held` is what survived, and being anonymous is
        neither — for the same reason the named fallback does not.
      */}
      <svg viewBox="0 0 16 16" width={size} height={size} focusable="false" aria-hidden="true">
        <rect x="2.5" y="4.5" width="11" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="6" cy="8.5" r="1" fill="currentColor" />
        <circle cx="10" cy="8.5" r="1" fill="currentColor" />
        <path d="M6 11.2h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        <path d="M8 2.4v2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </span>
  );
}
