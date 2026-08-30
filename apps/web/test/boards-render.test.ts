/**
 * What the board surfaces actually put in the document.
 *
 * These render the real components with `react-dom/server` and assert on the
 * markup, because the three things `brief` Part 6 asks for are properties of the
 * output and not of anybody's intentions:
 *
 * 1. A row leads with a **deduction and its juror**, and the composite comes
 *    after it — in DOM order, not merely to the right of it.
 * 2. A **solo-cluster** row is marked, and the mark arrives with the sentence
 *    that explains it.
 * 3. A hostile product name is **escaped**, and a hostile URL never becomes an
 *    href.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HEALTH_NOTE, HOME_LEGEND, SOLO_NOTE, STAMP_NOTE } from '@/lib/boards/copy';
import { boardStats, toHomeBoard, tickerLines } from '@/lib/boards/home';
import { toBoardView, type BoardView } from '@/lib/boards/view';
import { CategoryBoard, panelLabels } from '@/components/category-board';
import { HomeBoard } from '@/components/home-board';

import { HOSTILE_NAME, sampleRanking, SAMPLE_CAVEAT, textOf } from './helpers/boards';

function board(overrides: Partial<Parameters<typeof toBoardView>[0]> = {}): BoardView {
  return toBoardView({
    slug: 'developer-tools',
    category: 'Developer Tools',
    generatedAt: '2026-08-29T14:05:00.000Z',
    productCount: 3,
    categoryVersion: 'v2',
    engineVersion: '0.1.0-test',
    caveat: SAMPLE_CAVEAT,
    origin: 'seeded-run',
    ranking: sampleRanking(),
    ...overrides,
  });
}

function boardHtml(view: BoardView = board()): string {
  return renderToStaticMarkup(createElement(CategoryBoard, { board: view }));
}

function homeHtml(view: BoardView = board()): string {
  return renderToStaticMarkup(
    createElement(HomeBoard, {
      boards: [toHomeBoard(view)],
      ticker: tickerLines([view]),
      deepest: boardStats([view]).deepest,
    }),
  );
}

describe('a row leads with the cut, not with the number', () => {
  it('puts the reason and the juror before the composite in DOM order', () => {
    const html = boardHtml();
    const reason = html.indexOf('No trigger event anywhere in the pitch.');
    const juror = html.indexOf('The Seed Investor');
    const composite = html.indexOf('title="pure merit composite, before the blend"');

    expect(reason).toBeGreaterThan(-1);
    expect(juror).toBeGreaterThan(-1);
    expect(composite).toBeGreaterThan(-1);
    expect(reason).toBeLessThan(composite);
    expect(juror).toBeLessThan(composite);
  });

  it('keeps the same order on the homepage board', () => {
    const html = homeHtml();
    const reason = html.indexOf('No trigger event anywhere in the pitch.');
    const composite = html.indexOf('title="pure merit composite, before the blend"');
    expect(reason).toBeGreaterThan(-1);
    expect(reason).toBeLessThan(composite);
  });

  it('renders the juror inside the same lead as the reason', () => {
    const lead = /<span class="topcut">([\s\S]*?)<\/span><\/span>/.exec(boardHtml())?.[1] ?? '';
    expect(textOf(lead)).toContain('40 No trigger event anywhere in the pitch. The Seed Investor');
  });

  it('attaches a juror to every deduction in the open ledger', () => {
    const html = boardHtml();
    for (const [reason, role] of [
      ['No trigger event anywhere in the pitch.', 'The Seed Investor'],
      ['Names a category, not a moment.', 'The Release Engineer'],
      ['Integration mechanism is never named.', 'The Docs Writer'],
      ['Cron with a graph is a feature, not a product.', 'The Weekend Shipper'],
    ] as const) {
      const at = html.indexOf(reason);
      expect(at, reason).toBeGreaterThan(-1);
      // The role follows its reason within the same `.ded` block.
      expect(html.slice(at, at + 220)).toContain(role);
    }
  });

  it('says so in words when a card lost nothing, rather than leaving a gap', () => {
    const clean = sampleRanking();
    clean.ranking[0]!.scorecard = [
      { metric: 'Problem Sharpness', score: 100, spread: 0, juror_count: 6, substituted_roles: [], deductions: [] },
    ];
    expect(boardHtml(board({ ranking: clean }))).toContain('nothing came off this card');
  });
});

describe('the ledger is in the document, open or not', () => {
  it('renders every cut, the cluster and the floor without a second request', () => {
    const html = boardHtml();
    expect(html).toContain('<details');
    // A ledger that only existed after a click would not survive being a cached
    // static document, and could not be found with ctrl-F.
    expect(html).toContain('Judged inside');
    expect(html).toContain('Over-the-air updates');
    expect(html).toContain('Auditable, and it skips review.');
    expect(html).toContain('Priya Raghunathan');
    expect(html).toContain('1st · 55');
    expect(html).toContain('<span class="p second">2nd</span>');
  });

  it('names the jurors who did not answer instead of publishing a silent 50', () => {
    expect(textOf(boardHtml())).toContain('no answer from The Docs Writer — substituted 50');
  });

  it('surfaces an injection-alarm hit as logged, not dropped', () => {
    const html = boardHtml();
    expect(html).toContain('logged, not dropped');
    expect(textOf(html)).toContain("The Terminal Minimalist matched “prompt”");
  });

  it('states the cuts in Part 5’s register', () => {
    expect(textOf(boardHtml())).toContain('Runlet took 97 in cuts');
  });
});

describe('a solo cluster is a stated property', () => {
  it('marks the row and carries the explanation with the mark', () => {
    const html = boardHtml();
    expect(html).toContain('solo cluster');
    // The tag's title and the ledger's note are the same sentence.
    const note = `EU-hosted mobile push is a cluster of one — ${SOLO_NOTE}.`;
    expect(textOf(html)).toContain(note);
    expect(html).toContain('class="tag solo" title=');
    expect(html).toContain('class="flag"');
  });

  it('never shows a demand number for a row the floor never judged', () => {
    // The hostile row is the solo one; its demand cell reads `none`, not `0.00`.
    expect(boardHtml()).toContain('class="v none">none');
  });

  it('states the count at board level, on both surfaces', () => {
    expect(textOf(boardHtml())).toContain('Ranked on merit alone 1 / 3');
    expect(textOf(homeHtml())).toContain('1 of 3 faced no substitute and rank on merit alone');
  });

  it('is stated as a property, never as a failure', () => {
    const html = boardHtml();
    // The mark is the gold `--coin` tag, the same treatment the footer's
    // solo-cluster count uses. It is not a warning, an alert or a blank.
    expect(html).toContain('<span class="tag solo"');
    expect(html).toContain('<span class="v solo">1 / 3</span>');
    const text = textOf(html);
    for (const wrong of ['unavailable', 'not available', 'no data', 'n/a', 'failed', 'incomplete']) {
      expect(text.toLowerCase(), wrong).not.toContain(wrong);
    }
  });
});

describe('user-submitted text is escaped', () => {
  it('never emits a raw tag from a product name', () => {
    for (const html of [boardHtml(), homeHtml()]) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x onerror');
      expect(html).toContain('&lt;script&gt;alert(&quot;pit&quot;)&lt;/script&gt;');
      // And the name is still readable once decoded.
      expect(textOf(html)).toContain(HOSTILE_NAME);
    }
  });

  it('never turns a javascript: URL into an href', () => {
    const html = boardHtml();
    expect(html).not.toContain('href="javascript:');
    // It is still shown, as text, so a reader can see what was submitted.
    expect(html).toContain('javascript:alert(document.domain)');
    expect(html).toContain('href="https://ashgrove.example/"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('the board refuses to promise a rank', () => {
  it('stamps itself with a time, a product count and the sentence that says why', () => {
    const text = textOf(boardHtml());
    expect(text).toContain('Developer Tools · 3 products · ranked 29 Aug 2026, 14:05 UTC');
    expect(text).toContain(STAMP_NOTE);
  });

  it('publishes the health numbers and the seeding caveat verbatim', () => {
    const text = textOf(boardHtml());
    expect(text).toContain('Discrimination 0.74');
    expect(text).toContain('Avg metric spread 6.2');
    expect(text).toContain(SAMPLE_CAVEAT);
  });

  it('says the provenance is unknown rather than rendering a clean footer', () => {
    const text = textOf(boardHtml(board({ caveat: undefined })));
    expect(text).toContain('This run stored no seeding provenance');
  });
});

describe('panel labels follow the category type', () => {
  it('uses the B2B register on a B2B board and the loud one on a consumer board', () => {
    expect(panelLabels('b2b')).toEqual({ critics: 'The Panel', buyers: 'The Buyers' });
    expect(panelLabels('consumer')).toEqual({ critics: 'The Six', buyers: 'The Floor' });
    expect(textOf(boardHtml())).toContain('The Buyers: Priya Raghunathan · Deniz Aksoy');
  });
});

describe('the homepage board', () => {
  it('rotates categories rather than ranks: no row is keyed to a position it might lose', () => {
    const html = homeHtml();
    // The progress bar is the rotation's clock. It exists; nothing else animates.
    expect(html).toContain('class="prog"');
    expect(html).toContain('role="tablist"');
    // No expandable ledger on the homepage — the row links out to the full board.
    expect(html).not.toContain('<details');
    expect(html).toContain('href="/boards/developer-tools"');
  });

  it('leads every row with a cut and keeps the numbers small', () => {
    const text = textOf(homeHtml());
    expect(text).toContain('Product · the cut that hurt most, and who took it');
    expect(text).toContain('No trigger event anywhere in the pitch. The Seed Investor · Problem Sharpness');
    // The two numbers a reader could confuse are told apart in words: −40 is one
    // juror's cut, −25 is what came off the whole card.
    expect(text).toContain(HOME_LEGEND);
    expect(text).not.toContain('Open a row for the ledger');
  });

  it('fills the strip with real cuts and their jurors, and calls them nothing else', () => {
    const html = homeHtml();
    const text = textOf(html);
    expect(text).toContain('Cuts on the record');
    expect(text).toContain('nothing here is a rank');
    // The line is now a figure, a pairing, a quote and the product it came off,
    // rather than one run-on sentence. All four are still the real ones.
    expect(text).toContain('Cron with a graph is a feature, not a product.');
    expect(text).toContain('The Weekend Shipper · Problem Sharpness');
    expect(text).toContain('Runlet · Developer Tools');
    // And the quote is inside the same list item as the deduction that produced
    // it, so no restyle can leave a number stranded from its reason.
    const item = /<li[^>]*>([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
    expect(textOf(item)).toMatch(/−97.*Weekend Shipper.*Cron with a graph/s);
  });

  it('never claims a verdict has arrived, whatever the strip is called', () => {
    // The canvas calls this panel LIVE CUTS with a pulsing dot. Nothing has
    // landed — checkout is wired and no placement has run — so the panel keeps
    // the shape and drops the claim. This is the one dishonest thing available
    // on a page whose argument is that the board cannot be bought.
    const text = textOf(homeHtml()).toLowerCase();
    for (const lie of ['live', 'just now', 'arriving', 'in the pit now', 'runs live']) {
      expect(text, `the strip must not say "${lie}"`).not.toContain(lie);
    }
  });
});

describe('the board leads with health, and says what health is not', () => {
  it('prints the mean metric score at the end of every row, labelled', () => {
    const html = boardHtml();
    // Ashgrove kept 75 of 100, the hostile row 50, Runlet 3. The figures on the
    // page are those, and they are the head of the bar drawn beside them.
    const cells = [...html.matchAll(/class="cell health"[^>]*>(?:.*?)<span class="v">(\d+)<\/span>/g)].map(
      (found) => found[1],
    );
    expect(cells).toEqual(['75', '50', '3']);
    expect(textOf(html)).toContain('health 75');
  });

  it('keeps `cuts` on the surface, because Part 5 fixes the connective word', () => {
    const text = textOf(boardHtml());
    // Still the column header, still a number on the row, still the lead, still
    // the caption. It moved off the loud slot; it did not leave.
    expect(text).toContain('Cuts');
    expect(text).toContain('cuts −25');
    expect(text).toContain('Runlet took 97 in cuts');
  });

  it('draws the meter head as the health figure, exactly', () => {
    // The claim the whole redesign rests on: the wide block on the left IS the
    // number on the right. If the caption and the width ever disagree the bar is
    // arguing with itself and nothing else in the suite would catch it.
    const html = boardHtml();
    const heads = (pattern: RegExp): number[] =>
      [...html.matchAll(pattern)].map((found) => Math.round(Number(found[1])));

    expect(heads(/class="meter"[^>]*><i class="kept" style="width:([\d.]+)%"/g)).toEqual([75, 50, 3]);
    expect(textOf(html)).toContain('75 of 100 health left');

    // One level down, the same head is the metric's own surviving score. Ashgrove
    // scored 60 and 90 and its ledger opens on the heavier loss, so 60 leads.
    expect(heads(/class="jurorbar"[^>]*><i class="kept" style="width:([\d.]+)%"/g)).toEqual([60, 90, 50, 3]);
  });

  it('states that health is not the sort order, on both surfaces', () => {
    // The one place the canvas overreaches for this board: it ranks on health,
    // and we rank on `core`. Showing a health column without saying so would be
    // publishing a ranking rule the engine does not run.
    for (const html of [boardHtml(), homeHtml()]) {
      expect(textOf(html)).toContain(HEALTH_NOTE);
    }
    expect(HEALTH_NOTE).toContain('not the sort order');
  });

  it('publishes the board’s own median health, computed from its rows', () => {
    // 75, 50, 3 -> 50. Not the mean (42.7), and not a number typed into the JSX.
    expect(textOf(boardHtml())).toContain('Median health 50.0');
  });
});
