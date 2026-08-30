/**
 * Anonymous listings, end to end.
 *
 * ## What these tests are trying to catch
 *
 * The failure mode for a privacy feature is not "it does not work". It is "it
 * works everywhere somebody looked". A robot on the row and the real name in a
 * `title` attribute, in the JSON the API serves, in a juror's reason four
 * paragraphs down, or in the RSC payload under the HTML — each of those renders
 * correctly, passes a visual check, and is the leak.
 *
 * So the assertions here are mostly ABSENCE assertions, and they search the whole
 * served document rather than the element that was supposed to contain the name.
 * `expect(html).toContain(robot)` would pass on a page that also printed
 * "Ashgrove" in the ledger; `expect(html).not.toContain('Ashgrove')` is the
 * property that was actually promised.
 *
 * The other half is the constraint, and it is not here: whether anonymity can be
 * flipped after delivery is asserted against the DATABASE in
 * `packages/db/test/schema/anonymity.test.ts`, with no application code between
 * the statement and the trigger. A handler that refuses is one code path among
 * several; a trigger that refuses is all of them.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Ranking } from '@the-pit/engine';
import { verdictPayload } from '@the-pit/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CategoryBoard } from '@/components/category-board';
import { anonIdentities, assignPseudonyms, pseudonymFor, redactRanking, robotSpec, robotSvg } from '@/lib/anon';
import type { BoardDocument } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';
import { buildSnapshot } from '@/lib/pipeline/snapshot-build';
import { parseVerdict } from '@/lib/verdict/model';
import { renderVerdictPage } from '@/lib/verdict/page';

import { sampleRanking } from './helpers/boards';

/** `cjr/` at the repository root; the suite's cwd is `apps/web`. */
const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

const SLUG = 'developer-tools';

/** The real cold-start board, which is the data this feature actually ships over. */
async function realRanking(): Promise<Ranking> {
  return JSON.parse(await readFile(join(WORKDIR, 'runs', SLUG, 'ranking.json'), 'utf8')) as Ranking;
}

function boardDocument(ranking: Ranking, anonymousIds: readonly number[]): BoardDocument {
  return {
    slug: SLUG,
    category: ranking.category,
    generatedAt: '2026-08-29T14:05:00.000Z',
    productCount: ranking.ranking.length,
    categoryVersion: 'v2',
    origin: 'seeded-run',
    anonymousIds,
    ranking,
  };
}

const renderBoard = (document_: BoardDocument): string =>
  renderToStaticMarkup(createElement(CategoryBoard, { board: toBoardView(document_) }));

/**
 * The served markup with its entities decoded.
 *
 * Used only where a test asserts that something IS present: juror reasons are
 * full of apostrophes and React escapes them, so a raw `toContain` would fail on
 * a page that renders the reason perfectly.
 *
 * Never used for an absence assertion. Those run against the raw bytes, because
 * a name that appears as `&#x27;` or as a `A` escape in the RSC payload is
 * still on the page, and a decoding step there would be a way to miss it.
 */
const decoded = (html: string): string =>
  html
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

// ------------------------------------------------------------- the pseudonym

describe('the designation', () => {
  it('is stable: the same listing is the same entrant forever', () => {
    // A board is rebuilt on every placement (`brief §1.2`). A name that was
    // minted at render time would give a reader a different entrant every time
    // they refreshed, which is the opposite of what a pseudonym is for.
    expect(pseudonymFor('developer-tools#7')).toBe(pseudonymFor('developer-tools#7'));
  });

  it('is different for two different listings', () => {
    expect(pseudonymFor('developer-tools#7')).not.toBe(pseudonymFor('developer-tools#8'));
  });

  it('reads as a call sign and not as a company', () => {
    // The point of the FORM. An adjective-plus-noun generator produces "Amber
    // Falcon", which is what a real company is called, and a reader scanning a
    // board must never have to wonder whether a row is a firm they have not
    // heard of.
    expect(pseudonymFor('developer-tools#7')).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
  });

  it('is unique across a whole category, not merely probably unique', () => {
    // 26 words x 900 numbers is 23,400, so at forty-odd products a birthday
    // collision is a few-percent event — which is a bug that ships. The
    // assignment resolves collisions rather than hoping.
    const ids = Array.from({ length: 400 }, (_, index) => index);
    const assigned = assignPseudonyms(SLUG, ids);

    expect(assigned.size).toBe(400);
    expect(new Set(assigned.values()).size).toBe(400);
  });

  it('does not rename an existing listing when a new one is placed', () => {
    // The property that makes a designation survive somebody else's purchase. A
    // placement APPENDS a product (`brief §1.2`), the walk is in ascending engine
    // id, and a new row can only ever take a name nobody holds.
    const before = assignPseudonyms(SLUG, [0, 1, 2, 3, 4]);
    const after = assignPseudonyms(SLUG, [0, 1, 2, 3, 4, 5]);

    for (const [id, name] of before) expect(after.get(id)).toBe(name);
  });

  it('gives the same listing a different designation in a different category', () => {
    // Uniqueness is a per-category property because a board is a category. Two
    // categories sharing an engine id is the ordinary case, not a collision.
    expect(pseudonymFor('developer-tools#3')).not.toBe(pseudonymFor('health-fitness-wellness#3'));
  });
});

// ----------------------------------------------------------------- the robot

describe('the robot', () => {
  it('is stable across renders', () => {
    expect(robotSvg('Unit Kilo-427')).toBe(robotSvg('Unit Kilo-427'));
  });

  it('is distinct between two different listings', () => {
    expect(robotSvg('Unit Kilo-427')).not.toBe(robotSvg('Unit Tango-118'));
  });

  it('differs in the features that survive being 16 pixels wide', () => {
    // Not merely "the strings differ". Two robots that agreed on the plate tone
    // and the visor and differed only in the bolts would be the same robot to a
    // reader scanning a board row, and the identity would be useless there.
    const seeds = Array.from({ length: 200 }, (_, index) => pseudonymFor(`${SLUG}#${index}`));
    const coarse = new Set(seeds.map((seed) => {
      const spec = robotSpec(seed);
      return `${spec.head}:${spec.visor}:${spec.crown}`;
    }));

    // 4 plates x 6 visors x 4 crowns = 96 coarse silhouettes. Over 200 seeds the
    // hash should reach most of them; anything much below this means a field is
    // being sliced out of bits that do not move.
    expect(coarse.size).toBeGreaterThan(70);
  });

  it('fetches nothing, from anybody', () => {
    // Not robohash.org or anything like it. Forty `<img>` tags at a third party
    // hand that host the IP, User-Agent and Referer of every visitor to a public
    // board, and leave a broken-image glyph in every identity slot on the site
    // the day it moves.
    const svg = robotSvg('Unit Kilo-427');
    expect(svg).not.toContain('http');
    expect(svg).not.toContain('//');
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('url(');
  });

  it('takes neither hue, so an avatar never reads as a score', () => {
    // `--cut` is what was taken and `--held` is what survived (`lib/theme.ts`,
    // and `theme-drift.test.ts` holds each to its one job). A red robot would
    // look like a product that lost badly before a reader had seen a number.
    for (let index = 0; index < 100; index += 1) {
      const svg = robotSvg(pseudonymFor(`${SLUG}#${index}`));
      expect(svg).not.toContain('--cut');
      expect(svg).not.toContain('--held');
    }
  });

  it('fills exactly the box it was given, at both sizes it is drawn at', () => {
    // The board reserves a 16px gutter whether a row shows an icon, a robot or a
    // fallback, so nothing on the page moves depending on which one a product
    // turned out to have. The verdict page draws the same robot at 88.
    expect(robotSvg('Unit Kilo-427', { size: 16 })).toContain('width="16" height="16"');
    expect(robotSvg('Unit Kilo-427', { size: 88 })).toContain('width="88" height="88"');
    // One unit is one device pixel at row scale, which is why the features are
    // whole-pixel rects and why `crispEdges` is on them.
    expect(robotSvg('Unit Kilo-427')).toContain('viewBox="0 0 16 16"');
    expect(robotSvg('Unit Kilo-427')).toContain('shape-rendering="crispEdges"');
  });

  it('stays small enough to put on every row of a board', () => {
    // Most rows will carry one once seeded listings go anonymous, and the board
    // is already heavy with inlined icons.
    expect(robotSvg('Unit Kilo-427').length).toBeLessThan(900);
  });
});

// ------------------------------------------------- what a board actually serves

describe('an anonymous row on a real board', () => {
  it('renders neither the name nor the URL anywhere in the served HTML', async () => {
    // The assertion that matters, and it is an ABSENCE over the whole document.
    // A robot on the row and the name in a ledger sentence is a page that looks
    // right and has told everybody anyway.
    const ranking = await realRanking();
    const target = ranking.ranking[0];
    if (target === undefined) throw new Error('the seeded board is empty');

    const html = renderBoard(boardDocument(ranking, [target.id]));

    expect(html).not.toContain(target.name);
    expect(html).not.toContain(target.url);
  });

  it('renders its deductions, its scores and its cluster in full', async () => {
    // Anonymity withholds the identity and NOTHING else. Hiding the reasons
    // would leave an opaque leaderboard, which is the thing this product exists
    // to replace, and it is what makes the verdict checkable.
    const ranking = await realRanking();
    const target = ranking.ranking[0];
    if (target === undefined) throw new Error('the seeded board is empty');

    const text = decoded(renderBoard(boardDocument(ranking, [target.id])));
    const worst = target.scorecard.flatMap((entry) => entry.deductions).sort((a, b) => b.points - a.points)[0];

    expect(worst).toBeDefined();
    // The reason, verbatim.
    expect(text).toContain(worst?.reason ?? ' ');
    // The juror who took it — `brief` Part 6 requires the attribution.
    expect(text).toContain(target.scorecard[0]?.deductions[0]?.role ?? ' ');
    // The cluster it was judged inside, and its reason.
    expect(text).toContain(target.cluster.label);
    expect(text).toContain(target.cluster.reason);
  });

  it('scrubs the withheld name out of ANOTHER product’s reason', async () => {
    // The leak that would otherwise ship. On this board exactly one cluster
    // reason names a different product — one sentence in 2,892 — and one is
    // enough to break the promise. Free text about a product sometimes contains
    // its name, so the redaction is document-wide and not field-wide.
    const ranking = await realRanking();
    const named = ranking.ranking.find((row) =>
      ranking.ranking.some((other) => other.id !== row.id && other.cluster.reason.includes(row.name)),
    );
    expect(named, 'the fixture board should contain a cross-mention').toBeDefined();

    const html = renderBoard(boardDocument(ranking, [named?.id ?? -1]));
    expect(html).not.toContain(named?.name ?? ' ');
  });

  it('shows the robot and the designation in the identity slot', async () => {
    const ranking = await realRanking();
    const view = toBoardView(boardDocument(ranking, [ranking.ranking[0]?.id ?? 0]));
    const row = view.rows.find((entry) => entry.anonymous);

    expect(row?.robotSeed).toBe(row?.name);
    expect(row?.iconClass).toBeUndefined();
    expect(row?.href).toBeUndefined();
    expect(row?.url).toBe('');
  });

  it('leaves a named row on the same board completely alone', async () => {
    // The feature is per-listing. A board with one anonymous row is otherwise
    // the board it always was.
    const ranking = await realRanking();
    const [first, second] = ranking.ranking;
    if (first === undefined || second === undefined) throw new Error('need two rows');

    const html = renderBoard(boardDocument(ranking, [first.id]));
    expect(html).toContain(second.name);
  });
});

// --------------------------------------------------- the document at rest

describe('the published snapshot', () => {
  it('never contains the name, so the API cannot serve it either', async () => {
    // `app/api/boards/[slug]/route.ts` returns this document verbatim, and it is
    // written to a bucket behind a CDN. Redacting only in the HTML renderer would
    // leave the name one `curl` away from anyone who noticed the JSON.
    const ranking = await realRanking();
    const target = ranking.ranking[0];
    if (target === undefined) throw new Error('the seeded board is empty');

    const snapshot = buildSnapshot({
      slug: SLUG,
      ranking,
      categoryVersion: 'v2',
      generatedAt: new Date('2026-08-29T14:05:00.000Z'),
      anonymousIds: [target.id],
    });

    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(target.name);
    expect(json).not.toContain(target.url);
    expect(snapshot.anonymous_ids).toEqual([target.id]);
  });

  it('is idempotent, so a second pass cannot re-derive a different designation', async () => {
    // The redaction runs at publish, at read, and at the projection. If those
    // three disagreed, a board and the verdict page it links to would name the
    // same listing differently, which is worse than not redacting at all.
    const ranking = await realRanking();
    const ids = ranking.ranking.slice(0, 5).map((row) => row.id);

    const once = redactRanking(ranking, ids, SLUG);
    const twice = redactRanking(once, ids, SLUG);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// ------------------------------------------------------------- the verdict

describe('a verdict frozen for an anonymous listing', () => {
  const frozen = () => {
    const ranking = redactRanking(sampleRanking(), [1], SLUG);
    const row = ranking.ranking.find((entry) => entry.id === 1);
    if (row === undefined) throw new Error('no row 1');
    return { ranking, row, payload: verdictPayload(ranking, row, 'v2', new Date('2026-08-27T14:03:00.000Z')) };
  };

  it('records the anonymity and the designation in the payload', () => {
    const { payload, row } = frozen();
    expect(payload['anonymous']).toBe(true);
    expect(row.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
  });

  it('keeps the identity it was delivered with, whatever the listing does later', () => {
    // `verdicts` is append-only and the payload carries the name the verdict was
    // issued under. So an owner who later claims the listing and chooses to be
    // named changes FUTURE boards and cannot reach back into a link somebody
    // shared: the page still shows the designation it showed on the day.
    const { payload } = frozen();
    const verdict = parseVerdict({
      publicSlug: 'anon-verdict-fixture',
      payload,
      productCount: 3,
      attemptNumber: null,
      deliveredAt: new Date('2026-08-27T14:03:00.000Z'),
    });

    expect(verdict.anonymous).toBe(true);
    expect(verdict.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
    expect(verdict.url).toBe('');
    expect(verdict.robot).toBeDefined();
  });

  it('renders a page with the robot and without the address', () => {
    const { payload } = frozen();
    const verdict = parseVerdict({
      publicSlug: 'anon-verdict-fixture',
      payload,
      productCount: 3,
      attemptNumber: null,
      deliveredAt: new Date('2026-08-27T14:03:00.000Z'),
    });
    const html = renderVerdictPage(verdict, { origin: 'https://thepit.show' });

    // The real listing behind row 1 of the fixture.
    const real = sampleRanking().ranking.find((row) => row.id === 1);
    expect(html).not.toContain(real?.name ?? ' ');
    expect(html).not.toContain(real?.url ?? ' ');

    // And the evidence is all still on the page.
    expect(html).toContain(real?.cluster.label ?? ' ');
    expect(html).toContain(real?.scorecard[0]?.deductions[0]?.reason ?? ' ');
  });

  it('draws the same robot the board drew, because both derive from the frozen name', () => {
    const { row } = frozen();
    const identities = anonIdentities(SLUG, [1]);

    expect(identities.get(1)?.pseudonym).toBe(row.name);
    expect(robotSpec(row.name)).toEqual(robotSpec(identities.get(1)?.pseudonym ?? ''));
  });
});
