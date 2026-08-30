/**
 * The mark an anonymous product wears.
 *
 * **The generator has landed.** This file was a seam with a placeholder in it;
 * the drawing now comes from `lib/anon/robot.ts`, which is shared with the
 * verdict page. The contract the seam specified is unchanged and is restated
 * below, because every clause of it is still load-bearing.
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
 * - **`seed`** is `ProductIdentity.seed` — the product's designation, e.g.
 *   `Unit Kilo-427`. Stable across re-ranks, which is what makes the robot
 *   stable, and it is what `verdicts.payload` freezes, so a shared verdict link
 *   keeps the avatar it was delivered with. `lib/boards/identity.ts` says why the
 *   name rather than the id.
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
 * ## Why the SVG arrives as a string
 *
 * `robotSvg` returns markup rather than React elements, and this component
 * injects it. That is not laziness about JSX — it is the only way there is ONE
 * generator. `brief` Part 6 makes the verdict page a self-contained HTML
 * document that has to survive being saved to disk, so it is built by string
 * concatenation and cannot render a component. A JSX robot here would mean a
 * second implementation there, drawing the same 768 faces from the same hash,
 * with nothing keeping them in step; the first divergence would be a listing
 * whose avatar changed when a reader followed the link from the board to the
 * verdict, which is precisely the "is this the same product?" question the robot
 * exists to answer.
 *
 * It is the safe kind of `dangerouslySetInnerHTML`: every byte is generated from
 * a closed vocabulary of rects and theme tokens, no product name, URL or juror
 * reason is ever interpolated, and the two attributes that can carry a string are
 * escaped in `robot.ts`. Here, nothing is passed at all — `label` is omitted
 * because the wrapper is `aria-hidden` per the contract above.
 */

import type { ReactNode } from 'react';

import { robotSvg } from '@/lib/anon';

export interface RobotAvatarProps {
  /** `ProductIdentity.seed`. The only input; the same seed must always draw the same robot. */
  seed: string;
  /** Edge length in CSS pixels. The board's mark gutter is 16. */
  size?: number;
}

export function RobotAvatar({ seed, size = 16 }: RobotAvatarProps): ReactNode {
  return (
    <span
      className="favbot"
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: robotSvg(seed, { size }) }}
    />
  );
}
