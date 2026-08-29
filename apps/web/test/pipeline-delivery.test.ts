/**
 * The delivery decision, on the two runs that look identical from the output and
 * mean opposite things on the money path.
 *
 * A category where every cluster holds one product and a category whose
 * clustering call failed produce byte-identical boards: no demand entries, every
 * row at `demand_status: 'solo_cluster'`, `results.demand` null. `DECISIONS.md`
 * S11 says the first is a SUCCESSFUL delivery — the attempt is consumed, the
 * verdict is published. `brief §2.3` says the second must be retried free and
 * never delivered.
 *
 * The distinction exists only in the phase that made the call, which is why the
 * engine's `PhaseResult` is a three-armed union and why `isDeliverable` reads
 * nothing else. These tests drive both runs through the pipeline and assert that
 * the pipeline preserves the distinction rather than re-deriving it from a board
 * that cannot carry it.
 *
 * Hand-derived: 8 products / 6 jurors / 1 chunk, every product in a cluster of
 * one, so `01 §5.3`'s gate closes and the Floor is never asked anything.
 *
 *   6 scoring calls + 1 clustering call + 0 choice calls = 7
 */

import { ModelCallError } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { PhaseFailedError } from '@/lib/pipeline/errors';
import { readStoredPhase } from '@/lib/pipeline/resume';

import { makeHarness, run, runExpectingFailure } from './helpers/run.js';

describe('a genuine solo-cluster category delivers (DECISIONS.md S11)', () => {
  it('skips the Floor and still publishes a board', async () => {
    const harness = makeHarness({ clusterPlan: 'all-solo' });
    const result = await run(harness);

    // No cluster held two products, so there was no forced choice to put to
    // anybody. The Floor cost nothing and the run is complete.
    expect(harness.meter.total).toBe(7);
    expect(harness.meter.callsIn('persona')).toBe(0);

    const persona = result.reports.find((report) => report.step === 'persona');
    expect(persona?.status).toBe('skipped');
    expect(persona?.detail).toContain('no_sets');

    expect(result.product_count).toBe(8);
    expect(harness.snapshots.published).toHaveLength(1);
    expect(harness.delivered).toHaveLength(1);
  });

  it('stores the skip as a terminal success, not a failure', async () => {
    const harness = makeHarness({ clusterPlan: 'all-solo' });
    await run(harness);

    const stored = await readStoredPhase(harness.store, 'customer', harness.versions);
    expect(stored.state).toBe('reusable');
    if (stored.state !== 'reusable') throw new Error('unreachable');
    expect(stored.result.status).toBe('skipped');
  });

  it('still runs the persona step, which is where the skip is decided', async () => {
    const harness = makeHarness({ clusterPlan: 'all-solo' });
    await run(harness);

    // The gate is `01 §5.3`'s and lives inside `runCustomerPhase`. Deciding it in
    // the pipeline instead — "no multi-member clusters, so don't run the step" —
    // would move a rule that decides delivery out of the phase that owns it.
    expect(harness.runner.ids).toHaveLength(5);
  });

  it('ranks every product on merit alone without inventing a demand signal', async () => {
    const harness = makeHarness({ clusterPlan: 'all-solo' });
    await run(harness);

    const ranking = await harness.store.readRanking();
    expect(ranking?.ranking).toHaveLength(8);
    expect(ranking?.ranking.every((row) => row.demand_status === 'solo_cluster')).toBe(true);
    expect(ranking?.ranking.every((row) => row.demand === undefined)).toBe(true);
  });
});

describe('a failed clustering pass does not deliver, however similar the board would look', () => {
  it('retries instead, and publishes nothing', async () => {
    const harness = makeHarness({
      uniquenessError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }),
    });

    const error = await runExpectingFailure(harness);
    expect(error).toBeInstanceOf(PhaseFailedError);
    expect((error as PhaseFailedError).retryable).toBe(true);

    // The contrast with the block above: the same absent demand signal, the
    // opposite decision. Nothing published, nothing charged.
    expect(harness.snapshots.published).toHaveLength(0);
    expect(harness.delivered).toHaveLength(0);
    expect(harness.store.ranking).toBeUndefined();
  });

  it('never reaches the persona step, so the skip can never be mistaken for the failure', async () => {
    const harness = makeHarness({
      uniquenessError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }),
    });
    await runExpectingFailure(harness);

    expect(harness.runner.ids).not.toContain('persona');
    // Had the pipeline run it anyway, `runCustomerPhase` would have returned
    // `skipped: 'no_sets'` — S11's successful status — for a run that actually
    // failed, and the customer would have been charged for a broken board.
    const stored = await readStoredPhase(harness.store, 'customer', harness.versions);
    expect(stored.state).toBe('absent');
  });
});
