/**
 * One nav, one case.
 *
 * The site used to carry four of these. The homepage wrote lowercase mono
 * ("how it works · boards"), the boards index wrote the same words but marked
 * itself with a `<span>`, `/submit` and `/account` wrote Title Case with a third
 * item ("How this works · Boards · Account"), and the verdict page wrote a fourth
 * variant with a status caption where the links go. Four navs is four answers to
 * "what is on this site", and a reader who moves between two of them is told the
 * site changed.
 *
 * So the items live here, once, as data — and there are two renderers over that
 * data rather than two copies of it:
 *
 *   - `<SiteNav>` in `components/site-nav.tsx`, for the surfaces Next renders.
 *   - `renderSiteNav()` below, for the surfaces that have to be self-contained
 *     HTML strings: `/submit`, `/account`, the verdict page.
 *
 * `test/site-nav.test.ts` renders both and asserts the markup is byte-identical,
 * which is the only way two renderers stay one nav.
 *
 * ## The markup is the same on both stylesheets
 *
 * `app/pit.css` styles `.navlink` and `.navr span`; `lib/theme.ts`'s `BASE`
 * styles `.navr a` and sets the mono face on `.navr` itself, so a `<span>` there
 * inherits it. The emitted markup — `<a class="navlink">` for a link, `<span
 * class="navlink">` for the page you are already on — is styled correctly by
 * both without either stylesheet needing a rule added for the other's sake.
 *
 * ## Sign in, and the one item that changes
 *
 * Three items, always, and the third names the door the reader can actually use:
 * `Sign in` when there is no session, `Account` when there is. `/submit` is guest
 * checkout — `brief §2.1`, no login — so the nav never asks anyone to sign in
 * before paying; it is the way back to a purchase already made.
 */

/** The three doors, keyed so a page can say which one it is. */
export type SiteNavKey = 'how-it-works' | 'boards' | 'account';

export interface SiteNavItem {
  readonly key: SiteNavKey;
  readonly href: string;
  readonly label: string;
  /** True when this item names the page it is rendered on: a `<span>`, not a link. */
  readonly current: boolean;
}

export interface SiteNavState {
  /** The page this nav is being rendered on, if it is one of the three. */
  readonly current?: SiteNavKey | undefined;
  /** A session exists, so the third item is `Account` rather than `Sign in`. */
  readonly signedIn?: boolean | undefined;
  /**
   * Absolute origin to prefix every href with.
   *
   * Only the verdict page needs it: that document is downloadable, so a saved
   * copy has to keep working from a `file://` URL, where a root-relative href
   * points at the reader's own disk. Every other surface leaves it unset and
   * emits root-relative paths.
   */
  readonly origin?: string | undefined;
}

/** The wordmark, as its two pieces. `.mark::before` paints the cut beside it. */
export const SITE_WORDMARK = { lead: 'THE ', emphasis: 'PIT' } as const;

/**
 * The items, in order.
 *
 * "How it works" and not "How this works": the nav names a destination, and the
 * page's own heading is where the sentence belongs.
 */
export function siteNavItems(state: SiteNavState = {}): SiteNavItem[] {
  const origin = state.origin ?? '';
  const signedIn = state.signedIn ?? false;
  const items: readonly Omit<SiteNavItem, 'current'>[] = [
    { key: 'how-it-works', href: `${origin}/how-it-works`, label: 'How it works' },
    { key: 'boards', href: `${origin}/boards`, label: 'Boards' },
    signedIn
      ? { key: 'account', href: `${origin}/account`, label: 'Account' }
      : { key: 'account', href: `${origin}/auth/sign-in`, label: 'Sign in' },
  ];
  return items.map((item) => ({ ...item, current: item.key === state.current }));
}

/** The five characters HTML cannot carry raw. Mirrors `escapeHtml` in the string surfaces. */
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The header as a string, for the surfaces that are self-contained documents.
 *
 * Emits exactly what `<SiteNav>` emits. `lib/verdict/page.ts` is the third caller
 * and passes its `origin`, because a downloaded verdict is opened off a disk.
 */
export function renderSiteNav(state: SiteNavState = {}): string {
  const origin = state.origin ?? '';
  const items = siteNavItems(state)
    .map((item) =>
      item.current
        ? `<span class="navlink" aria-current="page">${escape(item.label)}</span>`
        : `<a class="navlink" href="${escape(item.href)}">${escape(item.label)}</a>`,
    )
    .join('');
  return (
    `<nav><a class="mark" href="${escape(origin === '' ? '/' : origin)}">` +
    `${SITE_WORDMARK.lead}<i>${SITE_WORDMARK.emphasis}</i></a>` +
    `<span class="navr">${items}</span></nav>`
  );
}
