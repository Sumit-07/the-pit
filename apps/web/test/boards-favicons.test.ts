/**
 * The mark beside a product's name, on the surfaces that draw it.
 *
 * A board row can be in one of three states, and the tests are organised around
 * the fact that all three have to look deliberate and occupy the same space:
 *
 * 1. **Named, with a stored icon** — its favicon, from the board's one `<style>`
 *    block, with no request of any kind at render.
 * 2. **Named, with nothing usable at its site** — its initial. This is roughly a
 *    third of a real board, so it is the common case rather than an edge, and a
 *    blank gap there would read as a page that failed.
 * 3. **Anonymous** — a robot, and *never* a favicon. A favicon is a trademark at
 *    sixteen pixels; showing one beside a pseudonym identifies the product
 *    completely. That one is a privacy test, not a layout test, and it is
 *    written as a search of the whole rendered document rather than as an
 *    assertion about a component's props.
 *
 * The other half of the file is about the two things this feature must not have
 * done to a board read: put a network request on it, or put the icon bytes into
 * the page twice.
 */

import type { Ranking } from '@the-pit/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CategoryBoard } from '@/components/category-board';
import { RobotAvatar } from '@/components/robot-avatar';
import { faviconClass, faviconInitial, pickFaviconCss, type StoredFavicon } from '@/lib/boards/favicon';
import { toHomeBoard } from '@/lib/boards/home';
import type { BoardDocument } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';
import { sampleRanking } from './helpers/boards';

const ASHGROVE = 'https://ashgrove.example/';
const RUNLET = 'https://runlet.example/';

/** A stored icon whose base64 is recognisable in the output. */
function storedIcon(data: string, overrides: Partial<StoredFavicon> = {}): StoredFavicon {
  return {
    source: 'https://ashgrove.example/favicon.ico',
    format: 'png',
    mime: 'image/png',
    width: 32,
    height: 32,
    bytes: 24,
    weight: 40,
    data,
    fetchedAt: '2026-08-30T12:00:00.000Z',
    ...overrides,
  };
}

function boardDocument(
  icons: Record<string, StoredFavicon> = {},
  ranking = sampleRanking(),
  anonymousIds: readonly number[] = [],
): BoardDocument {
  return {
    slug: 'developer-tools',
    category: 'Developer Tools',
    generatedAt: '2026-08-29T14:05:00.000Z',
    productCount: ranking.ranking.length,
    categoryVersion: 'v2',
    origin: 'seeded-run',
    anonymousIds,
    ranking,
    favicons: {
      version: 2,
      slug: 'developer-tools',
      updatedAt: '2026-08-30T12:00:00.000Z',
      icons,
      misses: {},
    },
  };
}

const render = (document_: BoardDocument): string =>
  renderToStaticMarkup(createElement(CategoryBoard, { board: toBoardView(document_) }));

/**
 * The engine ids of the rows at these URLs, which is how a board document names
 * its anonymous listings.
 *
 * A set of ids on the document rather than a flag on the row, because by the time
 * a surface sees a ranking the identity has already been REMOVED from it — the
 * row's `name` is a designation and its `url` is `''`, so there is no row field
 * left that could say "this one used to be Ashgrove". `lib/boards/identity.ts`
 * carries the argument.
 */
function anonymousIdsFor(ranking: Ranking, ...urls: string[]): number[] {
  return ranking.ranking.filter((row) => urls.includes(row.url)).map((row) => row.id);
}

// -------------------------------------------------------- the three states

describe('a named product with a stored icon', () => {
  it('wears the icon as a class, and the bytes appear once in a style block', () => {
    const icon = storedIcon('QUFBQmJiYmJjY2Nj');
    const html = render(boardDocument({ [ASHGROVE]: icon }));

    const name = faviconClass(icon);
    expect(html).toContain(`.${name}{background-image:url("data:image/png;base64,QUFBQmJiYmJjY2Nj")}`);
    expect(html).toContain(`class="fav favimg ${name}"`);
    // The bytes are in the document exactly once. That is the whole reason the
    // icon is a class and not an `<img src>` — see `faviconClass`.
    expect(html.split('QUFBQmJiYmJjY2Nj')).toHaveLength(2);
  });

  it('makes no network request of any kind at render', () => {
    const html = render(boardDocument({ [ASHGROVE]: storedIcon('QUFBQg==') }));

    // No hotlink to the product's own host, no proxy, no lazy loader. A board
    // is 48 rows; hotlinking would be 48 third-party requests per page view,
    // each telling a stranger who is reading their row.
    expect(html).not.toContain('src="https://ashgrove.example/favicon.ico');
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    expect(html).not.toContain('loading="lazy"');
    // The only URL scheme any icon uses is `data:`.
    for (const match of html.matchAll(/url\("([^"]*)"\)/g)) {
      expect(match[1]).toMatch(/^data:image\//);
    }
  });

  it('declares only the MIME its own bytes are, never one the record claims', () => {
    // A hand-edited index saying `image/svg+xml` over PNG bytes must not be able
    // to announce an SVG: a `data:` URL renders in this origin.
    const html = render(
      boardDocument({ [ASHGROVE]: storedIcon('QUFBQg==', { mime: 'image/svg+xml' } as Partial<StoredFavicon>) }),
    );

    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('svg+xml');
  });

  it('emits one rule for an icon two products share', () => {
    const shared = storedIcon('c2hhcmVkYnl0ZXM=');
    const html = render(boardDocument({ [ASHGROVE]: shared, [RUNLET]: { ...shared } }));

    expect(html.split('c2hhcmVkYnl0ZXM=')).toHaveLength(2);
    // But both rows wear it.
    expect(html.split(`class="fav favimg ${faviconClass(shared)}"`)).toHaveLength(3);
  });

  it('leaves the style block out entirely when no row has an icon', () => {
    const html = render(boardDocument({}));
    expect(html).not.toContain('background-image');
  });
});

describe('a named product with no icon', () => {
  it('reserves exactly the same box, and fills it with the product’s initial', () => {
    const withIcon = render(boardDocument({ [ASHGROVE]: storedIcon('QUFBQg==') }));
    const without = render(boardDocument({}));

    // The gutter is present in both. A gutter that appeared only for rows that
    // resolved would shift every name on the board depending on whether a
    // stranger's server answered — the thing `/submit`'s URL field already
    // learned about its own icon slot.
    expect(withIcon).toContain('class="fav');
    expect(without).toContain('class="fav');
    expect(without).toContain('<span class="favmark">A</span>');
    // Ashgrove's row has a mark in both renders, and the same number of them.
    expect(gutters(withIcon)).toBe(gutters(without));
  });

  it('gives every row a mark, so no row can render an empty gutter', () => {
    const html = render(boardDocument({ [ASHGROVE]: storedIcon('QUFBQg==') }));
    // Three products, three marks: one icon and two fallbacks.
    expect(gutters(html)).toBe(3);
    expect(count(html, 'class="favmark"')).toBe(2);
  });

  it('takes the first letter or digit of the name, and never a bare gap', () => {
    expect(faviconInitial('Ashgrove')).toBe('A');
    expect(faviconInitial('  runlet')).toBe('R');
    expect(faviconInitial('4chan')).toBe('4');
    expect(faviconInitial('— Stillee')).toBe('S');
    // A name with no letter or digit still gets a MARK rather than a hole.
    expect(faviconInitial('★★★')).toBe('·');
    expect(faviconInitial('')).toBe('·');
  });

  it('escapes a hostile product name rather than rendering it into the box', () => {
    // The fixture's second product is named with a `<script>` tag. Its initial
    // comes out of that string, so this is a real path from user input to the DOM.
    const html = render(boardDocument({}));
    expect(html).not.toContain('<script>alert');
  });
});

describe('an anonymous product', () => {
  const ANON_RANKING = sampleRanking();
  const ANON = boardDocument(
    { [ASHGROVE]: storedIcon('QU5PTllNT1VTTEVBSw==') },
    ANON_RANKING,
    anonymousIdsFor(ANON_RANKING, ASHGROVE),
  );
  /** The designation the redaction gave it, which is also its robot's seed. */
  const ANON_ROW = () => toBoardView(ANON).rows.find((row) => row.anonymous);

  it('never renders its favicon — the bytes are not even on the page', () => {
    const html = render(ANON);

    // Not "the component chose not to draw it": the icon is absent from the
    // document altogether, because `view.ts` never put it on the row. A surface
    // written next year cannot leak what it was never given.
    expect(html).not.toContain('QU5PTllNT1VTTEVBSw==');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('background-image');
  });

  it('shows a robot in the same box instead', () => {
    const html = render(ANON);

    expect(html).toContain('class="favbot"');
    // And the row is still a mark-sized gutter like every other row.
    expect(gutters(html)).toBe(3);
  });

  it('does not fall back to the initial, which would leak the withheld name', () => {
    const row = ANON_ROW();

    expect(row?.anonymous).toBe(true);
    expect(row?.iconClass).toBeUndefined();
    // The seed is the row's own designation, so the same listing draws the same
    // robot on every board, every rebuild, and on the verdict page that froze it.
    expect(row?.robotSeed).toBe(row?.name);
    expect(row?.robotSeed).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
  });

  it('withholds the name and the URL as well as the icon', () => {
    // The icon is one third of an identity. A board that hid the favicon and
    // printed "Ashgrove" beside it would have withheld nothing at all.
    const html = render(ANON);
    const row = ANON_ROW();

    expect(html).not.toContain('Ashgrove');
    expect(html).not.toContain(ASHGROVE);
    expect(row?.url).toBe('');
    expect(row?.href).toBeUndefined();
  });

  it('keeps its icon out of the board’s style block even when other rows have one', () => {
    const ranking = sampleRanking();
    const html = render(
      boardDocument(
        { [ASHGROVE]: storedIcon('QU5PTllNT1VT'), [RUNLET]: storedIcon('bmFtZWRyb3c=') },
        ranking,
        anonymousIdsFor(ranking, ASHGROVE),
      ),
    );

    expect(html).not.toContain('QU5PTllNT1VT');
    expect(html).toContain('bmFtZWRyb3c=');
  });

  it('is decided by the document’s own record, not by anything on the row', () => {
    // A row cannot make itself anonymous by carrying a field, and cannot make
    // itself named by dropping one: the set travels beside the ranking, written
    // by whoever redacted it. A privacy decision inferred from row data is a
    // privacy decision that changes when the row shape does.
    const ranking = sampleRanking();
    for (const row of ranking.ranking) {
      if (row.url === ASHGROVE) (row as unknown as { anonymous: unknown }).anonymous = 'true';
    }
    const view = toBoardView(boardDocument({}, ranking, []));

    expect(view.rows.find((row) => row.url === ASHGROVE)?.anonymous).toBe(false);
  });

  it('draws its robot from the seed and nothing else', () => {
    const html = renderToStaticMarkup(createElement(RobotAvatar, { seed: 'Unit Kilo-427', size: 16 }));

    expect(html).toContain('width="16"');
    expect(html).toContain('viewBox="0 0 16 16"');
    // Decoration: the row states the pseudonym in text beside it.
    expect(html).toContain('aria-hidden="true"');
    // In-process, from the seed. `02 §4`: a board read fetches nothing.
    expect(html).not.toContain('http');
    // The two hues carry meaning — `--cut` is what was taken, `--held` is what
    // survived — so an avatar in either would make an identity read as a score.
    expect(html).not.toContain('--cut');
    expect(html).not.toContain('--held');
  });
});

// ------------------------------------------------------------- accessibility

describe('the mark is decoration, in every state', () => {
  it('is hidden from a screen reader whichever of the three is drawn', () => {
    for (const [label, document_] of [
      ['icon', boardDocument({ [ASHGROVE]: storedIcon('QUFBQg==') })],
      ['fallback', boardDocument({})],
      ['robot', boardDocument({}, sampleRanking(), anonymousIdsFor(sampleRanking(), ASHGROVE))],
    ] as const) {
      const html = render(document_);
      for (const match of html.matchAll(/<span class="fav(?:[ ][^"]*)?"([^>]*)>/g)) {
        expect(match[1], label).toContain('aria-hidden="true"');
      }
    }
  });
});

// ------------------------------------------------------------- the homepage

describe('the homepage carries only the icons its eight rows wear', () => {
  it('drops the rules for rows the slice left behind', () => {
    const board = toBoardView(boardDocument({ [ASHGROVE]: storedIcon('Zmlyc3Ryb3c='), [RUNLET]: storedIcon('dGhpcmRyb3c=') }));
    expect(board.iconCss).toContain('Zmlyc3Ryb3c=');
    expect(board.iconCss).toContain('dGhpcmRyb3c=');

    const home = toHomeBoard(board, 1);

    expect(home.rows).toHaveLength(1);
    expect(home.iconCss).toContain('Zmlyc3Ryb3c=');
    // Runlet is rank 3 and did not make the slice, so its bytes must not be in
    // the homepage payload at all.
    expect(home.iconCss).not.toContain('dGhpcmRyb3c=');
  });

  it('carries a class name rather than the bytes on each row', () => {
    const board = toBoardView(boardDocument({ [ASHGROVE]: storedIcon('Zmlyc3Ryb3c=') }));
    const home = toHomeBoard(board);

    expect(JSON.stringify(home.rows)).not.toContain('Zmlyc3Ryb3c=');
    expect(JSON.stringify(home.rows)).not.toContain('data:image');
    expect(home.rows[0]?.iconClass).toBeDefined();
  });

  it('filters by whole class name, not by prefix', () => {
    const css = ['.fi-abc{background-image:url("data:image/png;base64,AAA")}', '.fi-abcd{background-image:url("data:image/png;base64,BBB")}'].join('\n');

    expect(pickFaviconCss(css, new Set(['fi-abc']))).toBe('.fi-abc{background-image:url("data:image/png;base64,AAA")}');
    expect(pickFaviconCss('', new Set(['fi-abc']))).toBe('');
  });
});

// ------------------------------------------------------- the generated CSS

describe('the style block is safe as element text', () => {
  it('contains no character React would have to escape', () => {
    const board = toBoardView(boardDocument({ [ASHGROVE]: storedIcon('QUFBQmJiYmI=') }));

    // The board surfaces have no `dangerouslySetInnerHTML` and must never gain
    // one, so the CSS is rendered as `<style>{text}</style>`. That is only
    // equivalent to the CSS a browser should parse because none of the
    // alphabets involved — a fixed template, a MIME from a closed map, base64 —
    // contains one of these.
    expect(board.iconCss).not.toMatch(/[<>&]/);
    expect(board.iconCss).toMatch(/^\.fi-[a-z0-9]+\{background-image:url\("data:image\/[a-z-]+;base64,[A-Za-z0-9+/=]+"\)\}$/);
  });

  it('refuses to emit a rule for a payload that is not base64', () => {
    // The defence that makes the claim above true of hostile input as well as
    // ours: a hand-edited index cannot break out of the `url("…")`.
    const board = toBoardView(boardDocument({ [ASHGROVE]: storedIcon('");}body{display:none}/*') }));

    expect(board.iconCss).toBe('');
    expect(board.rows.find((row) => row.url === ASHGROVE)?.iconClass).toBeDefined();
  });
});

/**
 * How many mark GUTTERS a document has.
 *
 * A regex rather than a substring count, because `favmark` and `favbot` are the
 * things INSIDE the gutter and both start with `fav`. Counting them as gutters
 * would make a fallback row look like two rows and quietly pass the test that
 * every state occupies the same box.
 */
function gutters(html: string): number {
  return (html.match(/class="fav(?=[ "])/g) ?? []).length;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
