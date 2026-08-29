/**
 * The Inngest edge: the failure mapping, the retry cap, and one end-to-end run
 * of a single product through the whole function body.
 *
 * `the-pit-agent-prompts.md` Phase 2 asks for "a successful end-to-end run of one
 * product through the pipeline" before moving on. That is the last block here,
 * and it goes through `executeRun` — the actual body of the registered function,
 * with only the bindings and the model swapped for in-memory ones.
 *
 * Hand-derived for a one-product category: 6 jurors x 1 chunk = 6 scoring calls,
 * 1 clustering call, and a single product cannot form a cluster of two, so
 * `01 §5.3`'s gate closes and the Floor is never asked. 7 calls, 5 steps, and a
 * delivery — `DECISIONS.md` S11 makes that a success, not a partial one.
 */

import { FixtureClient, ModelCallError } from '@the-pit/engine';
import { NonRetriableError } from 'inngest';
import { describe, expect, it } from 'vitest';

import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { isTerminalFailure, PhaseFailedError, SNAPSHOT_VERSION_CONFLICT } from '@/lib/pipeline/errors';
import { executeRun, inngestStepRunner, MAX_FREE_RETRIES, RUN_REQUESTED } from '@/lib/pipeline/inngest';
import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import { SnapshotVersionConflictError } from '@/lib/pipeline/pg-store';
import type { RunnerBindings } from '@/lib/pipeline/service';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore } from '@/lib/pipeline/store';
import { PIPELINE_STEPS } from '@/lib/pipeline/types';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, makeJury, makePanel, makeProducts, makeScript } from './helpers/panel.js';

describe('the retry budget', () => {
  it('caps free retries at three, per brief §2.3', () => {
    expect(MAX_FREE_RETRIES).toBe(3);
  });

  it('names the event the enqueuer sends', () => {
    expect(RUN_REQUESTED).toBe('pit/run.requested');
  });
});

describe('mapping a phase failure onto the executor', () => {
  it('lets a retryable failure be retried', async () => {
    const runner = inngestStepRunner(fakeStep());
    const failure = new PhaseFailedError('cluster', [
      { code: 'model_call', retryable: true, message: 'rate limited', causes: [] },
    ]);

    await expect(runner.run('cluster', () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('turns a terminal failure into NonRetriableError', async () => {
    // `dispatch` already decided this one cannot come out differently. Handing it
    // to Inngest unchanged would spend all three free retries reproducing it
    // before routing to support.
    const runner = inngestStepRunner(fakeStep());
    const failure = new PhaseFailedError('score', [
      { code: 'truncated', retryable: false, message: 'answer truncated', causes: [] },
    ]);

    await expect(runner.run('score', () => Promise.reject(failure))).rejects.toBeInstanceOf(NonRetriableError);
  });

  it('passes an ordinary error through untouched', async () => {
    const runner = inngestStepRunner(fakeStep());
    const boom = new Error('something else went wrong');
    await expect(runner.run('rank', () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('runs each body under the step id it was given', async () => {
    const step = fakeStep();
    const runner = inngestStepRunner(step);
    await runner.run('score', () => Promise.resolve('done'));
    await runner.run('deliver', () => Promise.resolve('done'));
    expect(step.ids).toEqual(['score', 'deliver']);
  });
});

describe('one product, end to end through the function body', () => {
  it('delivers, in five steps, for seven model calls', async () => {
    const store = new MemoryPipelineStore(CATEGORY);
    const snapshots = new MemorySnapshotSink();
    const meter = new CallMeter(new FixtureClient(makeScript()));
    const runner = new RecordingStepRunner();

    const bindings: RunnerBindings = {
      categories: new MemoryCategorySource([
        {
          category: CATEGORY,
          products: makeProducts(1),
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion: CATEGORY_VERSION },
        },
      ]),
      claims: new MemoryPlacementClaims(),
      store: () => store,
      snapshots,
    };

    const result = await executeRun({ slug: CATEGORY_SLUG }, bindings, runner, undefined, meter);

    expect(runner.ids).toHaveLength(PIPELINE_STEPS.length);
    expect(meter.total).toBe(7);
    expect(meter.callsIn('score')).toBe(6);
    expect(meter.callsIn('cluster')).toBe(1);
    // A lone product has nobody to be chosen over. `01 §5.3` closes the gate and
    // `DECISIONS.md` S11 calls the result a delivery.
    expect(meter.callsIn('persona')).toBe(0);
    expect(result.reports.find((report) => report.step === 'persona')?.status).toBe('skipped');

    expect(result.product_count).toBe(1);
    expect(result.published?.board).toBe(`boards/${CATEGORY_SLUG}`);
    expect((await snapshots.read(CATEGORY_SLUG))?.ranking.ranking[0]?.rank).toBe(1);
  });

  it('refuses a slug that is not seeded, without retrying it', async () => {
    const bindings: RunnerBindings = {
      categories: new MemoryCategorySource([]),
      store: () => new MemoryPipelineStore(CATEGORY),
      claims: new MemoryPlacementClaims(),
      snapshots: new MemorySnapshotSink(),
    };

    // No amount of retrying installs a category, so this is terminal on sight.
    await expect(
      executeRun({ slug: 'not-a-category' }, bindings, new RecordingStepRunner(), undefined, new FixtureClient([])),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it('does not consume an attempt when a phase fails', async () => {
    const delivered: unknown[] = [];
    const bindings: RunnerBindings = {
      categories: new MemoryCategorySource([
        {
          category: CATEGORY,
          products: makeProducts(4),
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion: CATEGORY_VERSION },
        },
      ]),
      store: () => new MemoryPipelineStore(CATEGORY),
      claims: new MemoryPlacementClaims(),
      snapshots: new MemorySnapshotSink(),
    };

    const client = new FixtureClient(
      makeScript({ uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }) }),
    );

    await expect(
      executeRun(
        { slug: CATEGORY_SLUG },
        bindings,
        new RecordingStepRunner(),
        (record) => {
          delivered.push(record);
          return Promise.resolve();
        },
        client,
      ),
    ).rejects.toBeInstanceOf(PhaseFailedError);

    // `brief §2.3`: an attempt is consumed only on delivery.
    expect(delivered).toHaveLength(0);
  });
});

describe('a deterministic storage fault does not spend the free-retry budget', () => {
  /**
   * The conflict, as `PgPipelineStore.writeRanking` actually throws it.
   *
   * Constructed rather than provoked from a database: the thing under test is
   * the classification at the step boundary, and a PGlite instance here would
   * test Postgres's unique constraint a second time while testing this not at
   * all.
   */
  function conflict(): SnapshotVersionConflictError {
    return new SnapshotVersionConflictError(
      'the board for "developer-tools" at category_snapshot_version "snap-1" already exists',
    );
  }

  it('runs the rank step ONCE for a snapshot version conflict', async () => {
    // The whole point, and the number that discriminates. `snapshots_category_version_uk`
    // is a unique constraint: the same run over the same stored rows produces the
    // same document and hits the same constraint on every attempt, so a retry is
    // `brief §2.3`'s free-retry budget spent reproducing a fault only an operator
    // can clear (bump `category_snapshot_version`, re-enqueue).
    const step = retryingStep();
    const runner = inngestStepRunner(step);

    await expect(runner.run('rank', () => Promise.reject(conflict()))).rejects.toBeInstanceOf(NonRetriableError);
    expect(step.attempts('rank')).toBe(1);
  });

  it('still spends all three on a failure that could come out differently', async () => {
    // The contrast that makes the 1 above mean something. Without it, a harness
    // that never retried anything would pass the first assertion.
    const step = retryingStep();
    const runner = inngestStepRunner(step);
    const rateLimited = new PhaseFailedError('cluster', [
      { code: 'model_call', retryable: true, message: 'rate limited', causes: [] },
    ]);

    await expect(runner.run('cluster', () => Promise.reject(rateLimited))).rejects.toBe(rateLimited);
    expect(step.attempts('cluster')).toBe(1 + MAX_FREE_RETRIES);
  });

  it('classifies on the code and not on the wording', async () => {
    // Two errors carrying the SAME message. Only the one with the code is
    // terminal — which is what stops the classifier quietly lapsing the day
    // somebody rewords `writeRanking`'s message, on the money path, in silence.
    const worded = new Error(conflict().message);
    expect(isTerminalFailure(worded)).toBe(false);

    const coded = Object.assign(new Error('a completely different sentence'), {
      code: SNAPSHOT_VERSION_CONFLICT,
    });
    expect(isTerminalFailure(coded)).toBe(true);
    expect(isTerminalFailure(conflict())).toBe(true);

    // And the code is the one the thrower actually carries, not a second copy of
    // the string that could drift away from it.
    expect(conflict().code).toBe(SNAPSHOT_VERSION_CONFLICT);
  });

  it('leaves an unrecognised error retryable, because guessing costs money either way', async () => {
    const step = retryingStep();
    const boom = new Error('the bucket returned 500');
    await expect(inngestStepRunner(step).run('deliver', () => Promise.reject(boom))).rejects.toBe(boom);
    expect(step.attempts('deliver')).toBe(1 + MAX_FREE_RETRIES);
  });
});

/**
 * Inngest's retry loop, as much of it as this file is entitled to assume.
 *
 * `retries: 3` re-invokes a step body up to three more times unless the body
 * threw `NonRetriableError`. Reproduced here rather than mocked away, because
 * "consumes no retries" is a claim about how many times the body RUNS, and a
 * harness that ran it once regardless could not tell a terminal failure from a
 * retryable one.
 */
function retryingStep(max: number = MAX_FREE_RETRIES): {
  attempts: (id: string) => number;
  run: (id: string, body: () => Promise<unknown>) => Promise<unknown>;
} {
  const counts = new Map<string, number>();
  return {
    attempts: (id) => counts.get(id) ?? 0,
    async run(id, body) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= max; attempt += 1) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
        try {
          return await body();
        } catch (error) {
          lastError = error;
          if (error instanceof NonRetriableError) throw error;
        }
      }
      throw lastError;
    },
  };
}

/** A stand-in for Inngest's `step`, which records ids and runs bodies inline. */
function fakeStep(): { ids: string[]; run: (id: string, body: () => Promise<unknown>) => Promise<unknown> } {
  const ids: string[] = [];
  return {
    ids,
    run(id, body) {
      ids.push(id);
      return body();
    },
  };
}
