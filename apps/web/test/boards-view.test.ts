/**
 * The board projection, against hand-derived expectations.
 *
 * Every number asserted here was worked out from `sampleRanking()` on paper (the
 * table in `test/helpers/boards.ts`), not read off a previous run. A test that
 * records what the code did cannot catch the code doing the wrong thing.
 */

import { describe, expect, it } from 'vitest';

import { SOLO_NOTE } from '@/lib/boards/copy';
import { toHomeBoard, tickerLines } from '@/lib/boards/home';
import { depthOf, metricLabel, stampUtc, toBoardView } from '@/lib/boards/view';

import { HOSTILE_NAME, HOSTILE_URL, sampleRanking, SAMPLE_CAVEAT } from './helpers/boards';

function view() {
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
  });
}

describe('cuts — 100 minus the mean metric score', () => {
  it('is derived from the scorecard means, not from the sum of the ledger', () => {
    const rows = view().rows;
    // Ashgrove: (60 + 90) / 2 = 75 kept, so 25 came off. Its ledger sums to 70,
    // which is a different quantity and must not be what the board shows.
    expect(rows[0]?.cuts).toBeCloseTo(25, 10);
    // The hostile row: one metric at 50.
    expect(rows[1]?.cuts).toBeCloseTo(50, 10);
    // `brief` Part 5's own example: "Runlet took 97 in cuts."
    expect(rows[2]?.cuts).toBeCloseTo(97, 10);
  });

  it('counts every deduction on the card', () => {
    expect(view().rows[0]?.deductionCount).toBe(3);
  });
});

describe('the headline cut — a reason, with the juror who took it', () => {
  it('is the heaviest single deduction anywhere on the card', () => {
    const headline = view().rows[0]?.headline;
    expect(headline).toEqual({
      points: 40,
      reason: 'No trigger event anywhere in the pitch.',
      role: 'The Seed Investor',
      metric: 'Problem Sharpness',
    });
  });

  it('carries the metric it came off, so the row can name where it landed', () => {
    expect(view().rows[2]?.headline?.metric).toBe('Problem Sharpness');
    expect(view().rows[2]?.headline?.role).toBe('The Weekend Shipper');
  });
});

describe('ledger ordering — heaviest loss first', () => {
  it('sorts metrics by what they cost, not by the order they were stored', () => {
    // The fixture stores Workflow Fit (10 lost) before Problem Sharpness (40).
    expect(view().rows[0]?.metrics.map((metric) => metric.metric)).toEqual([
      'Problem Sharpness',
      'Workflow Fit',
    ]);
    expect(view().rows[0]?.metrics.map((metric) => metric.cuts)).toEqual([40, 10]);
  });

  it('sorts deductions inside a metric heaviest first', () => {
    expect(view().rows[0]?.metrics[0]?.deductions.map((deduction) => deduction.points)).toEqual([40, 20]);
  });

  it('keeps every juror attached to their own deduction', () => {
    expect(view().rows[0]?.metrics[0]?.deductions.map((deduction) => deduction.role)).toEqual([
      'The Seed Investor',
      'The Release Engineer',
    ]);
  });

  it('never re-sorts the rows themselves — the board order is the engine answer', () => {
    expect(view().rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });
});

describe('solo clusters are a stated property, not an error', () => {
  it('marks the row and gives it the sentence that explains the mark', () => {
    const row = view().rows[1];
    expect(row?.soloCluster).toBe(true);
    expect(row?.demandDetail).toBeUndefined();
    expect(row?.demand).toBeUndefined();
    expect(row?.soloNote).toBe(`EU-hosted mobile push is a cluster of one — ${SOLO_NOTE}.`);
  });

  it('leaves a scored row with no solo note at all', () => {
    expect(view().rows[0]?.soloCluster).toBe(false);
    expect(view().rows[0]?.soloNote).toBeUndefined();
  });

  it('counts them at board level', () => {
    const board = view();
    expect(board.soloCount).toBe(1);
    expect(board.tiebrokenCount).toBe(1);
    expect(board.productCount).toBe(3);
  });
});

describe('user-submitted URLs', () => {
  it('refuses to make an href out of anything but http(s)', () => {
    const row = view().rows[1];
    expect(row?.href).toBeUndefined();
    // Still shown, so a reader can see what was actually submitted.
    expect(row?.url).toBe(HOSTILE_URL);
  });

  it('keeps an ordinary https URL', () => {
    expect(view().rows[0]?.href).toBe('https://ashgrove.example/');
  });
});

describe('injection alarm hits ride with their product', () => {
  it('attaches by product id, and only to that product', () => {
    const board = view();
    expect(board.rows[0]?.flagged).toEqual([]);
    expect(board.rows[1]?.flagged).toEqual([]);
    expect(board.rows[2]?.flagged).toEqual([
      {
        source: 'The Terminal Minimalist',
        reason: "'describe it, get a site' is a prompt-wrapper.",
        matched: 'prompt',
      },
    ]);
    expect(board.flaggedCount).toBe(1);
  });
});

describe('the board carries its own provenance', () => {
  it('echoes the versions, the weights and the caveat without inventing any', () => {
    const board = view();
    expect(board.promptVersion).toBe('v2');
    expect(board.demandVersion).toBe('v1');
    expect(board.categoryVersion).toBe('v2');
    expect(board.engineVersion).toBe('0.1.0-test');
    expect(board.caveat).toBe(SAMPLE_CAVEAT);
    expect(board.weights).toEqual({ merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 });
    expect(board.personas).toEqual(['Priya Raghunathan', 'Deniz Aksoy']);
  });

  it('leaves the caveat undefined when the run stored none, rather than filling one in', () => {
    const board = toBoardView({
      slug: 'developer-tools',
      category: 'Developer Tools',
      generatedAt: '2026-08-29T14:05:00.000Z',
      productCount: 3,
      categoryVersion: 'v2',
      origin: 'snapshot',
      ranking: sampleRanking(),
    });
    expect(board.caveat).toBeUndefined();
    expect(board.engineVersion).toBeUndefined();
  });
});

describe('display helpers', () => {
  it('darkens rows from the surface to the bottom of the pit', () => {
    expect(depthOf(0, 3)).toBe('0.000');
    expect(depthOf(1, 3)).toBe('0.500');
    expect(depthOf(2, 3)).toBe('1.000');
    // A board of one has no descent to render.
    expect(depthOf(0, 1)).toBe('0');
  });

  it('prettifies a metric name for display without changing it', () => {
    expect(metricLabel('claim_backing')).toBe('Claim backing');
    expect(metricLabel('Problem Sharpness')).toBe('Problem Sharpness');
  });

  it('stamps in UTC, so the server and the browser agree', () => {
    expect(stampUtc('2026-08-29T14:05:00.000Z')).toBe('29 Aug 2026, 14:05 UTC');
    expect(stampUtc('not a date')).toBe('not a date');
  });
});

describe('the homepage slice', () => {
  it('keeps only the rows the homepage shows, and drops the ledgers it does not', () => {
    const home = toHomeBoard(view(), 2);
    expect(home.rows).toHaveLength(2);
    expect(home.rows[0]?.headline?.role).toBe('The Seed Investor');
    expect(home.soloCount).toBe(1);
    expect(home.productCount).toBe(3);
    // The whole point of the slice: no juror prose from rows 3+ in the payload.
    expect(JSON.stringify(home)).not.toContain('Cron with a graph');
  });

  it('carries the meter\u2019s per-metric losses, and no more of the ledger than that', () => {
    // The rule this replaced an `expect(metrics).toEqual([])` with. The homepage
    // now draws the cut meter, whose segment widths ARE the per-metric losses, so
    // the slice cannot be empty here. What it still must not carry is the ledger:
    // a row averages thirty reasons on the real boards and the payload keeps one
    // per metric, for the segment's tooltip.
    const full = view();
    const home = toHomeBoard(full, 2);

    const row = home.rows[0];
    const source = full.rows[0];
    expect(row?.metrics.map((metric) => metric.cuts)).toEqual(source?.metrics.map((metric) => metric.cuts));

    for (const metric of row?.metrics ?? []) {
      expect(metric.deductions.length).toBeLessThanOrEqual(1);
    }
    // The count under the bar still counts every reason, not the ones kept.
    expect(row?.deductionCount).toBe(source?.deductionCount);
    expect(row?.deductionCount).toBeGreaterThan(
      (row?.metrics ?? []).reduce((total, metric) => total + metric.deductions.length, 0),
    );
  });

  it('builds the strip from real cuts, heaviest first, each with its juror', () => {
    const lines = tickerLines([view()], 2);
    expect(lines.map((line) => line.points)).toEqual([97, 50]);
    expect(lines[0]).toEqual({
      product: 'Runlet',
      category: 'Developer Tools',
      slug: 'developer-tools',
      points: 97,
      reason: 'Cron with a graph is a feature, not a product.',
      role: 'The Weekend Shipper',
    });
    expect(lines[1]?.product).toBe(HOSTILE_NAME);
  });
});
