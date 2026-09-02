/**
 * The site header, for the surfaces Next renders.
 *
 * A plain server component with no state and no client bundle: it is the first
 * thing in the document on every page, and a header that waits for hydration to
 * appear is a header that shifts the page under the reader's eye.
 *
 * The items come from `lib/site/nav.ts`, which is also what `/submit`,
 * `/account` and the verdict page render from — see that module's header for why
 * there are two renderers and only one nav. `test/site-nav.test.ts` asserts the
 * two produce identical markup.
 *
 * ## Which item is "you are here"
 *
 * `layout.tsx` renders this once for every page and a layout cannot know the
 * route, so the current item is marked in CSS instead of in JavaScript: a page
 * puts `data-page` on its own `.wrap`, and the appended block in `pit.css`
 * matches it with `body:has([data-page="boards"])`. That keeps the header out of
 * the client bundle entirely, and a browser without `:has()` gets three plain
 * links, which is the same nav minus one cue.
 *
 * The `current` prop is still here, and it is what the string renderer uses:
 * `/submit` and `/account` build their own documents and know exactly which page
 * they are.
 */

import type { ReactNode } from 'react';

import { siteNavItems, type SiteNavState } from '@/lib/site/nav';

export function SiteNav(state: SiteNavState = {}): ReactNode {
  const origin = state.origin ?? '';
  return (
    <nav>
      <a className="mark" href={origin === '' ? '/' : origin}>
        THE <i>PIT</i>
      </a>
      <span className="navr">
        {siteNavItems(state).map((item) =>
          item.current ? (
            <span className="navlink" aria-current="page" key={item.key}>
              {item.label}
            </span>
          ) : (
            <a className="navlink" href={item.href} key={item.key}>
              {item.label}
            </a>
          ),
        )}
      </span>
    </nav>
  );
}
