import { describe, expect, it } from 'vitest';

import { describeLeak, leakReport } from '../../src/report/leak.js';
import type { Product, RankedProduct } from '../../src/types.js';

/**
 * The leak test — Spearman between our board and outbid's `orig_rank`.
 *
 * The sign conventions are the whole risk here: `orig_rank` and our `rank` are
 * both 1-is-best POSITIONS, while `composite` and `core` are higher-is-better
 * SCORES. So agreement shows up as +1 on the rank-vs-rank pair and -1 on the
 * score-vs-rank pairs, and a sign error would turn "we agree with outbid" into
 * "we reversed them" with no test failing. Every case below pins both signs.
 */

function product(id: number, origRank: number): Product {
  return {
    id,
    name: `P${id}`,
    description: 'x',
    url: `https://example.com/${id}`,
    normalized_url: `example.com/${id}`,
    orig_rank: origRank,
  };
}

function row(id: number, rank: number, composite: number, core: number): RankedProduct {
  return {
    id,
    name: `P${id}`,
    url: `https://example.com/${id}`,
    rank,
    composite,
    demand_status: 'solo_cluster',
    core,
    tiebroken: false,
    scorecard: [],
    cluster: { id: `c${id}`, label: '', size: 1, uniqueness: 50, reason: '' },
  };
}

// Ids 0..3 with orig_rank 1..4 — the real ingest's relationship, where
// `Product.id` is a 0-based index into rows already sorted by `Rank`.
const PRODUCTS = [product(0, 1), product(1, 2), product(2, 3), product(3, 4)];

describe('leakReport', () => {
  it('reports perfect agreement with both signs the right way round', () => {
    // Our order matches outbid's exactly.
    const rows = [row(0, 1, 2, 1.0), row(1, 2, 1, 0.5), row(2, 3, 0, 0.0), row(3, 4, -1, -0.5)];
    const report = leakReport(rows, PRODUCTS);

    expect(report.n).toBe(4);
    // rank [1,2,3,4] vs orig_rank [1,2,3,4] -> +1
    expect(report.final_rank_vs_orig_rank).toBeCloseTo(1, 12);
    // composite ranks ascending [4,3,2,1] vs orig ranks [1,2,3,4] -> -1
    expect(report.merit_vs_orig_rank).toBeCloseTo(-1, 12);
    expect(report.core_vs_orig_rank).toBeCloseTo(-1, 12);
    expect(report.top_ten_size).toBe(4);
    expect(report.top_ten_overlap).toBe(4);
  });

  it('reports perfect disagreement with both signs flipped', () => {
    // Our board is outbid's exactly reversed.
    const rows = [row(0, 4, -1, -0.5), row(1, 3, 0, 0.0), row(2, 2, 1, 0.5), row(3, 1, 2, 1.0)];
    const report = leakReport(rows, PRODUCTS);

    expect(report.final_rank_vs_orig_rank).toBeCloseTo(-1, 12);
    expect(report.merit_vs_orig_rank).toBeCloseTo(1, 12);
  });

  it('states the residual numeric channel: id is +1 correlated with orig_rank', () => {
    // This is the fact the whole section is about. `Product.id` is assigned
    // AFTER sorting by the sheet's Rank, so a model reading `[id N]` markers can
    // recover the incoming order regardless of what order the prompt renders in.
    const rows = [row(0, 3, 0, 0), row(1, 1, 2, 1), row(2, 4, -1, -1), row(3, 2, 1, 0.5)];
    expect(leakReport(rows, PRODUCTS).id_vs_orig_rank).toBeCloseTo(1, 12);
  });

  it('matches a hand-computed partial agreement', () => {
    // our rank  [1, 3, 2, 4]  (ids 0..3)
    // orig rank [1, 2, 3, 4]
    // Both are already ranks, so Spearman is Pearson over them directly:
    //   dx = [-1.5, 0.5, -0.5, 1.5]   (mean 2.5)
    //   dy = [-1.5, -0.5, 0.5, 1.5]   (mean 2.5)
    //   sum dx*dy = 2.25 - 0.25 - 0.25 + 2.25 = 4
    //   sum dx^2 = sum dy^2 = 2.25 + 0.25 + 0.25 + 2.25 = 5
    //   r = 4 / 5 = 0.8
    const rows = [row(0, 1, 2, 1), row(1, 3, 0, 0), row(2, 2, 1, 0.5), row(3, 4, -1, -0.5)];
    expect(leakReport(rows, PRODUCTS).final_rank_vs_orig_rank).toBeCloseTo(0.8, 12);
  });

  it('drops a board row with no product, so a later placement cannot skew it', () => {
    // Product 99 has no `orig_rank` from the source sheet's population.
    const rows = [row(0, 1, 2, 1), row(99, 2, 1, 0.5), row(1, 3, 0, 0)];
    const report = leakReport(rows, PRODUCTS);
    expect(report.n).toBe(2);
  });

  it('windows the top-ten overlap to the board size', () => {
    const rows = [row(0, 1, 2, 1), row(1, 2, 1, 0.5)];
    const report = leakReport(rows, [product(0, 1), product(1, 2)]);
    expect(report.top_ten_size).toBe(2);
    expect(report.top_ten_overlap).toBe(2);
  });

  it('is 0, not NaN, on an empty board', () => {
    const report = leakReport([], PRODUCTS);
    expect(report.n).toBe(0);
    expect(report.final_rank_vs_orig_rank).toBe(0);
  });
});

describe('describeLeak', () => {
  const base = {
    n: 44,
    merit_vs_orig_rank: 0,
    core_vs_orig_rank: 0,
    id_vs_orig_rank: 1,
    top_ten_overlap: 3,
    top_ten_size: 10,
  };

  it('never presents a correlation as proof of a leak', () => {
    const text = describeLeak({ ...base, final_rank_vs_orig_rank: 0.95 });
    expect(text).toContain('cannot on its own separate');
    expect(text).toContain('some positive agreement is expected');
    // The word "leak" appears only inside the disclaimer, never as a verdict.
    expect(text).not.toMatch(/is a leak|evidence of a leak|leaked into/);
  });

  it('scales its language with the magnitude', () => {
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.05 })).toContain('essentially unrelated to');
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.3 })).toContain('weakly related to');
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.5 })).toContain('moderately related to');
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.7 })).toContain('strongly related to');
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.95 })).toContain('almost the same as');
  });

  it('says which direction the agreement runs', () => {
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: 0.7 })).toContain('agrees with');
    expect(describeLeak({ ...base, final_rank_vs_orig_rank: -0.7 })).toContain('runs opposite to');
  });

  it('states the number and the population it was taken over', () => {
    const text = describeLeak({ ...base, final_rank_vs_orig_rank: 0.6123 });
    expect(text).toContain('0.6123');
    expect(text).toContain('44 products');
    expect(text).toContain('3 of our top 10');
  });
});
