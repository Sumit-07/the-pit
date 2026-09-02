/**
 * The homepage's three working parts, checked as properties of the document.
 *
 * 1. **The hero's right half holds the live #1.** It used to be four hundred
 *    pixels of empty slab. What is there now is not an illustration of a product
 *    — it is the current leader of the current board, wearing the same health bar
 *    every row wears, linking to its verdict. The test that matters is that the
 *    card names the row the board itself ranks first and points where that row
 *    points: a hero card showing a product the board disagrees with would be the
 *    page contradicting itself above and below the fold.
 *
 * 2. **Every row is a link.** The board's whole job is to make a reader want a
 *    verdict, and until this shipped the eight most visible rows on the site were
 *    the only ones with no way into the thing they advertise.
 *
 * 3. **It is complete with no JavaScript.** Everything above is asserted against
 *    `renderToStaticMarkup`, which is the server's output with nothing hydrated:
 *    the first card is drawn, the rows are linked, and the rail simply never
 *    advances. `brief` Part 3 makes a board read a CDN hit, and a hero that
 *    needed a bundle before it said anything would spend that on a spinner.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import Home from '@/app/page';
import { HomeBoard } from '@/components/home-board';
import { boardStats, heroCards, toHomeBoard, tickerLines } from '@/lib/boards/home';
import { toBoardView, type BoardView } from '@/lib/boards/view';

import { sampleRanking, SAMPLE_CAVEAT, textOf, writeSeededWorkdir } from './helpers/boards';

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['PIT_WORKDIR'];
});

async function renderHome(): Promise<string> {
  const workdir = await writeSeededWorkdir({ slug: 'developer-tools' });
  scratch.push(workdir);
  process.env['PIT_WORKDIR'] = workdir;
  return renderToStaticMarkup(await Home());
}

/** The same projection the page uses, over a board whose numbers are hand-derivable. */
function board(): BoardView {
  return toBoardView({
    slug: 'developer-tools',
    category: 'Developer Tools',
    generatedAt: '2026-08-29T14:05:00.000Z',
    productCount: 3,
    categoryVersion: 'v2',
    engineVersion: '0.1.0-test',
    caveat: SAMPLE_CAVEAT,
    anonymousIds: [],
    origin: 'seeded-run',
    ranking: sampleRanking(),
  });
}

describe('the hero carries the live #1', () => {
  it('names the row the board ranks first, and links where that row links', async () => {
    const view = board();
    const first = view.rows[0];
    expect(first).toBeDefined();

    const [card] = heroCards([toHomeBoard(view)]);
    expect(card?.name).toBe(first?.name);
    expect(card?.verdictHref).toBe(first?.verdictHref);
    // `/v/of/<category>/<product>` — the resolver, not a verdict slug this
    // surface would have to re-derive. `lib/boards/view.ts` says why.
    expect(card?.verdictHref).toMatch(/^\/v\/of\/developer-tools\/\d+$/);
  });

  it('is in the server-rendered document, drawn, with no JavaScript run', async () => {
    const html = await renderHome();
    const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('class="stats"'));

    expect(hero).toContain('class="herocard on"');
    expect(hero).toContain('Currently first');
    // The rank, the field it is first in, and the category it is first in.
    expect(textOf(hero)).toMatch(/#1 \/ \d+ · Developer Tools/);
    // The bar, and the figure it is a picture of.
    expect(hero).toContain('class="hcbar"');
    expect(hero).toMatch(/class="kept" style="width:\d/);
    expect(textOf(hero)).toContain('of 100 health left');
  });

  it('says what the sharpest cut was, and who took it', async () => {
    const text = textOf(await renderHome());
    // The heaviest deduction on the leading row of the seeded fixture, with the
    // juror attached — the board's register, at hero scale.
    expect(text).toContain('No trigger event anywhere in the pitch.');
    expect(text).toContain('The Seed Investor');
  });

  it('shows exactly one card and hides the rest from the reader and the tab key', async () => {
    const html = await renderHome();
    expect([...html.matchAll(/class="herocard on"/g)]).toHaveLength(1);
    for (const hidden of html.matchAll(/<a class="herocard"[^>]*>/g)) {
      expect(hidden[0]).toContain('aria-hidden="true"');
      expect(hidden[0]).toContain('tabindex="-1"');
    }
  });
});

describe('every row on the board is a link', () => {
  function homeHtml(): string {
    const view = board();
    return renderToStaticMarkup(
      createElement(HomeBoard, {
        boards: [toHomeBoard(view)],
        ticker: tickerLines([view]),
        deepest: boardStats([view]).deepest,
      }),
    );
  }

  it('wraps every row in an anchor with an href', () => {
    const html = homeHtml();
    const rows = [...html.matchAll(/<div class="brow(?: first)?"/g)];
    const links = [...html.matchAll(/<a class="rowlink" href="([^"]+)"/g)].map((match) => match[1]);
    expect(rows.length).toBe(board().rows.length);
    // Every row, not most of them: a board where the seventh row is inert is a
    // board a reader stops trusting at the seventh row.
    expect(links).toHaveLength(rows.length);
    for (const href of links) expect(href).toMatch(/^\/(v\/of|boards)\//);
  });

  it('sends each row to its own verdict and not to a shared destination', () => {
    const links = [...homeHtml().matchAll(/<a class="rowlink" href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(links).size).toBe(links.length);
  });

  it('carries the stagger the bars draw on, as a custom property and not a script', () => {
    // The health bars draw in from CSS alone (`pit.css`), so the only thing the
    // component contributes is one delay per row — and the `drawin` class that
    // says this is the first board, arriving, rather than the fourth rotation.
    const html = homeHtml();
    expect(html).toContain('class="boardrows drawin"');
    expect(html).toContain('--draw-delay:0ms');
    expect(html).toContain('--draw-delay:40ms');
  });
});

describe('the panels describe things that exist', () => {
  it('drops The Mob, and lays the rest out as a pair', async () => {
    const html = await renderHome();
    // There is no mob: no vote route, no vote store, no board for it to have its
    // own board on. A panel describing a panel that does not exist is the one
    // thing on this page that could not be defended.
    expect(html).not.toContain('The Mob');
    expect(html).not.toContain('own board');
    expect(html).toContain('class="three pair"');
    expect(html).toContain('The Six');
    expect(html).toContain('The Floor');
  });
});
