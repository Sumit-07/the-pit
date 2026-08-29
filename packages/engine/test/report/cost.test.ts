import { describe, expect, it } from 'vitest';

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CATEGORY_COUNT,
  PRICE_HAIKU_INPUT,
  PRICE_HAIKU_OUTPUT,
  PRICE_SONNET_INPUT,
  PRICE_TABLE_DATE,
  RECAL_BUDGET_CATEGORIES,
  RECAL_BUDGET_MAX_USD,
  RECAL_NIGHTLY_TOP_N,
} from '../../src/config/constants.js';
import {
  measuredCost,
  monthlySpend,
  NIGHTS_PER_MONTH,
  priceTable,
  projectSchedule,
  PRICE_TABLE_SOURCE_DATE,
  WEEKS_PER_MONTH,
} from '../../src/report/cost.js';
import { buildLedger, zeroCost } from '../../src/run/ledger.js';
import type { CostLedger, PhaseCost } from '../../src/run/types.js';
import { CATEGORY, CATEGORY_VERSION, JURY, PANEL, makeProducts } from '../helpers/run-fixtures.js';

/**
 * Cost: the measured/estimated wall, the price table, and the schedule
 * composition — the line the last report got wrong.
 */

function cost(overrides: Partial<PhaseCost> = {}): PhaseCost {
  return { ...zeroCost(), ...overrides };
}

function ledger(total: Partial<PhaseCost>): CostLedger {
  return buildLedger({ score: cost(total), uniqueness: zeroCost(), customer: zeroCost() });
}

describe('measuredCost — the four bases', () => {
  it('is `measured` when every call reported a priced model id', () => {
    const result = measuredCost(ledger({ calls: 6, cost_usd: 0.0123 }));
    expect(result.basis).toBe('measured');
    expect(result.note).toContain('MEASURED');
    expect(result.total.cost_usd).toBeCloseTo(0.0123, 12);
  });

  it('is `no_calls` when nothing was called, where $0.00 really is the answer', () => {
    const result = measuredCost(ledger({}));
    expect(result.basis).toBe('no_calls');
    expect(result.note).toContain('No model calls were made');
  });

  it('is `unmeasured` — never "$0.00" — for a fully unpriced run', () => {
    // Task 9's handoff adapter cannot report a priced model id at all, so this
    // is the NORMAL state of a locally-seeded run, not an edge case. The whole
    // point of the field is that a report must not print a confident $0.00.
    const result = measuredCost(ledger({ calls: 19, cost_usd: 0, unpriced_models: ['local-subagent'] }));
    expect(result.basis).toBe('unmeasured');
    expect(result.note).toContain('UNMEASURED — not $0.00');
    expect(result.note).toContain('local-subagent');
    expect(result.note).toContain('re-baselined once a key exists');
    expect(result.unpriced_models).toEqual(['local-subagent']);
  });

  it('is `lower_bound` when some calls were priced and some were not', () => {
    const result = measuredCost(ledger({ calls: 19, cost_usd: 0.5, unpriced_models: ['claude-mystery-9'] }));
    expect(result.basis).toBe('lower_bound');
    expect(result.note).toContain('LOWER BOUND, not a total');
    expect(result.note).toContain('claude-mystery-9');
  });
});

describe('priceTable', () => {
  it('prints every priced model with its cache rates derived from the input rate', () => {
    const rows = priceTable();
    expect(rows.map((row) => row.model_id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);

    const haiku = rows[0];
    expect(haiku?.input).toBe(PRICE_HAIKU_INPUT); // $1.00 / Mtok
    expect(haiku?.output).toBe(PRICE_HAIKU_OUTPUT); // $5.00 / Mtok
    // Cache write is 1.25 x input = 1.00 x 1.25 = 1.25; read is 0.1 x = 0.10.
    expect(haiku?.cache_write).toBeCloseTo(PRICE_HAIKU_INPUT * CACHE_WRITE_MULTIPLIER, 12);
    expect(haiku?.cache_write).toBeCloseTo(1.25, 12);
    expect(haiku?.cache_read).toBeCloseTo(PRICE_HAIKU_INPUT * CACHE_READ_MULTIPLIER, 12);
    expect(haiku?.cache_read).toBeCloseTo(0.1, 12);

    // Sonnet input $2.00 -> cache write $2.50, cache read $0.20.
    expect(rows[1]?.cache_write).toBeCloseTo(PRICE_SONNET_INPUT * CACHE_WRITE_MULTIPLIER, 12);
    expect(rows[1]?.cache_write).toBeCloseTo(2.5, 12);
    expect(rows[1]?.cache_read).toBeCloseTo(0.2, 12);
  });

  it('is sorted by id so two reports diff on a price change, not a reordering', () => {
    const ids = priceTable().map((row) => row.model_id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('carries the date the table was checked', () => {
    expect(PRICE_TABLE_SOURCE_DATE).toBe(PRICE_TABLE_DATE);
  });
});

describe('the calendar behind the schedule', () => {
  it('uses 365/12 nights and 365/12/7 weeks, not a rounded 30 and 4', () => {
    // 365 / 12 = 30.416666...  and that / 7 = 4.345238095...
    expect(NIGHTS_PER_MONTH).toBeCloseTo(30.4166667, 7);
    expect(WEEKS_PER_MONTH).toBeCloseTo(4.3452381, 7);
    // Rounding down would understate the monthly total, in the direction that
    // flatters the budget this section exists to test.
    expect(NIGHTS_PER_MONTH).toBeGreaterThan(30);
    expect(WEEKS_PER_MONTH).toBeGreaterThan(4);
  });
});

describe('monthlySpend — the schedule composition', () => {
  it('matches a hand-computed month', () => {
    // A nightly top-20 pass at $0.01 and a weekly full board at $0.10, over 28
    // categories:
    //
    //   nights x nightly = 30.4166666667 x 0.01 = 0.3041666667
    //   weeks   x weekly = 4.3452380952 x 0.10 = 0.4345238095
    //   per category                            = 0.7386904762
    //   x 28 categories                         = 20.6833333333
    expect(monthlySpend(0.01, 0.1, 28)).toBeCloseTo(20.6833333333, 9);
  });

  it('is linear in the category count', () => {
    expect(monthlySpend(0.01, 0.1, 28)).toBeCloseTo(28 * monthlySpend(0.01, 0.1, 1), 12);
  });

  it('is 0 when both passes are free', () => {
    expect(monthlySpend(0, 0, 28)).toBe(0);
  });

  it('counts BOTH a nightly and a weekly pass on the night they collide', () => {
    // The literal reading of `brief` Part 3, which overstates by ~4.35 nightly
    // passes a month. Overstating is the right direction for a budget check.
    // With a $1 nightly and a $0 weekly the total is exactly nights x 1.
    expect(monthlySpend(1, 0, 1)).toBeCloseTo(NIGHTS_PER_MONTH, 12);
  });
});

describe('projectSchedule', () => {
  const products = makeProducts(44);
  const input = {
    category: CATEGORY,
    products,
    jury: JURY,
    personas: PANEL.personas,
    ordering: { category: CATEGORY, categoryVersion: CATEGORY_VERSION },
  };

  it('projects a top-20 nightly pass and a full-board weekly pass', () => {
    const schedule = projectSchedule(input);
    expect(schedule.nightly.products).toBe(RECAL_NIGHTLY_TOP_N);
    expect(schedule.weekly.products).toBe(44);
    expect(schedule.nightly.label).toBe('nightly top-20');
    // 20 products fit in one chunk; 44 split into two (brief §1.4).
    expect(schedule.nightly.chunks).toBe(1);
    expect(schedule.weekly.chunks).toBe(2);
    // `01 §7.3`: JUROR_COUNT x chunks + 1 clustering + personas.
    expect(schedule.nightly.calls).toBe(6 * 1 + 1 + PANEL.personas.length);
    expect(schedule.weekly.calls).toBe(6 * 2 + 1 + PANEL.personas.length);
  });

  it('defaults to the measured 28 categories, not the brief\'s stated 15', () => {
    const schedule = projectSchedule(input);
    expect(schedule.categories).toBe(CATEGORY_COUNT);
    expect(schedule.budget.stated_categories).toBe(RECAL_BUDGET_CATEGORIES);
    // The discrepancy is the headline finding; it must survive into the object.
    expect(schedule.categories).toBeGreaterThan(schedule.budget.stated_categories);
  });

  it('composes the month from the two pass costs it just projected', () => {
    const schedule = projectSchedule(input);
    // Re-derived here from first principles rather than read back, so the
    // composition is checked and not merely echoed.
    const expected =
      CATEGORY_COUNT *
      ((365 / 12) * schedule.nightly.score_only_cost_usd +
        (365 / 12 / 7) * schedule.weekly.score_only_cost_usd);
    expect(schedule.monthly_score_only_usd).toBeCloseTo(expected, 12);
    expect(schedule.monthly_score_only_per_category_usd).toBeCloseTo(expected / CATEGORY_COUNT, 12);
  });

  it('keeps the score-only reading strictly cheaper than the full pipeline', () => {
    // `brief §1.5` makes full re-clustering an admin operation, so a routine
    // pass cannot re-cluster: score-only is the defensible reading and the
    // full pipeline is the ceiling. If these were ever equal the two readings
    // would have collapsed into one and the caveat would be a lie.
    const schedule = projectSchedule(input);
    expect(schedule.nightly.score_only_cost_usd).toBeLessThan(schedule.nightly.full_pipeline_cost_usd);
    expect(schedule.monthly_score_only_usd).toBeLessThan(schedule.monthly_full_pipeline_usd);
  });

  it('states the budget comparison as a multiple of the ceiling', () => {
    const schedule = projectSchedule(input);
    expect(schedule.score_only_vs_budget_max).toBeCloseTo(
      schedule.monthly_score_only_usd / RECAL_BUDGET_MAX_USD,
      12,
    );
    expect(schedule.score_only_within_budget).toBe(schedule.monthly_score_only_usd <= RECAL_BUDGET_MAX_USD);
  });

  it('reports OVER budget when the schedule genuinely exceeds the ceiling', () => {
    const schedule = projectSchedule({ ...input, categories: 100_000 });
    expect(schedule.score_only_within_budget).toBe(false);
    expect(schedule.full_pipeline_within_budget).toBe(false);
    expect(schedule.score_only_vs_budget_max).toBeGreaterThan(1);
  });

  it('takes the nightly products it is given rather than the head of the list', () => {
    // The report passes the actual top 20 of the BOARD; a projection over an
    // arbitrary slice would render different prompt text and a different cost.
    const chosen = [products[43], products[42], products[41]].flatMap((p) => (p === undefined ? [] : [p]));
    const schedule = projectSchedule({ ...input, nightlyProducts: chosen });
    expect(schedule.nightly.products).toBe(3);
  });

  it('carries every caveat the estimate rests on', () => {
    const caveats = projectSchedule(input).caveats.join('\n');
    expect(caveats).toContain('ESTIMATED, never measured');
    expect(caveats).toContain(`${CATEGORY_COUNT} categories`);
    expect(caveats).toContain(`${RECAL_BUDGET_CATEGORIES} categories`);
    expect(caveats).toContain('cold prompt cache');
    expect(caveats).toContain('overstates');
  });
});
