import { describe, expect, it } from 'vitest';

import { AB_SAMPLE } from '../../src/config/constants.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import { categorySlug } from '../../src/panels/seeded.js';
import { runAbCheck, selectTargets, summarizeAb, sumLedgers } from '../../src/report/ab-check.js';
import type { AbProduct } from '../../src/report/ab-check.js';
import { buildLedger, zeroCost } from '../../src/run/ledger.js';
import { runCategory } from '../../src/run/run-category.js';
import { MemoryRunStore } from '../../src/run/store.js';
import type { CostLedger } from '../../src/run/types.js';
import type { Ranking } from '../../src/types.js';
import { CATEGORY, CATEGORY_VERSION, JURY, PANEL, makeProducts, makeScript } from '../helpers/run-fixtures.js';

/**
 * The fix-1.1 A/B and its test-retest floor.
 *
 * The pure pieces — target selection and the summary arithmetic — are checked
 * against hand-computed expectations. The end-to-end check runs the whole thing
 * against the fixture client, offline and with no API key, and asserts the two
 * properties that make the comparison meaningful: both paths end with the target
 * in a category of the SAME size, and a difference that exists on one path but
 * not the other is separated from same-path noise.
 */

const SEED_SIZE = 12;
const PLACEMENT = { cluster_id: 'pair-0', uniqueness_score: 35, reason: 'several tools already do this' };

/** A minimal ranking with `n` rows, ranked 1..n, for the selector tests. */
function rankingOf(n: number): Ranking {
  return {
    category: CATEGORY,
    prompt_version: 'v1',
    uniqueness_version: 'v1',
    demand_version: 'v1',
    type: 'consumer',
    weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
    personas: [],
    metrics: [],
    clusters: [],
    ranking: Array.from({ length: n }, (_, index) => ({
      id: index,
      name: `P${index}`,
      url: `https://example.com/${index}`,
      rank: index + 1,
      composite: n - index,
      demand_status: 'solo_cluster' as const,
      core: n - index,
      tiebroken: false,
      scorecard: [],
      cluster: { id: `c${index}`, label: '', size: 1, uniqueness: 50, reason: '' },
    })),
    health: { avg_metric_spread: 0, discrimination: 0, demand_discrimination: 0, tiebreak_count: 0 },
    flaggedInjections: [],
  };
}

describe('selectTargets', () => {
  const slug = categorySlug(CATEGORY);

  it('takes exactly one product from each band of the board', () => {
    // 10 rows into 5 bands is [2, 2, 2, 2, 2], so target i must have rank
    // 2i+1 or 2i+2. That is the "do not take the top 5" guarantee, and it is
    // checkable by hand without predicting the PRNG.
    const targets = selectTargets(rankingOf(10), 5, slug, CATEGORY_VERSION);
    expect(targets).toHaveLength(5);

    const board = rankingOf(10).ranking;
    targets.forEach((id, band) => {
      const rank = board.find((entry) => entry.id === id)?.rank ?? 0;
      expect(rank).toBeGreaterThanOrEqual(band * 2 + 1);
      expect(rank).toBeLessThanOrEqual(band * 2 + 2);
    });
  });

  it('spans the whole board rather than clustering at one end', () => {
    // With bands of 2 over 10 rows, the first target is in ranks 1-2 and the
    // last in ranks 9-10, whatever the PRNG returns.
    const targets = selectTargets(rankingOf(10), 5, slug, CATEGORY_VERSION);
    const board = rankingOf(10).ranking;
    const ranks = targets.map((id) => board.find((entry) => entry.id === id)?.rank ?? 0);
    expect(Math.min(...ranks)).toBeLessThanOrEqual(2);
    expect(Math.max(...ranks)).toBeGreaterThanOrEqual(9);
  });

  it('is deterministic for a category at a version', () => {
    const first = selectTargets(rankingOf(44), AB_SAMPLE, slug, CATEGORY_VERSION);
    const second = selectTargets(rankingOf(44), AB_SAMPLE, slug, CATEGORY_VERSION);
    expect(second).toEqual(first);
  });

  it('redraws when the category version moves', () => {
    // A different snapshot is a different population, so a different sample is
    // correct. Pinned so a re-roll cannot be passed off as a version bump.
    const v1 = selectTargets(rankingOf(44), AB_SAMPLE, slug, 'v1');
    const v2 = selectTargets(rankingOf(44), AB_SAMPLE, slug, 'v2');
    expect(v2).not.toEqual(v1);
  });

  it('returns every product when the board is no larger than the sample', () => {
    expect(selectTargets(rankingOf(3), 5, slug, CATEGORY_VERSION)).toEqual([0, 1, 2]);
  });

  it('never returns a duplicate', () => {
    const targets = selectTargets(rankingOf(44), AB_SAMPLE, slug, CATEGORY_VERSION);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('summarizeAb', () => {
  function product(abDeltas: Record<string, number>, retestDeltas: Record<string, number>, abRank: number, retestRank: number): AbProduct {
    const path = { metrics: {}, rank: 1, composite: 0, category_size: 10 };
    const meanAbs = (deltas: Record<string, number>): number => {
      const values = Object.values(deltas).map(Math.abs);
      return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    return {
      id: 0,
      name: 'P',
      batch: path,
      incremental: path,
      retest: path,
      metric_delta_ab: abDeltas,
      metric_delta_retest: retestDeltas,
      mean_abs_metric_delta_ab: meanAbs(abDeltas),
      mean_abs_metric_delta_retest: meanAbs(retestDeltas),
      rank_delta_ab: abRank,
      rank_delta_retest: retestRank,
      calibration_peers: 15,
      calibration_version: 'v1:abcd',
    };
  }

  it('averages the per-product means and reports the ratio', () => {
    // Product 1: |Δ| A/B over metrics [4, -4] -> 4 ; retest [1, -1] -> 1
    // Product 2: |Δ| A/B over metrics [2, -2] -> 2 ; retest [1, -1] -> 1
    //   mean A/B    = (4 + 2) / 2 = 3
    //   mean retest = (1 + 1) / 2 = 1
    //   ratio = 3 / 1 = 3
    // Rank deltas: A/B [2, -4] -> mean |Δ| = 3 ; retest [0, 2] -> mean 1.
    const summary = summarizeAb([
      product({ a: 4, b: -4 }, { a: 1, b: -1 }, 2, 0),
      product({ a: 2, b: -2 }, { a: 1, b: -1 }, -4, 2),
    ]);

    expect(summary.mean_abs_metric_delta_ab).toBeCloseTo(3, 12);
    expect(summary.mean_abs_metric_delta_retest).toBeCloseTo(1, 12);
    expect(summary.metric_delta_ratio).toBeCloseTo(3, 12);
    expect(summary.mean_abs_rank_delta_ab).toBeCloseTo(3, 12);
    expect(summary.mean_abs_rank_delta_retest).toBeCloseTo(1, 12);
    expect(summary.rank_delta_ratio).toBeCloseTo(3, 12);
    expect(summary.ab_exceeds_retest).toBe(true);
    expect(summary.reading).toContain('LARGER than the test-retest floor');
  });

  it('says the paths are indistinguishable when the A/B does not exceed the floor', () => {
    // A/B mean 1, retest mean 2. The A/B "difference" is smaller than what
    // resampling one path does, which is the outcome fix 1.1 was aiming at.
    const summary = summarizeAb([product({ a: 1 }, { a: 2 }, 0, 0)]);
    expect(summary.ab_exceeds_retest).toBe(false);
    expect(summary.reading).toContain('NOT larger than the test-retest floor');
    expect(summary.reading).toContain('which is what fix 1.1 was for');
  });

  it('refuses to conclude anything when both floors are exactly 0', () => {
    // A deterministic client produces this. It is NOT evidence that the fix
    // worked, and the wording must not let it read as such.
    const summary = summarizeAb([product({ a: 0 }, { a: 0 }, 0, 0)]);
    expect(summary.metric_delta_ratio).toBe(1);
    expect(summary.reading).toContain('deterministic client');
    expect(summary.reading).toContain('Nothing can be concluded');
  });

  it('reports an infinite ratio rather than NaN when only the floor is 0', () => {
    const summary = summarizeAb([product({ a: 5 }, { a: 0 }, 0, 0)]);
    expect(summary.metric_delta_ratio).toBe(Infinity);
  });

  it('says there is no evidence at all when no target completed', () => {
    const summary = summarizeAb([]);
    expect(summary.reading).toContain('no fix-1.1 evidence');
  });
});

describe('sumLedgers', () => {
  it('adds calls, tokens and dollars phase by phase', () => {
    const one: CostLedger = buildLedger({
      score: { ...zeroCost(), calls: 6, cost_usd: 0.1, usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 } },
      uniqueness: { ...zeroCost(), calls: 1, cost_usd: 0.05 },
      customer: zeroCost(),
    });
    const two: CostLedger = buildLedger({
      score: { ...zeroCost(), calls: 6, cost_usd: 0.2, usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 } },
      uniqueness: zeroCost(),
      customer: { ...zeroCost(), calls: 4, cost_usd: 0.4 },
    });

    const total = sumLedgers([one, two]);
    // score 6+6=12 calls, $0.30, 300 input, 30 output, 12 cache read.
    expect(total.phases.score.calls).toBe(12);
    expect(total.phases.score.cost_usd).toBeCloseTo(0.3, 12);
    expect(total.phases.score.usage.input_tokens).toBe(300);
    expect(total.phases.score.usage.cache_read_input_tokens).toBe(12);
    // Grand total: 12 + 1 + 4 = 17 calls, $0.10+$0.05+$0.20+$0.40 = $0.75.
    expect(total.total.calls).toBe(17);
    expect(total.total.cost_usd).toBeCloseTo(0.75, 12);
  });

  it('carries an unpriced model id through to the total, without duplicating it', () => {
    const unpriced = buildLedger({
      score: { ...zeroCost(), calls: 1, unpriced_models: ['local-subagent'] },
      uniqueness: zeroCost(),
      customer: zeroCost(),
    });
    const total = sumLedgers([unpriced, unpriced]);
    expect(total.phases.score.unpriced_models).toEqual(['local-subagent']);
    expect(total.total.unpriced_models).toEqual(['local-subagent']);
  });

  it('is zero for no ledgers at all', () => {
    expect(sumLedgers([]).total.calls).toBe(0);
  });
});

describe('runAbCheck — end to end, offline', () => {
  const products = makeProducts(SEED_SIZE);
  const config = { categoryVersion: CATEGORY_VERSION };

  it('scores each target on both paths, in categories of equal size', async () => {
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT })),
      config,
      sampleSize: 3,
    });

    expect(result.failures).toEqual([]);
    expect(result.products).toHaveLength(3);
    expect(result.category_size).toBe(SEED_SIZE);

    for (const product of result.products) {
      // The leave-one-out design exists for exactly this: a rank out of 12 in
      // one path compared against a rank out of 12 in the other. Without it the
      // rank delta would be mostly arithmetic.
      expect(product.batch.category_size).toBe(SEED_SIZE);
      expect(product.incremental.category_size).toBe(SEED_SIZE);
      expect(product.retest.category_size).toBe(SEED_SIZE);
      // The incremental path must have shown the juror actual peers, or the fix
      // was not applied and the A/B measures nothing.
      expect(product.calibration_peers).toBeGreaterThan(0);
      expect(product.calibration_version).not.toBe('');
    }
  });

  it('separates a real path difference from same-path noise', async () => {
    // The fixture shifts every score by -10 when — and ONLY when — the prompt
    // carries the calibration block, so the calibrated incremental path differs
    // from the batch path by exactly 10 points on every metric while two runs of
    // the incremental path are identical.
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(
        makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT, calibrationShift: -10 }),
      ),
      config,
      sampleSize: 2,
    });

    // Every scored metric moved by exactly -10 on the A/B, and not at all on
    // the retest. Base scores are 41..100 and the shift is -10, so no cell is
    // clamped and the delta is exact.
    for (const product of result.products) {
      for (const delta of Object.values(product.metric_delta_ab)) expect(delta).toBe(-10);
      for (const delta of Object.values(product.metric_delta_retest)) expect(delta).toBe(0);
    }

    expect(result.summary.mean_abs_metric_delta_ab).toBeCloseTo(10, 12);
    expect(result.summary.mean_abs_metric_delta_retest).toBe(0);
    expect(result.summary.metric_delta_ratio).toBe(Infinity);
    expect(result.summary.ab_exceeds_retest).toBe(true);
  });

  it('reports zero on both sides against a fully deterministic panel, and says so', async () => {
    // With no calibration shift the fixture returns the identical number on both
    // paths. That is NOT evidence the fix worked, and the reading must say so.
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT })),
      config,
      sampleSize: 2,
    });

    expect(result.summary.mean_abs_metric_delta_ab).toBe(0);
    expect(result.summary.mean_abs_metric_delta_retest).toBe(0);
    expect(result.summary.reading).toContain('Nothing can be concluded');
  });

  it('measures what the evidence itself cost', async () => {
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(
        makeScript({
          clusterPlan: 'pairs',
          assignAnswer: PLACEMENT,
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 },
        }),
      ),
      config,
      sampleSize: 2,
    });

    // One batch run + two leave-one-out seeds + four placements, all billed.
    expect(result.cost.total.calls).toBeGreaterThan(0);
    expect(result.cost.basis).toBe('measured');
    expect(result.cost.total.usage.input_tokens).toBeGreaterThan(0);
  });

  it('carries an unmeasurable cost through rather than printing $0.00 as fact', async () => {
    // The Task 9 case: a responder that cannot report a priced model id.
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(
        makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT, modelId: 'local-subagent' }),
      ),
      config,
      sampleSize: 1,
    });

    expect(result.cost.basis).toBe('unmeasured');
    expect(result.cost.note).toContain('not $0.00');
  });

  it('refuses to report an A/B whose A side never ran', async () => {
    // An A/B with no A reads as "no difference", which is the most dangerous
    // possible wrong answer here.
    await expect(
      runAbCheck({
        category: CATEGORY,
        products,
        jury: JURY,
        personas: PANEL,
        client: new FixtureClient(
          makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT, uniquenessError: () => new Error('nope') }),
        ),
        config,
        sampleSize: 2,
      }),
    ).rejects.toThrow(/no A side to compare against/);
  });

  it('records a target that could not be placed instead of dropping it silently', async () => {
    // A placement that names a cluster the roster does not have fails
    // validation, so the target has no B side. It must appear in `failures`,
    // not merely be absent from `products`.
    const result = await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(
        makeScript({ clusterPlan: 'pairs', assignAnswer: { cluster_id: 'no-such-cluster', uniqueness_score: 50, reason: 'x' } }),
      ),
      config,
      sampleSize: 2,
    });

    expect(result.products).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain('incremental placement failed');
  });

  it('never writes to the category\'s own run artifacts', async () => {
    // The A/B's runs are throwaway. Folding their scores into results.json would
    // corrupt the integrity record `brief` Part 7 relies on.
    const store = new MemoryRunStore(CATEGORY);
    const seeded = await runCategory({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(makeScript({ clusterPlan: 'pairs' })),
      store,
      config,
    });
    expect(seeded.status).toBe('delivered');
    const writesBefore = [...store.writes];

    await runAbCheck({
      category: CATEGORY,
      products,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient(makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT })),
      config,
      sampleSize: 1,
    });

    expect(store.writes).toEqual(writesBefore);
  });
});
