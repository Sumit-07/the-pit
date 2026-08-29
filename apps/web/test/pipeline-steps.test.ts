/**
 * The step granularity — `brief` Part 7's constraint, and the one this suite
 * exists for.
 *
 * > "Make each *phase* one step that fires its calls in parallel inside it — not
 * > one step per juror call. Free tier is 50K executions and **5 concurrent
 * > steps**; a 6-way fan-out as separate steps throttles badly."
 *
 * Getting this wrong does not fail loudly. A pipeline that made each juror call
 * its own `step.run` produces the same scores, the same clusters, the same ranks,
 * the same verdict and the same dollar figure — every assertion about OUTPUT
 * passes. What changes is the list of step ids the executor was handed, and on a
 * plan with five concurrent steps that difference is a production incident and
 * nothing else. So these tests assert the step LIST and the call attribution,
 * which is the only place the regression is visible.
 *
 * Every number below is hand-derived from the fixed inputs:
 *
 *   8 products, chunk size 40      -> ceil(8/40)      = 1 chunk
 *   6 jurors x 1 chunk             -> 6 scoring calls
 *   1 clustering pass              -> 1 call
 *   4 personas, 4 sets of 2        -> 4 choice calls
 *   ------------------------------------------------
 *   11 model calls, across exactly 5 steps
 */

import { JUROR_COUNT } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { PIPELINE_STEPS } from '@/lib/pipeline/types';

import { makeHarness, run } from './helpers/run.js';

describe('one Inngest step per phase (brief Part 7)', () => {
  it('runs exactly five steps, whatever the panel size', async () => {
    const harness = makeHarness();
    await run(harness);

    // The assertion. Six jurors and four personas made eleven model calls; a
    // per-call step split would put fifteen ids in this array.
    expect(harness.runner.ids).toHaveLength(5);
    expect([...harness.runner.ids].sort()).toEqual([...PIPELINE_STEPS].sort());
    expect(harness.meter.total).toBe(11);
  });

  it('fires all six juror calls inside the single score step', async () => {
    const harness = makeHarness();
    await run(harness);

    expect(harness.meter.callsIn('score')).toBe(JUROR_COUNT);
    // ...and together, not one after another. A phase that awaited its calls in
    // a loop would give the right step count and a peak of 1 — which is the same
    // latency the split-step version has, arrived at a different way.
    expect(harness.meter.concurrencyIn('score')).toBe(JUROR_COUNT);
  });

  it('fires every persona call inside the single persona step', async () => {
    const harness = makeHarness();
    await run(harness);

    expect(harness.meter.callsIn('persona')).toBe(4);
    expect(harness.meter.concurrencyIn('persona')).toBe(4);
  });

  it('spends one call on clustering and none on ranking or delivery', async () => {
    const harness = makeHarness();
    await run(harness);

    expect(harness.meter.callsIn('cluster')).toBe(1);
    // `02 §4`: reads never touch a model, and ranking is arithmetic over stored
    // rows (`01 §2`, Global Constraint 1). Both of these are zero by design, and
    // the `rank` step is handed a client that throws if it is ever called.
    expect(harness.meter.callsIn('rank')).toBe(0);
    expect(harness.meter.callsIn('deliver')).toBe(0);
  });

  it('makes no model call outside a step at all', async () => {
    const harness = makeHarness();
    await run(harness);

    // A call attributed to no step is a call the executor cannot retry, cannot
    // memoize and cannot bill. There should never be one.
    expect(harness.meter.callsOutsideAnyStep).toBe(0);
  });

  it('runs score and cluster together, and persona only after them', async () => {
    const harness = makeHarness();
    await run(harness);

    const order = harness.runner.ids;
    // `01 §2`: Score and Uniqueness are Round 1 and read only the products, so
    // neither may wait on the other. Customer is Round 2 and depends on the
    // clusters. That is two concurrent steps out of the free tier's five.
    expect(order.indexOf('persona')).toBeGreaterThan(order.indexOf('score'));
    expect(order.indexOf('persona')).toBeGreaterThan(order.indexOf('cluster'));
    expect(order.indexOf('rank')).toBeGreaterThan(order.indexOf('persona'));
    expect(order.indexOf('deliver')).toBeGreaterThan(order.indexOf('rank'));
  });

  it('does not grow a step when the category needs a second scoring chunk', async () => {
    // Two chunks means twelve scoring calls. The step count must not move: this
    // is the shape of the regression, since a chunk is the obvious second thing
    // someone reaches for when deciding what "a unit of work" is.
    const harness = makeHarness({ products: 8 });
    harness.input.config.chunkSize = 4;
    await run(harness);

    expect(harness.meter.callsIn('score')).toBe(JUROR_COUNT * 2);
    expect(harness.runner.ids).toHaveLength(5);
  });
});

describe('what a delivered run produces', () => {
  it('ranks every product and republishes the board once', async () => {
    const harness = makeHarness();
    const result = await run(harness);

    expect(result.product_count).toBe(8);
    expect(result.published?.board).toBe('boards/health-fitness-wellness');
    expect(harness.snapshots.published).toHaveLength(1);

    const snapshot = await harness.snapshots.read('health-fitness-wellness');
    expect(snapshot?.ranking.ranking).toHaveLength(8);
    expect(snapshot?.generated_at).toBe('2026-03-01T12:00:00.000Z');
  });

  it('reports the status and cost of every step', async () => {
    const harness = makeHarness();
    const result = await run(harness);

    const byStep = new Map(result.reports.map((report) => [report.step, report]));
    expect(byStep.get('score')?.status).toBe('ok');
    expect(byStep.get('score')?.calls).toBe(JUROR_COUNT);
    expect(byStep.get('persona')?.status).toBe('ok');
    expect(byStep.get('persona')?.calls).toBe(4);
    expect(byStep.get('deliver')?.calls).toBe(0);
  });

  it('consumes an attempt only after the board exists (brief §2.3)', async () => {
    const harness = makeHarness();
    await run(harness);

    // One delivery record, and the board it names was published before it fired.
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.published?.board).toBe('boards/health-fitness-wellness');
    expect(harness.delivered[0]?.product_count).toBe(8);
  });
});
