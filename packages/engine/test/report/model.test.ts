import { describe, expect, it } from 'vitest';

import { DISCRIMINATION_FLOOR } from '../../src/config/constants.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import type { AbCheckResult } from '../../src/report/ab-check.js';
import { buildReport } from '../../src/report/model.js';
import type { GateCheck, ReportModel } from '../../src/report/model.js';
import { formatReportSummary, renderReport } from '../../src/report/render.js';
import { zeroCost } from '../../src/run/ledger.js';
import { runCategory } from '../../src/run/run-category.js';
import { MemoryRunStore } from '../../src/run/store.js';
import type { RunResults } from '../../src/run/types.js';
import type { Product, Ranking } from '../../src/types.js';
import {
  CATEGORY,
  CATEGORY_VERSION,
  JURY,
  PANEL,
  makeProducts,
  makeScript,
  type ScriptOptions,
} from '../helpers/run-fixtures.js';

/**
 * `buildReport` and `renderReport` over a real delivered run.
 *
 * The per-statistic arithmetic is hand-checked in the sibling files; what is
 * asserted here is the assembly and the FRAMING — that the gate table leads with
 * what would stop the project, that a missing A/B is a `missing` gate rather than
 * a silent pass, that measured and estimated dollars never share a total, and
 * that the price date appears beside both.
 */

const CATEGORY_SIZE = 24;

async function seed(options: ScriptOptions = {}): Promise<{
  products: Product[];
  results: RunResults;
  ranking: Ranking;
}> {
  const products = makeProducts(CATEGORY_SIZE);
  const outcome = await runCategory({
    category: CATEGORY,
    products,
    jury: JURY,
    personas: PANEL,
    client: new FixtureClient(makeScript({ clusterPlan: 'pairs', ...options })),
    store: new MemoryRunStore(CATEGORY),
    config: { categoryVersion: CATEGORY_VERSION },
  });
  if (outcome.status !== 'delivered') throw new Error('fixture seed run did not deliver');
  return { products, results: outcome.results, ranking: outcome.ranking };
}

async function report(options: ScriptOptions = {}): Promise<ReportModel> {
  const { products, results, ranking } = await seed(options);
  return buildReport({ ranking, results, products, jury: JURY, personas: PANEL.personas });
}

/**
 * A minimal completed A/B result. One target, one metric, a real -3 point A/B
 * delta against a 0 retest floor — i.e. a run that DID have variance, so tests
 * can vary one field at a time and see the gate move for that reason alone.
 */
const ABF: AbCheckResult = {
  category: CATEGORY,
  category_version: CATEGORY_VERSION,
  engine_version: '0.1.0',
  sample_size: 1,
  category_size: CATEGORY_SIZE,
  products: [
    {
      id: 0,
      name: 'Product 0',
      batch: { metrics: { Craft: 80 }, rank: 1, composite: 1, category_size: CATEGORY_SIZE },
      incremental: { metrics: { Craft: 77 }, rank: 3, composite: 0.9, category_size: CATEGORY_SIZE },
      retest: { metrics: { Craft: 77 }, rank: 3, composite: 0.9, category_size: CATEGORY_SIZE },
      metric_delta_ab: { Craft: -3 },
      metric_delta_retest: { Craft: 0 },
      mean_abs_metric_delta_ab: 3,
      mean_abs_metric_delta_retest: 0,
      rank_delta_ab: 2,
      rank_delta_retest: 0,
      calibration_peers: 15,
      calibration_version: 'v7:abc',
    },
  ],
  summary: {
    mean_abs_metric_delta_ab: 3,
    mean_abs_metric_delta_retest: 0,
    mean_abs_rank_delta_ab: 2,
    mean_abs_rank_delta_retest: 0,
    metric_delta_ratio: Infinity,
    rank_delta_ratio: Infinity,
    ab_exceeds_retest: true,
    reading: 'x',
  },
  cost: {
    basis: 'measured',
    phases: { score: zeroCost(), uniqueness: zeroCost(), customer: zeroCost() },
    total: zeroCost(),
    unpriced_models: [],
    note: 'n',
  },
  failures: [],
  notes: [],
};

const gate = (model: ReportModel, name: string): GateCheck => {
  const found = model.gates.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no gate named ${name}`);
  return found;
};

describe('buildReport — assembly', () => {
  it('carries the provenance a disputed ranking would be re-derived from', async () => {
    const model = await report();
    expect(model.category).toBe(CATEGORY);
    expect(model.provenance.category_version).toBe(CATEGORY_VERSION);
    expect(model.provenance.prompt_version).toBe(JURY.prompt_version);
    expect(model.provenance.persona_version).toBe(PANEL.persona_version);
    expect(model.provenance.outcome).toBe('delivered');
    expect(model.products).toBe(CATEGORY_SIZE);
    expect(model.metrics).toEqual(['Craft', 'Utility', 'Clarity']);
  });

  it('echoes the health block from the ranking rather than recomputing it', async () => {
    const { products, results, ranking } = await seed();
    const model = buildReport({ ranking, results, products, jury: JURY, personas: PANEL.personas });
    expect(model.health).toEqual(ranking.health);
  });

  it('covers every juror and every cell on a clean run', async () => {
    const model = await report();
    expect(model.completeness.jurors_present).toBe(JURY.jurors.length);
    expect(model.completeness.cells_substituted).toBe(0);
    expect(model.completeness.complete).toBe(true);
    // 6 jurors x 24 products x 3 metrics.
    expect(model.completeness.cells_expected).toBe(6 * CATEGORY_SIZE * 3);
  });

  it('projects the schedule over the TOP 20 of the board, not the head of the list', async () => {
    const model = await report();
    expect(model.schedule.nightly.products).toBe(20);
    expect(model.schedule.weekly.products).toBe(CATEGORY_SIZE);
  });

  it('never mixes a measured and an estimated dollar figure', async () => {
    const model = await report();
    // Two independent totals with two different bases. There is deliberately no
    // field combining them, and there must never be one.
    expect(model.cost.basis).toBeDefined();
    expect(model.schedule.monthly_score_only_usd).toBeGreaterThan(0);
    expect(Object.keys(model)).not.toContain('total_cost_usd');
  });

  it('prints the price table with its source date', async () => {
    const model = await report();
    expect(model.prices.map((row) => row.model_id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
    expect(model.price_table_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildReport — the gate table', () => {
  it('leads with the checks that would stop the project', async () => {
    const model = await report();
    expect(model.gates.map((entry) => entry.name)).toEqual([
      'discrimination',
      'panel completeness',
      'juror independence',
      'juror score variance',
      'juror deduction rate',
      'fix 1.1 evidence (A/B vs test-retest)',
      'source-ranking correlation (leak test)',
      'measured cost basis',
      'recalibration schedule vs brief Part 7',
      'demand coverage',
    ]);
  });

  it('marks a missing A/B as MISSING, never as a pass', async () => {
    // A Phase 1 report with no fix-1.1 evidence has not answered the question
    // Phase 1 was for. Rendering it as a silent absence would let the gate be
    // passed by omission.
    const model = await report();
    const fix = gate(model, 'fix 1.1 evidence (A/B vs test-retest)');
    expect(fix.status).toBe('missing');
    expect(fix.note).toContain('ONLY evidence');
    expect(fix.note).toContain('engine ab');
  });

  it('flags a fragile panel and quotes the consequence', async () => {
    const model = await report();
    const discrimination = gate(model, 'discrimination');
    if (model.health.discrimination < DISCRIMINATION_FLOOR) {
      expect(discrimination.status).toBe('flag');
      expect(discrimination.note).toContain('MERIT ALONE IS FRAGILE');
    } else {
      expect(discrimination.status).toBe('pass');
    }
  });

  it('states the exact inflation factor when a juror did not answer', async () => {
    // One silent juror of six. `computeComposite` then divides by 5, so every
    // composite — and `discrimination` over them — is 6/5 = 1.200 times what a
    // full-panel normalization would give.
    // A juror that returns nothing makes the Score phase FAIL its coverage audit,
    // so no such run is ever delivered and no such `ranking.json` exists to
    // report on (`brief §2.3`). The five-juror state a report can actually meet
    // is a stored log that lost a juror some other way — a hand-edited
    // `results.json`, or a retrofit — so that is what is built here.
    const clean = await seed();
    const results: RunResults = {
      ...clean.results,
      scoreLog: clean.results.scoreLog.filter((entry) => entry.juror_role !== 'Juror 6'),
    };

    const model = buildReport({
      ranking: clean.ranking,
      results,
      products: clean.products,
      jury: JURY,
      personas: PANEL.personas,
    });
    expect(model.completeness.jurors_present).toBe(5);
    expect(model.completeness.jurors_expected).toBe(6);
    expect(model.completeness.missing_roles).toEqual(['Juror 6']);

    const completeness = gate(model, 'panel completeness');
    expect(completeness.status).toBe('flag');
    expect(completeness.note).toContain('1.200');
    expect(completeness.note).toContain('Juror 6');
  });

  it('never passes the fix-1.1 gate on a run with no sampling variance', async () => {
    // `ab_exceeds_retest` is `false` in two very different worlds: the paths are
    // genuinely indistinguishable, and neither path moved at all. Rendering the
    // second as PASS would clear the gate by the same route the MISSING arm
    // exists to block — and PASS is the half a scanner reads.
    const clean = await seed();
    const zeroVariance = {
      ...ABF,
      summary: {
        ...ABF.summary,
        mean_abs_metric_delta_ab: 0,
        mean_abs_metric_delta_retest: 0,
        metric_delta_ratio: 1,
        ab_exceeds_retest: false,
        reading: 'Nothing can be concluded …',
      },
    };

    const model = buildReport({
      ranking: clean.ranking,
      results: clean.results,
      products: clean.products,
      jury: JURY,
      personas: PANEL.personas,
      ab: zeroVariance,
    });

    const fix = gate(model, 'fix 1.1 evidence (A/B vs test-retest)');
    expect(fix.status).toBe('inconclusive');
    expect(fix.status).not.toBe('pass');
  });

  it('marks a completed A/B with no target as inconclusive, not as a pass', async () => {
    const clean = await seed();
    const model = buildReport({
      ranking: clean.ranking,
      results: clean.results,
      products: clean.products,
      jury: JURY,
      personas: PANEL.personas,
      ab: { ...ABF, products: [] },
    });

    const fix = gate(model, 'fix 1.1 evidence (A/B vs test-retest)');
    expect(fix.status).toBe('inconclusive');
    expect(fix.value).toBe('no target completed both paths');
  });

  it('passes the fix-1.1 gate only when both paths actually moved', async () => {
    // A/B 1.0 points against a retest floor of 2.0: the paths are
    // indistinguishable from two samples of one path, which is the outcome fix
    // 1.1 was aiming at — and there IS variance, so the finding is real.
    const clean = await seed();
    const model = buildReport({
      ranking: clean.ranking,
      results: clean.results,
      products: clean.products,
      jury: JURY,
      personas: PANEL.personas,
      ab: {
        ...ABF,
        summary: {
          ...ABF.summary,
          mean_abs_metric_delta_ab: 1,
          mean_abs_metric_delta_retest: 2,
          metric_delta_ratio: 0.5,
          ab_exceeds_retest: false,
        },
      },
    });
    expect(gate(model, 'fix 1.1 evidence (A/B vs test-retest)').status).toBe('pass');
  });

  it('flags a zero-variance juror in the verdict table, not only forty lines down', async () => {
    // The failure this closes: a juror that gave every product the same score
    // correlates 0 with everyone, which is the value a perfectly INDEPENDENT
    // juror scores — so it pulls the independence mean down and can clear the
    // dead-weight cut too. Its zero spread otherwise appears only in §7.
    const clean = await seed();
    const flatten = clean.results.scoreLog.map((entry) =>
      entry.juror_role !== 'Juror 6'
        ? entry
        : {
            ...entry,
            scores: entry.scores.map((row) => ({
              ...row,
              metrics: row.metrics.map((metric) => ({
                name: metric.name,
                score: 50,
                deductions: [{ points: 50, reason: 'flat' }],
              })),
            })),
          },
    );

    const model = buildReport({
      ranking: clean.ranking,
      results: { ...clean.results, scoreLog: flatten },
      products: clean.products,
      jury: JURY,
      personas: PANEL.personas,
    });

    expect(model.correlation.flat_roles).toEqual(['Juror 6']);
    const variance = gate(model, 'juror score variance');
    expect(variance.status).toBe('flag');
    expect(variance.value).toContain('Juror 6');
    expect(variance.note).toContain('dilute every juror that did vote');
    // And the independence mean must be reported both ways, never only the one
    // the dead juror flattered.
    expect(model.correlation.mean_pair_correlation_excluding_flat).toBeGreaterThan(
      model.correlation.mean_pair_correlation,
    );
  });

  it('never passes or fails the leak test — it is READ only', async () => {
    // The correlation cannot separate leakage from genuine agreement, so a
    // pass/fail on it would be a claim the statistic does not support.
    const leak = gate(await report(), 'source-ranking correlation (leak test)');
    expect(leak.status).toBe('info');
    expect(leak.note).toContain('cannot on its own separate');
  });

  it('flags an unmeasurable cost rather than passing a $0.00', async () => {
    const model = await report({ modelId: 'local-subagent' });
    const cost = gate(model, 'measured cost basis');
    expect(cost.status).toBe('flag');
    expect(cost.value).toContain('unmeasured');
    expect(cost.note).toContain('not $0.00');
  });

  it('flags the degenerate two-product demand population', async () => {
    // `one-big` puts every product in one cluster, so every product gets a
    // demand entry — the healthy case. `all-solo` gives nobody one.
    const none = await report({ clusterPlan: 'all-solo' });
    const gateNone = gate(none, 'demand coverage');
    expect(none.demand.no_demand_at_all).toBe(true);
    expect(gateNone.status).toBe('flag');
    expect(gateNone.note).toContain('Floor never convened');

    const healthy = await report({ clusterPlan: 'one-big' });
    expect(gate(healthy, 'demand coverage').status).toBe('pass');
  });

  it('reports the schedule against the brief\'s line with both readings', async () => {
    const model = await report();
    const schedule = gate(model, 'recalibration schedule vs brief Part 7');
    expect(schedule.value).toContain('over 28 categories');
    expect(schedule.note).toContain('ESTIMATED, not measured');
    expect(schedule.note).toContain('15 categories');
    // All three readings named in the row itself, and the S7 caveat with them.
    expect(schedule.note).toContain('score-only');
    expect(schedule.note).toContain('score+customer');
    expect(schedule.note).toContain('full pipeline');
    expect(schedule.note).toContain('DECISIONS.md S7 leaves the Floor question OPEN');
    // The magnitude caveat travels on the verdict row, not only in the body.
    expect(schedule.note).toContain('DECISIONS.md S5');
  });
});

describe('renderReport', () => {
  it('renders every section a Phase 1 gate needs', async () => {
    const markdown = renderReport(await report());

    expect(markdown).toContain('# Phase 1 report');
    expect(markdown).toContain('## Verdict');
    expect(markdown).toContain('## 1. Does the jury separate the products?');
    expect(markdown).toContain('### Juror response completeness');
    expect(markdown).toContain('## 2. Does the jury genuinely disagree?');
    expect(markdown).toContain('## 3. Does fix 1.1 work?');
    expect(markdown).toContain('## 4. Did the source ranking leak into our board?');
    expect(markdown).toContain('## 5. Cost — MEASURED');
    expect(markdown).toContain('## 6. Cost — ESTIMATED');
    expect(markdown).toContain('## 7. Score distribution, per juror, per metric');
    expect(markdown).toContain('## 8. Deduction rate, per juror');
    expect(markdown).toContain('## 9. Clusters, scarcity');
    expect(markdown).toContain('## 10. Demand coverage');
  });

  it('puts the verdict before any descriptive statistic', async () => {
    const markdown = renderReport(await report());
    expect(markdown.indexOf('## Verdict')).toBeLessThan(markdown.indexOf('## 7. Score distribution'));
    expect(markdown.indexOf('## 3. Does fix 1.1 work?')).toBeLessThan(
      markdown.indexOf('## 7. Score distribution'),
    );
  });

  it('prints the price table and its date in BOTH money sections', async () => {
    const model = await report();
    const markdown = renderReport(model);
    const occurrences = markdown.split(`Price table — checked ${model.price_table_date}`).length - 1;
    expect(occurrences).toBe(2);
  });

  it('labels the measured cost with its basis and the schedule as an estimate', async () => {
    const markdown = renderReport(await report({ modelId: 'local-subagent' }));
    expect(markdown).toContain('Basis: **unmeasured**');
    expect(markdown).toContain('Nothing in this section was measured');
    expect(markdown).toContain('never added to the measured ones above');
  });

  it('says the fix-1.1 evidence is missing and how to produce it', async () => {
    const markdown = renderReport(await report());
    expect(markdown).toContain('**MISSING.**');
    expect(markdown).toContain('pnpm engine ab');
    expect(markdown).toContain('That command SPENDS');
  });

  it('renders the correlation matrix as a square with 1 on the diagonal', async () => {
    const model = await report();
    const markdown = renderReport(model);
    for (const role of model.correlation.roles) expect(markdown).toContain(role);
    expect(markdown).toContain('1.000');
  });

  it('emits structurally valid Markdown tables', async () => {
    // A literal `|` inside a cell splits the row, and the damage is invisible
    // until someone opens the file — in the section a founder reads first. This
    // caught `mean |Δ|` as a column heading. Every row of a contiguous table
    // block must carry the same number of pipes as its header.
    const { products, results, ranking } = await seed();
    const markdown = renderReport(
      buildReport({ ranking, results, products, jury: JURY, personas: PANEL.personas, ab: ABF }),
    );

    let headerPipes: number | undefined;
    for (const line of markdown.split('\n')) {
      const isRow = line.startsWith('|') && line.endsWith('|');
      if (!isRow) {
        headerPipes = undefined;
        continue;
      }
      const pipes = (line.match(/\|/g) ?? []).length;
      if (headerPipes === undefined) headerPipes = pipes;
      else expect(pipes, `row has ${pipes} pipes, header had ${headerPipes}: ${line}`).toBe(headerPipes);
    }
  });

  it('states the leak caveat inside the document, not only in the gate table', async () => {
    const markdown = renderReport(await report());
    expect(markdown).toContain('+1 by construction — this IS the residual channel');
    expect(markdown).toContain('cannot on its own separate');
  });

  it('refuses to answer the S2/S3 question when no product has a missing demand entry', async () => {
    // `mean([])` is 0 by convention, and 0 is also the value that means "S3
    // moves solo products nowhere". Printing it as a measured finding when the
    // population is empty is the worst outcome for the section whose entire
    // purpose is to measure that interaction.
    const model = await report({ clusterPlan: 'one-big' });
    expect(model.novelty.s3_gain_solo.n).toBe(0);

    const markdown = renderReport(model);
    expect(markdown).toContain('Not measured in this category');
    expect(markdown).toContain('`mean([])`, not a finding');
    expect(markdown).not.toContain('S3 is not moving solo products as a group');
  });

  it('answers the S2/S3 question, with both yardsticks, when solo products exist', async () => {
    const model = await report({ clusterPlan: 'all-solo' });
    expect(model.novelty.s3_gain_solo.n).toBeGreaterThan(0);

    const markdown = renderReport(model);
    expect(markdown).not.toContain('Not measured in this category');
    // Both yardsticks: the tilt magnitude AND the population std of `core`.
    expect(markdown).toContain('against a full uniqueness tilt of ±0.075');
    expect(markdown).toContain('of one population std of `core`');
  });

  it('warns beside the independence mean when a zero-variance juror flattered it', async () => {
    const clean = await seed();
    const flattened = clean.results.scoreLog.map((entry) =>
      entry.juror_role !== 'Juror 6'
        ? entry
        : {
            ...entry,
            scores: entry.scores.map((row) => ({
              ...row,
              metrics: row.metrics.map((metric) => ({
                name: metric.name,
                score: 50,
                deductions: [{ points: 50, reason: 'flat' }],
              })),
            })),
          },
    );

    const markdown = renderReport(
      buildReport({
        ranking: clean.ranking,
        results: { ...clean.results, scoreLog: flattened },
        products: clean.products,
        jury: JURY,
        personas: PANEL.personas,
      }),
    );

    expect(markdown).toContain('Read that mean with care');
    expect(markdown).toContain('Juror 6');
    expect(markdown).toContain('That is the number to read');
  });

  it('narrows the §1.5 claim, cites S7 as open, and shows the intermediate reading', async () => {
    const markdown = renderReport(await report());
    expect(markdown).toContain('cannot RE-CLUSTER');
    expect(markdown).toContain('S7 records exactly that question as OPEN');
    expect(markdown).toContain('score + customer (S7 open)');
    // The old overreach must be gone: §1.5 never settled the Floor question.
    expect(markdown).not.toContain('cannot re-cluster and cannot re-poll the Floor');
    expect(markdown).not.toContain('score-only (defensible)');
  });

  it('says whether the budget verdict depends on S7', async () => {
    const markdown = renderReport(await report());
    expect(markdown).toMatch(/does not depend on S7 being resolved|answer genuinely turns on/);
  });

  it('prints what the projected magnitude rests on, against the real seeded median', async () => {
    // A projection carries a real category name and real-looking dollars whatever
    // inputs produced it. The fixture's 72-character descriptions must declare
    // themselves against `DECISIONS.md` S5's measured 141-character median.
    const markdown = renderReport(await report());
    expect(markdown).toContain('What the magnitude rests on');
    expect(markdown).toContain('median description characters');
    expect(markdown).toContain('141 (`DECISIONS.md` S5)');
    expect(markdown).toContain('SHORTER');
    expect(markdown).toContain('more likely HIGHER than the figure above');
    expect(markdown).toContain('unconfirmed until this harness runs against a seeded category');
  });
});

describe('formatReportSummary', () => {
  it('prints one line per gate and calls out the ones needing a decision', async () => {
    const model = await report();
    const summary = formatReportSummary(model, 'cjr/runs/x/report.md');

    for (const entry of model.gates) expect(summary).toContain(entry.name);
    expect(summary).toContain('MISSING');
    expect(summary).toContain('gate(s) need a decision');
    expect(summary).toContain('cjr/runs/x/report.md');
  });

  it('states the cost basis and the price date in the terminal, not only the file', async () => {
    const model = await report({ modelId: 'local-subagent' });
    const summary = formatReportSummary(model, 'out.md');
    expect(summary).toContain('(unmeasured)');
    expect(summary).toContain(`Prices checked ${model.price_table_date}`);
  });

  it('counts an INCONCLUSIVE gate as needing a decision, even when it is the only one', async () => {
    // The regression this pins. In a category where the fix-1.1 A/B is the ONLY
    // problem and every other gate passes, a filter that knows about `flag` and
    // `missing` but not `inconclusive` prints "No gate needs a decision." while
    // `reportCommand` exits 1 — moving the exact failure the `inconclusive`
    // status was added to eliminate out of the gate table and into the console.
    //
    // The gates are replaced wholesale rather than coaxed out of a fixture,
    // because the fixture panel always flags juror independence — which is why
    // the real bug passed CI. `formatReportSummary` is a pure function of the
    // model, so overriding the field is the whole isolation this needs.
    const model = await report();
    const onlyInconclusive: ReportModel = {
      ...model,
      gates: [
        { name: 'discrimination', status: 'pass', value: '0.9', note: 'fine' },
        { name: 'juror independence', status: 'pass', value: 'r = 0.2', note: 'fine' },
        {
          name: 'fix 1.1 evidence (A/B vs test-retest)',
          status: 'inconclusive',
          value: 'A/B 0.000 pts vs retest 0.000 pts over 5 product(s)',
          note: 'Nothing can be concluded about fix 1.1 from a run with no sampling variance.',
        },
        { name: 'source-ranking correlation (leak test)', status: 'info', value: '0.11', note: 'read it' },
      ],
    };

    const summary = formatReportSummary(onlyInconclusive, 'out.md');
    expect(summary).not.toContain('No gate needs a decision');
    expect(summary).toContain('1 gate(s) need a decision:');
    // And the REASON has to travel, not just the row value — it is the only
    // place a reader who never opens report.md learns why the gate is open.
    expect(summary).toContain('Nothing can be concluded about fix 1.1');
    // The mark column must be wide enough for the longest label, or it runs into
    // the gate name on exactly the row that most needs to be readable.
    expect(summary).toContain('NO EVIDENCE fix 1.1 evidence');
  });

  it('says nothing needs a decision only when nothing does — INFO does not count', async () => {
    const model = await report();
    const allClear: ReportModel = {
      ...model,
      gates: [
        { name: 'discrimination', status: 'pass', value: '0.9', note: 'fine' },
        // `info` is a number that must be READ, never a decision to make: the
        // leak correlation cannot support a pass/fail, so counting it would make
        // every clean report look like it had an open question.
        { name: 'source-ranking correlation (leak test)', status: 'info', value: '0.11', note: 'read it' },
      ],
    };
    expect(formatReportSummary(allClear, 'out.md')).toContain('No gate needs a decision.');
  });

  it('hedges the trailing schedule line — the most quotable figure in the output', async () => {
    // This is the LAST line printed and the one that gets quoted onward out of
    // context. It must carry the range (three readings exist, S7 is open) and the
    // fixture-projection marker on its own, without relying on the reader having
    // seen §6.
    const model = await report();
    const summary = formatReportSummary(model, 'out.md');
    const line = summary.slice(summary.indexOf('Estimated schedule:'));

    expect(line).toContain('across 3 readings (S7 open)');
    expect(line).toContain(`-$${model.schedule.monthly_full_pipeline_usd.toFixed(2)}/mo`);
    expect(line).toContain('ESTIMATED, not measured');
    expect(line).toContain('DECISIONS.md S5');
    expect(line).toContain('the composition is verified, the magnitude is not');
    expect(line).toContain('Do not quote it as measured');
  });

  it('says a flat juror HIDES panel dependence, not merely that it flatters', async () => {
    // The exclusion metric matters because the raw mean reads as a healthily
    // independent panel while the jurors that voted are perfectly correlated.
    const clean = await seed();
    const flattened = clean.results.scoreLog.map((entry) =>
      entry.juror_role !== 'Juror 6'
        ? entry
        : {
            ...entry,
            scores: entry.scores.map((row) => ({
              ...row,
              metrics: row.metrics.map((metric) => ({
                name: metric.name,
                score: 50,
                deductions: [{ points: 50, reason: 'flat' }],
              })),
            })),
          },
    );

    const markdown = renderReport(
      buildReport({
        ranking: clean.ranking,
        results: { ...clean.results, scoreLog: flattened },
        products: clean.products,
        jury: JURY,
        personas: PANEL.personas,
      }),
    );
    expect(markdown).toContain('HIDES real dependence between the jurors that did vote');
  });
});
