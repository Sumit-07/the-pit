/**
 * `/how-it-works`, checked against the boards it claims to be describing.
 *
 * The page's argument is that the method is checkable, so the tests are not
 * "a heading rendered". Every figure it prints is recomputed here **straight off
 * `cjr/runs/<category>/ranking.json`** — the same files the engine wrote and the
 * boards are built from — and the page has to agree with the recomputation. A
 * number typed into the JSX by hand fails, and so does a number that was right
 * when it was typed and has since gone stale.
 *
 * The other three groups are the rules the page is bound by rather than facts it
 * states:
 *
 * 1. **It is reachable.** From the homepage body and from the nav on every surface
 *    that has one — the two React boards, the two HTML-string surfaces, and the
 *    verdict page, which carries its links as absolute URLs because a saved copy
 *    has no origin to resolve against.
 * 2. **It says the three things that protect the reader.** The board moves, money
 *    buys nothing, and disliking the result is not a failure. Each is asserted as
 *    prose a reader would actually meet, not as a class name.
 * 3. **It promises no rank.** `brief` Part 5, held with the same regexes
 *    `boards-copy.test.ts` holds the homepage to, plus Part 5's own strings kept
 *    verbatim where the page uses them.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import BoardIndex from '@/app/boards/page';
import CategoryBoard from '@/app/boards/[slug]/page';
import Home from '@/app/page';
import HowItWorks from '@/app/how-it-works/page';
import { COPY } from '@/lib/boards/copy';
import { asPercent, inWords, mechanicsOf } from '@/lib/boards/mechanics';
import { defaultBoardSource } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';
import { renderAccountPage } from '@/lib/account/page';
import { EMPTY_FORM, renderSubmitPage } from '@/lib/checkout/page';
import { renderVerdictPage } from '@/lib/verdict/page';
import { parseVerdict } from '@/lib/verdict/model';

import { textOf } from './helpers/boards';
import { handBuiltVerdict } from './helpers/verdict.js';

/** The repository's own `cjr/`, so the page is rendered over the real boards. */
const CJR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

/*
 * Every surface in this file is a server component or a whole-document builder
 * rendered over the two real seeded boards, and the reachability group renders
 * four of them. That is seconds of honest work rather than a hang, and the 5s
 * default turns it into a timeout as soon as the suite runs under load. The
 * renders themselves are hoisted into `beforeAll` so the cost is paid once.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let previous: string | undefined;

/**
 * The page, rendered once.
 *
 * It is a server component over both seeded boards, so a render is a second of
 * work and twenty of them is a test file that times out under a parallel run
 * rather than a test file that fails. Every assertion below is about the SAME
 * document a reader would get, so rendering it once is also the more honest
 * arrangement: nothing here can pass against a render that another test's setup
 * happened to change.
 */
let rendered = '';
let prose = '';
/** The other surfaces a reader can reach it from, rendered once for the same reason. */
const surfaces = new Map<string, string>();

beforeAll(async () => {
  previous = process.env['PIT_WORKDIR'];
  process.env['PIT_WORKDIR'] = CJR;
  rendered = renderToStaticMarkup(await HowItWorks());
  prose = textOf(rendered);

  surfaces.set('the homepage', renderToStaticMarkup(await Home()));
  surfaces.set('the board index', renderToStaticMarkup(await BoardIndex()));
  surfaces.set(
    'a category board',
    renderToStaticMarkup(await CategoryBoard({ params: Promise.resolve({ slug: 'developer-tools' }) })),
  );
  surfaces.set(
    'the submit page',
    renderSubmitPage({
      categories: ['developer-tools'],
      tiers: [
        { id: 'single', label: 'One attempt', amountCents: 500, attempts: 1, includesFitReport: false },
      ] as never,
      values: { ...EMPTY_FORM, categorySlug: 'developer-tools' },
      descriptionLimit: 300,
      signedIn: false,
    }),
  );
  surfaces.set(
    'the account page',
    renderAccountPage({
      accountId: 'acct_1',
      email: 'founder@example.com',
      balance: 1,
      capabilityUrl: 'https://thepit.show/a/k7m2q9x4hd82',
      github: { linked: false },
      purchases: [],
      listings: [],
    } as never),
  );

  // A hand-built verdict rather than a seeded one: this assertion is about the
  // nav, and loading a whole seeded category to read one <nav> is a second of
  // work the rest of the suite pays for in a parallel run.
  surfaces.set(
    'a verdict',
    renderVerdictPage(parseVerdict(handBuiltVerdict()), { origin: 'https://thepit.show' }),
  );
});

afterAll(() => {
  if (previous === undefined) delete process.env['PIT_WORKDIR'];
  else process.env['PIT_WORKDIR'] = previous;
});

/**
 * The seeded rankings, read as raw JSON.
 *
 * Deliberately NOT through `toBoardView`: the point is to recompute the page's
 * figures from the engine's own file, so that a bug in the projection the page
 * shares with this test cannot cancel itself out.
 */
interface RawRanking {
  category: string;
  weights: { merit: number; demand: number; uniqueness_lambda: number };
  metrics: { name: string }[];
  personas: { name: string }[];
  ranking: {
    demand_status?: string;
    cluster: { size: number };
    scorecard: { juror_count: number; deductions: unknown[] }[];
  }[];
}

async function rawRankings(): Promise<RawRanking[]> {
  const slugs = ['developer-tools', 'health-fitness-wellness'];
  const found: RawRanking[] = [];
  for (const slug of slugs) {
    found.push(JSON.parse(await readFile(join(CJR, 'runs', slug, 'ranking.json'), 'utf8')) as RawRanking);
  }
  // Biggest board first, the order the page loads them in.
  return found.sort((a, b) => b.ranking.length - a.ranking.length || a.category.localeCompare(b.category));
}

describe('every number on the page comes off the real boards', () => {
  it('states the solo-cluster fraction each board actually has', async () => {
    const html = rendered;
    const text = prose;
    const rankings = await rawRankings();

    // 32 of 48 and 26 of 44 on the boards as committed — but computed, so the
    // sentence follows the data rather than the data being expected to hold
    // still for the sentence.
    expect(rankings.length).toBe(2);
    for (const ranking of rankings) {
      const solo = ranking.ranking.filter((row) => row.cluster.size === 1).length;
      expect(solo, `${ranking.category} has solo rows`).toBeGreaterThan(0);
      // The majority case, which is the claim the page makes about it.
      expect(solo * 2).toBeGreaterThan(ranking.ranking.length);
      expect(text).toContain(`${solo} of ${ranking.ranking.length} on ${ranking.category}`);
    }
  });

  it('states the blend and the scarcity tilt the boards were ranked under', async () => {
    const text = prose;
    const rankings = await rawRankings();
    const weights = rankings[0]?.weights;
    expect(weights).toBeDefined();
    // One blend across both boards, or the page would print no figure at all.
    for (const ranking of rankings) expect(ranking.weights).toEqual(weights);

    expect(text).toContain(`${asPercent(weights?.merit ?? 0)} merit`);
    expect(text).toContain(`${asPercent(weights?.demand ?? 0)} demand`);
    expect(text).toContain(`±${weights?.uniqueness_lambda ?? 0}`);
    // And the figures really are the ones the engine used, not a rounding of them.
    expect(weights?.merit).toBe(0.65);
    expect(weights?.demand).toBe(0.35);
    expect(weights?.uniqueness_lambda).toBe(0.075);
  });

  it('counts the panel from the scorecards rather than from a constant', async () => {
    const text = prose;
    const rankings = await rawRankings();

    const jurors = new Set(
      rankings.flatMap((ranking) => ranking.ranking.flatMap((row) => row.scorecard.map((m) => m.juror_count))),
    );
    expect(jurors.size, 'both boards were scored by the same size panel').toBe(1);
    const size = [...jurors][0] as number;
    // `DECISIONS.md` S1 raised the jury to six and superseded `01 §5.1`'s five.
    expect(size).toBe(6);
    expect(text).toContain(`The ${inWords(size)} share one rubric`);

    const buyers = new Set(rankings.map((ranking) => ranking.personas.length));
    expect(buyers.size).toBe(1);
    expect([...buyers][0]).toBe(6);
    expect(text.toLowerCase()).toContain(`${inWords([...buyers][0] as number)} simulated buyers`);
  });

  it('counts the products and the deductions the boards hold', async () => {
    const text = prose;
    const rankings = await rawRankings();

    const products = rankings.reduce((sum, ranking) => sum + ranking.ranking.length, 0);
    const cuts = rankings.reduce(
      (sum, ranking) =>
        sum + ranking.ranking.reduce((row, entry) => row + entry.scorecard.reduce((n, m) => n + m.deductions.length, 0), 0),
      0,
    );
    expect(products).toBe(92);
    expect(cuts).toBeGreaterThan(0);
    expect(text).toContain(String(products));
    expect(text).toContain(String(cuts));
  });

  it('derives the same figures the projection does, so page and board cannot drift apart', async () => {
    const source = defaultBoardSource();
    const boards = [];
    for (const slug of await source.list()) {
      const document_ = await source.read(slug);
      if (document_ !== undefined) boards.push(toBoardView(document_));
    }
    const mechanics = mechanicsOf(boards);
    const rankings = await rawRankings();

    expect(mechanics.jurors).toBe(6);
    expect(mechanics.buyers).toBe(6);
    expect(mechanics.merit).toBe(0.65);
    expect(mechanics.demand).toBe(0.35);
    expect(mechanics.scarcityTilt).toBe(0.075);
    expect(mechanics.products).toBe(rankings.reduce((sum, ranking) => sum + ranking.ranking.length, 0));
    expect(mechanics.solo).toBe(
      rankings.reduce((sum, ranking) => sum + ranking.ranking.filter((row) => row.cluster.size === 1).length, 0),
    );
    // Metric counts are per panel, so the sentence is written from the boards
    // agreeing rather than from a number in the copy.
    for (const panel of mechanics.boards) expect(panel.metrics).toBe(5);
  });

  it('prints no figure the boards cannot supply', async () => {
    // The rule `boardStats` states for the homepage, applied here: a stat that
    // cannot be computed is a stat that is not shown. Every standalone integer in
    // the rendered prose has to be one of the figures the boards produce, or one
    // of the two constants the METHOD itself is stated in.
    const rankings = await rawRankings();
    const allowed = new Set<string>(['100', '5', '3']);
    for (const ranking of rankings) {
      allowed.add(String(ranking.ranking.length));
      allowed.add(String(ranking.ranking.filter((row) => row.cluster.size === 1).length));
      allowed.add(String(ranking.personas.length));
      allowed.add(String(ranking.metrics.length));
      allowed.add(String(ranking.ranking[0]?.scorecard[0]?.juror_count ?? 6));
    }
    const totals = rankings.reduce((sum, ranking) => sum + ranking.ranking.length, 0);
    allowed.add(String(totals));
    allowed.add(
      String(
        rankings.reduce(
          (sum, r) => sum + r.ranking.reduce((a, e) => a + e.scorecard.reduce((n, m) => n + m.deductions.length, 0), 0),
          0,
        ),
      ),
    );
    allowed.add(
      String(rankings.reduce((sum, r) => sum + r.ranking.filter((row) => row.cluster.size === 1).length, 0)),
    );
    allowed.add(String(rankings.length));
    // The step numbers, which are labels rather than measurements.
    for (let step = 1; step <= 8; step += 1) allowed.add(`0${step}`);
    // The weights, as the page writes them.
    allowed.add('65');
    allowed.add('35');
    allowed.add('0.075');
    // "forty-eight" and "fifty" are spelled out in the board-moves paragraph, so
    // they are not integers here at all — which is the point of spelling them.

    const text = prose;
    const numbers = text.match(/\b\d[\d.]*\b/g) ?? [];
    expect(numbers.length).toBeGreaterThan(5);
    for (const found of numbers) {
      expect(allowed.has(found), `${found} is on the page and is not derived from a board`).toBe(true);
    }
  });
});

describe('the mechanics it explains are the mechanics the engine runs', () => {
  it('states the deduction ledger, the reason and the juror', async () => {
    const text = prose;
    // `01 §5.1`: start at 100 and deduct; each deduction pairs points with a
    // reason; `01 §6.6` tags every merged deduction with its role.
    expect(text).toContain('A product starts at 100');
    expect(text).toContain('every deduction carries a reason and the name of the juror who made it');
  });

  it('states the per-juror z-normalisation, which is the guardrail nobody would guess', async () => {
    const text = prose;
    // `01 §6.1`: per-juror z happens BEFORE combining.
    expect(text).toMatch(/normalised against everything else they scored/i);
    expect(text).toMatch(/harsh juror cannot outvote a lenient one/i);
  });

  it('says scarcity is about the idea, not the quality', async () => {
    const text = prose;
    // `01 §5.2`: scarcity, *not* quality.
    expect(text).toMatch(/scarcity is how rare the idea is, not how good it is/i);
    expect(text).toContain('core idea');
  });

  it('says the buyers make a forced choice among near-substitutes', async () => {
    const text = prose;
    // `01 §5.3`: a single forced choice among near-substitutes; no abstaining.
    expect(text).toContain('forced choice');
    expect(text).toContain('near-substitutes');
  });

  it('says a product with no near-substitutes has no buyers to face', async () => {
    const text = prose;
    // `DECISIONS.md` S3 and S11: solo clusters renormalise to merit, and that is
    // a delivery rather than a partial failure.
    expect(text).toContain('A product with no near-substitutes has no buyers to face');
    expect(text).toContain('merit alone');
  });

  it('claims no model ever sees or produces a rank', async () => {
    const text = prose;
    expect(text).toContain('No model ever sees or produces a rank');
    expect(text).toMatch(/ordinary code over stored rows/i);
    expect(text).toMatch(/re-run the stored responses and you get the same board/i);
  });
});

describe('the three things it says to protect the reader', () => {
  it('warns that the board moves under everyone', async () => {
    const text = prose;
    // `brief §1.2`: appending a product shifts population mean/std, so every
    // existing z-score changes.
    expect(text).toContain('Your number changes when other products are placed');
    expect(text).toMatch(/normalised against/i);
    expect(text).toMatch(/every verdict carries a date and a count/i);
  });

  it('says five dollars buys an evaluation and never a position', async () => {
    const text = prose;
    expect(text).toContain('Money buys an evaluation, never a position');
    // `brief` Part 5's terms line, verbatim, from the constant.
    expect(text).toContain(COPY.terms);
    expect(text).toMatch(/no boosts, no featured slots/i);
  });

  it('says disliking the result is not a failure', async () => {
    const text = prose;
    // `brief §2.3` puts this on the purchase page. It belongs here too.
    expect(text).toContain('Disliking the result is not a failure');
    expect(text).toMatch(/broken runs retry free/i);
  });

  it('says what the board is today, honestly', async () => {
    const text = prose;
    // `DECISIONS.md` S4-source: seeded listings are anonymous, and they are
    // scored by the same panel a paid submission faces.
    expect(text).toMatch(/seeded/i);
    expect(text).toMatch(/anonymously/i);
    expect(text).toMatch(/scored by the same panel/i);
  });
});

describe('it promises no rank, and keeps Part 5 verbatim', () => {
  it('never names a position it could not deliver', async () => {
    const text = prose;
    expect(text).not.toMatch(/\bguarantee/i);
    expect(text).not.toMatch(/\byour rank\b/i);
    expect(text).not.toMatch(/\bwill rank\b/i);
    expect(text).not.toMatch(/\btop \d+\b/i);
    // And it does not quote a turnaround, which is the other thing this surface
    // is not allowed to promise.
    expect(text).not.toMatch(/\bwithin \d+\s*(second|minute|hour|day)/i);
  });

  it('renders Part 5’s CTA and terms line word for word', async () => {
    const html = rendered;
    const text = prose;
    expect(text).toContain(COPY.cta);
    expect(text).toContain(COPY.terms);
    expect(html).toContain('href="/submit"');
  });

  it('stays in the plain register the surfaces behind the homepage keep', async () => {
    const text = prose;
    expect(text).not.toContain(COPY.headline);
    expect(text).not.toContain(COPY.closer);
  });
});

describe('it is reachable from the homepage and from every nav', () => {
  it('is linked from the homepage body, not only from its nav', () => {
    const html = surfaces.get('the homepage') ?? '';
    const nav = html.indexOf('</nav>');
    const links = [...html.matchAll(/href="\/how-it-works"/g)].map((match) => match.index ?? -1);
    expect(links.length, 'the homepage links it more than once').toBeGreaterThan(1);
    expect(links.some((at) => at < nav), 'once in the nav').toBe(true);
    expect(links.some((at) => at > nav), 'once in the body').toBe(true);
  });

  // Every surface in this app that renders a nav. Two React pages, two
  // whole-document builders, and the verdict page, which is checked separately
  // because its links have to be absolute.
  for (const name of ['the homepage', 'the board index', 'a category board', 'the submit page', 'the account page']) {
    it(`is in the nav on ${name}`, () => {
      const nav = /<nav[\s\S]*?<\/nav>/.exec(surfaces.get(name) ?? '')?.[0] ?? '';
      expect(nav, `${name} has a nav`).not.toBe('');
      expect(nav, `${name}'s nav links how-it-works`).toContain('/how-it-works');
    });
  }

  it('is in the verdict page’s nav, as an absolute URL a saved copy can still follow', () => {
    const nav = /<nav[\s\S]*?<\/nav>/.exec(surfaces.get('a verdict') ?? '')?.[0] ?? '';
    // Relative would break the moment the page is downloaded, which `brief`
    // Part 6 requires it to be.
    expect(nav).toContain('https://thepit.show/how-it-works');
    expect(nav).not.toContain('href="/how-it-works"');
  });
});
