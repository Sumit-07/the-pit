/**
 * "Just judged" — the feed, the marks, and the line `DECISIONS.md` S14 draws.
 *
 * Five properties, and the first is the one the whole feature is for.
 *
 * 1. **The feed is ordered by time and by nothing else.** S14 asked whether a
 *    cross-category feed may show ranks, because `01 §9` rule 2 forbids a
 *    cross-category leaderboard — z-scores are normalised inside a category, so
 *    ordering two categories' rows against each other invents a comparison the
 *    engine never made. The resolution is that the rank travels with the board it
 *    was a rank on and never orders anything. So this file asserts that a
 *    worse-ranked row from a newer board comes FIRST, which is the one assertion
 *    a rank-ordered feed cannot pass.
 * 2. **Nothing seeded is ever NEW.** A seeded listing's timestamp is a file's
 *    mtime, and a `git checkout` sets that to now. Driving the chip off the clock
 *    alone would light up all ninety-two cold-start listings on a fresh clone.
 * 3. **`rankMovement` is arithmetic over two boards**, and it is tested offline
 *    with no database, no file and no clock.
 * 4. **The strip renders on both surfaces and every card is a link to a verdict.**
 * 5. **Neither surface can open a database to draw it.** `boards-read-path.test.ts`
 *    owns the module-graph walk; this file pins the two things that walk depends
 *    on — that `recent.ts` is genuinely reachable from the pages, and that the
 *    Postgres arm is reachable only through `await import`.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import Home from '@/app/page';
import Boards from '@/app/boards/page';
import { JustJudged } from '@/components/just-judged';
import { RowLead } from '@/components/board-parts';
import {
  isNewVerdict,
  NEW_WINDOW_MS,
  recentVerdicts,
  relativeTime,
  seededRecentVerdicts,
  stampLine,
  stripIconCss,
  type RecentVerdict,
} from '@/lib/boards/recent';
import { movementText, movementTitle, rankMovement } from '@/lib/boards/movement';
import { stampBoard, toBoardView, type BoardView, type RowView } from '@/lib/boards/view';

import { sampleRanking, SAMPLE_CAVEAT, textOf, writeSeededWorkdir } from './helpers/boards';

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['PIT_WORKDIR'];
});

/** A board whose numbers are hand-derivable — the same fixture the home surface uses. */
function board(overrides: { slug?: string; category?: string; generatedAt?: string } = {}): BoardView {
  return toBoardView({
    slug: overrides.slug ?? 'developer-tools',
    category: overrides.category ?? 'Developer Tools',
    generatedAt: overrides.generatedAt ?? '2026-08-29T14:05:00.000Z',
    productCount: 3,
    categoryVersion: 'v2',
    engineVersion: '0.1.0-test',
    caveat: SAMPLE_CAVEAT,
    anonymousIds: [],
    origin: 'seeded-run',
    ranking: sampleRanking({ category: overrides.category ?? 'Developer Tools' }),
  });
}

describe('recentVerdicts, in filesystem mode', () => {
  it('orders by the moment a board was ranked, never by the rank on it', () => {
    // The older board holds rank 1; the newer holds rank 3. A feed ordered by
    // rank would open on Developer Tools. Ordered by time, it opens on the board
    // that was ranked most recently — which is the assertion S14 turns on.
    const older = board({ slug: 'developer-tools', category: 'Developer Tools', generatedAt: '2026-08-01T00:00:00.000Z' });
    const newer = board({ slug: 'health-fitness', category: 'Health & Fitness', generatedAt: '2026-09-01T00:00:00.000Z' });

    const cards = seededRecentVerdicts([older, newer], 4);

    expect(cards[0]?.category).toBe('Health & Fitness');
    expect(cards.slice(0, 3).every((card) => card.category === 'Health & Fitness')).toBe(true);
    expect(cards[3]?.category).toBe('Developer Tools');
    // Non-increasing in time, which is the only ordering claim the feed makes.
    const stamps = cards.map((card) => card.deliveredAt);
    expect([...stamps].sort((a, b) => b.localeCompare(a))).toEqual(stamps);
  });

  it('interleaves categories ranked on the same day, whatever the mtime jitter', () => {
    // Every row of a seeded board shares one mtime, and a `git checkout` writes
    // both rankings milliseconds apart. At full resolution they are not tied and
    // the strip fills entirely from whichever file landed second — six cards, one
    // category. A mtime does not carry an ordering between categories, so the
    // bucket is the day.
    const a = board({ slug: 'developer-tools', category: 'Developer Tools', generatedAt: '2026-08-29T14:05:00.031Z' });
    const b = board({ slug: 'health-fitness', category: 'Health & Fitness', generatedAt: '2026-08-29T14:05:00.007Z' });

    const cards = seededRecentVerdicts([a, b], 4);
    expect(cards.map((card) => card.category)).toEqual([
      'Developer Tools',
      'Health & Fitness',
      'Developer Tools',
      'Health & Fitness',
    ]);
    // Best rank first inside a category, and the rank is the one it holds on ITS
    // board — 1 and 1, not 1 and 2.
    expect(cards.map((card) => card.rank)).toEqual([1, 1, 2, 2]);
    // The coarsening decided the ORDER. Each card still prints its own board's
    // instant, to the millisecond it was written at.
    expect(cards[0]?.deliveredAt).toBe('2026-08-29T14:05:00.031Z');
    expect(cards[1]?.deliveredAt).toBe('2026-08-29T14:05:00.007Z');
  });

  it('still leads with a category ranked on a later day', () => {
    // The bucket is a day, not an eraser: a difference the timestamp can support
    // is still an ordering.
    const older = board({ slug: 'developer-tools', category: 'Developer Tools', generatedAt: '2026-08-29T23:59:00.000Z' });
    const newer = board({ slug: 'health-fitness', category: 'Health & Fitness', generatedAt: '2026-08-30T00:01:00.000Z' });
    expect(seededRecentVerdicts([older, newer], 2).map((card) => card.category)).toEqual([
      'Health & Fitness',
      'Health & Fitness',
    ]);
  });

  it('honours the limit, and returns fewer when there is less', () => {
    expect(seededRecentVerdicts([board()], 2)).toHaveLength(2);
    // The fixture holds three rows; asking for ten does not invent seven.
    expect(seededRecentVerdicts([board()], 10)).toHaveLength(3);
    expect(seededRecentVerdicts([], 6)).toEqual([]);
  });

  it('carries the stamp, the health, the sharpest cut and a verdict link on every card', () => {
    const [first] = seededRecentVerdicts([board()], 1);
    expect(first).toBeDefined();
    expect(first?.rank).toBe(1);
    expect(first?.productCount).toBe(3);
    expect(first?.category).toBe('Developer Tools');
    // Ashgrove: metric scores 60 and 90, mean 75, so 25 in cuts and 75 left.
    expect(first?.health).toBe(75);
    expect(first?.cut).toMatchObject({ points: 40, role: 'The Seed Investor' });
    // The resolver, not a re-derived `verdicts.public_slug` — see `view.ts`.
    expect(first?.href).toBe('/v/of/developer-tools/1');
    expect(stampLine(first as RecentVerdict)).toBe('#1 of 3 in Developer Tools when judged');
  });

  it('never marks a seeded listing NEW, whatever its file mtime says', () => {
    // The mtime here is in the future relative to nothing — the point is that
    // recency is not what decides it. A `git checkout` stamps every seeded
    // ranking with the moment of the checkout.
    const fresh = board({ generatedAt: new Date().toISOString() });
    expect(seededRecentVerdicts([fresh], 3).every((card) => card.isNew)).toBe(false);
    expect(seededRecentVerdicts([fresh], 3).some((card) => card.isNew)).toBe(false);
  });

  it('reads the boards itself when the caller has none, with no database in existence', async () => {
    const workdir = await writeSeededWorkdir({ slug: 'developer-tools' });
    scratch.push(workdir);
    process.env['PIT_WORKDIR'] = workdir;

    const cards = await recentVerdicts(6, { env: { PIT_STORAGE: 'filesystem' } });
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.categorySlug === 'developer-tools')).toBe(true);
  });
});

describe('the NEW window', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  it('fires for a pitch delivered inside seven days', () => {
    expect(isNewVerdict({ attemptNumber: 1, deliveredAt: new Date('2026-09-10T11:00:00.000Z') }, now)).toBe(true);
    expect(isNewVerdict({ attemptNumber: 3, deliveredAt: new Date('2026-09-04T12:00:01.000Z') }, now)).toBe(true);
  });

  it('stops at seven days exactly, and stays off past it', () => {
    const edge = new Date(now.getTime() - NEW_WINDOW_MS);
    expect(isNewVerdict({ attemptNumber: 1, deliveredAt: edge }, now)).toBe(false);
    expect(isNewVerdict({ attemptNumber: 1, deliveredAt: new Date('2026-08-01T00:00:00.000Z') }, now)).toBe(false);
  });

  it('never fires for a listing nobody pitched, however recent its stamp', () => {
    // `verdicts.attempt_number` is NULL on a seeded row. This is the condition
    // that keeps a fresh seed from lighting up ninety-two chips.
    expect(isNewVerdict({ attemptNumber: null, deliveredAt: now }, now)).toBe(false);
  });
});

describe('rankMovement', () => {
  const previous = [
    { key: 10, rank: 1 },
    { key: 20, rank: 2 },
    { key: 30, rank: 3 },
    { key: 40, rank: 4 },
  ];

  it('reads a smaller rank as a climb and a larger one as a fall', () => {
    const moved = rankMovement(
      [
        { key: 30, rank: 1 },
        { key: 20, rank: 2 },
        { key: 10, rank: 3 },
      ],
      previous,
    );
    expect(moved.get(30)).toEqual({ kind: 'up', by: 2 });
    expect(moved.get(20)).toEqual({ kind: 'same' });
    expect(moved.get(10)).toEqual({ kind: 'down', by: 2 });
  });

  it('calls a row that was not on the previous board new', () => {
    const moved = rankMovement([{ key: 99, rank: 1 }], previous);
    expect(moved.get(99)).toEqual({ kind: 'new' });
  });

  it('says nothing about a row that has left, because there is no row to say it on', () => {
    const moved = rankMovement([{ key: 10, rank: 1 }], previous);
    expect(moved.has(40)).toBe(false);
    expect([...moved.keys()]).toEqual([10]);
  });

  it('renders nothing at all when there is no previous board', () => {
    // Filesystem mode: one snapshot, nothing behind it. A dash on every row would
    // be a claim about a comparison nobody made.
    expect(rankMovement([{ key: 10, rank: 1 }], undefined).size).toBe(0);
  });

  it('says the same thing in a glyph and in words', () => {
    expect(movementText({ kind: 'up', by: 3 })).toBe('▲3');
    expect(movementText({ kind: 'down', by: 2 })).toBe('▼2');
    expect(movementText({ kind: 'same' })).toBe('—');
    expect(movementText({ kind: 'new' })).toBe('new');
    // The glyph is not an accessible name and the colour is not available to
    // everybody, so every mark states itself.
    expect(movementTitle({ kind: 'up', by: 3 })).toContain('Up 3');
    expect(movementTitle({ kind: 'down', by: 2 })).toContain('Down 2');
    expect(movementTitle({ kind: 'new' })).toContain('Not on the last board');
  });
});

describe('the marks a stamped board wears', () => {
  it('puts the movement mark in the rank column and the chip beside the name', () => {
    const stamped = stampBoard(board(), {
      previous: [
        { key: 1, rank: 3 },
        { key: 2, rank: 2 },
      ],
      newIds: new Set([3]),
    });

    const [first, second, third] = stamped.rows;
    expect(first?.movement).toEqual({ kind: 'up', by: 2 });
    expect(second?.movement).toEqual({ kind: 'same' });
    // Absent from the previous board, so it arrived between the two.
    expect(third?.movement).toEqual({ kind: 'new' });
    expect(third?.isNew).toBe(true);
    expect(first?.isNew).toBeUndefined();

    const html = renderToStaticMarkup(createElement(RowLead, { row: third as RowView }));
    expect(html).toContain('class="tag new"');
    expect(html).toContain('Delivered in the last seven days.');

    // And a row outside the window wears no chip.
    expect(renderToStaticMarkup(createElement(RowLead, { row: first as RowView }))).not.toContain('tag new');
  });

  it('leaves a board with no history exactly as it was', () => {
    const plain = board();
    expect(stampBoard(plain, {})).toBe(plain);
    expect(stampBoard(plain, {}).rows.every((row) => row.movement === undefined)).toBe(true);
  });
});

describe('the strip itself', () => {
  const cards: RecentVerdict[] = [
    {
      categorySlug: 'developer-tools',
      category: 'Developer Tools',
      engineId: 7,
      name: 'Runlet',
      anonymous: false,
      mark: 'R',
      rank: 12,
      productCount: 49,
      health: 83,
      cut: { points: 40, reason: 'No trigger event anywhere in the pitch.', role: 'The Seed Investor', metric: 'problem_sharpness' },
      deliveredAt: '2026-09-10T10:00:00.000Z',
      href: '/v/838caab9fd742cfd06a0fd120c5e7d83',
      isNew: true,
    },
    {
      categorySlug: 'health-fitness',
      category: 'Health & Fitness',
      engineId: 4,
      name: 'Unit Kilo-427',
      anonymous: true,
      robotSeed: 'Unit Kilo-427',
      mark: 'U',
      rank: 2,
      productCount: 44,
      health: 61,
      cut: null,
      deliveredAt: '2026-09-03T10:00:00.000Z',
      href: '/v/of/health-fitness/4',
      isNew: false,
    },
  ];

  function strip(now = new Date('2026-09-10T12:00:00.000Z')): string {
    return renderToStaticMarkup(createElement(JustJudged, { cards, now }));
  }

  it('renders every card as a link to its verdict', () => {
    const html = strip();
    expect(html).toContain('href="/v/838caab9fd742cfd06a0fd120c5e7d83"');
    expect(html).toContain('href="/v/of/health-fitness/4"');
  });

  it('keeps every rank inside the board it was a rank on', () => {
    const html = strip();
    // The stamp, in full, as the element's own title.
    expect(html).toContain('#12 of 49 in Developer Tools when judged');
    expect(html).toContain('#2 of 44 in Health &amp; Fitness when judged');
    const text = textOf(html);
    expect(text).toContain('#12 / 49 Developer Tools');
    expect(text).toContain('#rank when judged');
  });

  it('offers nothing that would re-order it', () => {
    // S14's line: a feed is not a leaderboard. There is no header to click, no
    // control, and no form on the strip.
    const html = strip();
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/sort/i);
  });

  it('shows the chip only on the card inside the window', () => {
    const html = strip();
    expect([...html.matchAll(/class="tag new"/g)]).toHaveLength(1);
    const runletAt = html.indexOf('Runlet');
    const kiloAt = html.indexOf('Unit Kilo-427');
    expect(html.indexOf('class="tag new"')).toBeGreaterThan(runletAt);
    expect(html.indexOf('class="tag new"')).toBeLessThan(kiloAt);
  });

  it('states the time as a relative label and as a machine-readable instant', () => {
    const html = strip();
    expect(html).toContain('2026-09-10T10:00:00.000Z');
    expect(textOf(html)).toContain('2h ago');
    // Seven days and two hours rounds up out of the day bucket, which is the
    // coarseness the docblock trades for surviving a day in a cache.
    expect(textOf(html)).toContain('1w ago');
  });

  it('renders the health figure and a bar of the same width', () => {
    const html = strip();
    expect(html).toContain('--held-w:83%');
    expect(textOf(html)).toContain('83 health left');
    // A card whose product lost nothing says so rather than showing a gap.
    expect(textOf(html)).toContain('nothing came off this card');
  });

  it('draws nothing when there is nothing to draw', () => {
    expect(renderToStaticMarkup(createElement(JustJudged, { cards: [] }))).toBe('');
  });

  it('emits icon rules only for the cards that wear one', () => {
    const iconed = board();
    // No favicons in the fixture, so nothing is emitted and no empty `<style>`
    // reaches the document.
    expect(stripIconCss([iconed], seededRecentVerdicts([iconed], 3))).toBe('');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const ago = (ms: number): string => relativeTime(new Date(now.getTime() - ms).toISOString(), now);

  it('buckets coarsely enough to survive a day in a cache', () => {
    expect(ago(30_000)).toBe('just now');
    expect(ago(12 * 60_000)).toBe('12m ago');
    expect(ago(2 * 3_600_000)).toBe('2h ago');
    expect(ago(3 * 86_400_000)).toBe('3d ago');
    expect(ago(21 * 86_400_000)).toBe('3w ago');
  });

  it('returns the input unchanged rather than printing NaN', () => {
    expect(relativeTime('not a date', now)).toBe('not a date');
  });
});

describe('the strip on the two public surfaces', () => {
  async function render(page: () => Promise<React.ReactNode>): Promise<string> {
    const workdir = await writeSeededWorkdir({ slug: 'developer-tools' });
    scratch.push(workdir);
    process.env['PIT_WORKDIR'] = workdir;
    return renderToStaticMarkup((await page()) as React.ReactElement);
  }

  it('renders on the homepage, between the stats and the board', async () => {
    const html = await render(Home as () => Promise<React.ReactNode>);
    const statsAt = html.indexOf('class="stats"');
    const stripAt = html.indexOf('class="justwrap"');
    const boardAt = html.indexOf('class="board"');
    expect(statsAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(statsAt);
    expect(boardAt).toBeGreaterThan(stripAt);
    expect(textOf(html)).toContain('Just judged');
    expect(html).toContain('href="/v/of/developer-tools/1"');
  });

  it('renders full width at the top of the board index', async () => {
    const html = await render(Boards as () => Promise<React.ReactNode>);
    const stripAt = html.indexOf('class="justwrap wide"');
    const listAt = html.indexOf('class="blist"');
    expect(stripAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(stripAt);
    expect(textOf(html)).toContain('Just judged');
    expect(html).toContain('href="/v/of/developer-tools/');
  });

  it('shows no NEW chip on either surface while everything on them is seeded', async () => {
    expect(await render(Home as () => Promise<React.ReactNode>)).not.toContain('class="tag new"');
    expect(await render(Boards as () => Promise<React.ReactNode>)).not.toContain('class="tag new"');
  });

  it('draws no movement mark, because there is one snapshot to compare', async () => {
    // Filesystem mode has a single board document per category. Rendering `—` on
    // forty-eight rows would be the page claiming a comparison it never made.
    expect(await render(Home as () => Promise<React.ReactNode>)).not.toContain('class="mv');
  });
});

describe('the strip cannot open a database', () => {
  const SRC = resolve(process.cwd(), 'src');

  it('reaches the Postgres arm only through a dynamic import', async () => {
    const recent = await readFile(join(SRC, 'lib/boards/recent.ts'), 'utf8');
    // Named nowhere as a static edge...
    expect(recent).not.toMatch(/^\s*import[^\n]*from '\.\/pg-(recent|history)'/m);
    // ...and reached in exactly the two places the mode has already been decided.
    expect(recent).toContain("await import('./pg-recent')");
    expect(recent).toContain("await import('./pg-history')");
    // Prose may name them; an import statement may not.
    const imports = [...recent.matchAll(/^\s*(?:import|export)\b[^\n]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports).not.toContain('@the-pit/db');
    expect(imports).not.toContain('drizzle-orm');
    expect(imports).not.toContain('./pg-recent');
    expect(imports).not.toContain('./pg-history');
  });

  it('is genuinely on the graph the read-path walk covers', async () => {
    // An empty offence list means nothing if the walker never reaches this
    // module. Both pages import it by name.
    for (const page of ['app/page.tsx', 'app/boards/page.tsx']) {
      expect(await readFile(join(SRC, page), 'utf8')).toContain("from '@/lib/boards/recent'");
    }
    // And the two arms it hides are on the forbidden list.
    const guard = await readFile(resolve(process.cwd(), 'test/boards-read-path.test.ts'), 'utf8');
    expect(guard).toContain("'@/lib/boards/pg-recent'");
    expect(guard).toContain("'@/lib/boards/pg-history'");
  });
});
