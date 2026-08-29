/**
 * Resumability and the free retry — `brief §2.3`, and the version gate that keeps
 * it honest.
 *
 * > "Partial success is a failure. If the Six scored but the Floor call failed,
 * > the composite is missing 35% of its weight. Retry only the failed phase
 * > (cache makes completed calls free) and deliver once whole. Never deliver a
 * > degraded verdict."
 *
 * Two claims, and they pull in opposite directions. A retry must reuse what is
 * already bought, and it must NOT reuse anything produced under versions that
 * have since moved — a stored phase from a superseded `prompt_version` "is a
 * stale answer, not a saving" (`01 §9` rule 5, `brief §1.3`). The tests below
 * pin both, and the last one pins the pipeline's gate to the engine's so the two
 * cannot drift apart.
 *
 * Hand-derived call counts, from 8 products / 6 jurors / 1 chunk / 4 personas:
 *
 *   first attempt, clustering fails    6 scoring calls + 1 clustering call = 7
 *   retry                              1 clustering call + 4 choice calls  = 5
 *   ------------------------------------------------------------------------
 *   12 across both, against 11 + 11 = 22 if nothing were cached
 */

import { ModelCallError, runCategory, FixtureClient } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { PhaseFailedError } from '@/lib/pipeline/errors';
import { readStoredPhase } from '@/lib/pipeline/resume';

import { CATEGORY_VERSION, makeJury, makePanel, makeProducts, makeScript } from './helpers/panel.js';
import { makeHarness, run, runExpectingFailure } from './helpers/run.js';

describe('a phase that fails is persisted before it is thrown', () => {
  it('keeps the score phase that already landed when clustering fails', async () => {
    const harness = makeHarness({
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });

    const error = await runExpectingFailure(harness);
    expect(error).toBeInstanceOf(PhaseFailedError);
    expect((error as PhaseFailedError).step).toBe('cluster');
    // `brief §2.3`: a provider rate limit is a FREE retry.
    expect((error as PhaseFailedError).retryable).toBe(true);

    // Round 1 ran both steps before either failure was raised, and the pipeline
    // stopped there — persona, rank and deliver never started.
    expect([...harness.runner.ids].sort()).toEqual(['cluster', 'score']);
    expect(harness.meter.total).toBe(7);

    // Both phases are on disk: the good one so the retry does not re-buy it, the
    // failed one so the status page and the support queue have a diagnosis.
    const score = await readStoredPhase(harness.store, 'score', harness.versions);
    const uniqueness = await readStoredPhase(harness.store, 'uniqueness', harness.versions);
    expect(score.state).toBe('reusable');
    expect(uniqueness.state).toBe('failed');

    // "Persisted as it lands", not "persisted eventually": the score phase was
    // written before the run ended, and no results document was written at all.
    expect(harness.store.writes).toContain('phase:score');
    expect(harness.store.writes).not.toContain('results');
    expect(harness.store.ranking).toBeUndefined();
  });
});

describe('a retry re-runs only the failed phase', () => {
  it('reuses the stored score phase and buys nothing for it', async () => {
    const first = makeHarness({
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });
    await runExpectingFailure(first);

    const second = makeHarness({ store: first.store, snapshots: first.snapshots });
    const result = await run(second);

    const byStep = new Map(result.reports.map((report) => [report.step, report]));
    expect(byStep.get('score')?.status).toBe('resumed');
    expect(byStep.get('score')?.calls).toBe(0);

    // 1 clustering call + 4 choice calls. Not 11: the six juror calls were
    // already bought, and this is what "the vote cache makes a retried phase
    // nearly free" costs in practice.
    expect(second.meter.total).toBe(5);
    expect(second.meter.callsIn('score')).toBe(0);
    expect(second.meter.callsIn('cluster')).toBe(1);
    expect(second.meter.callsIn('persona')).toBe(4);

    // And it still delivers a whole board — `brief §2.3`'s "deliver once whole".
    expect(result.product_count).toBe(8);
    expect(second.delivered).toHaveLength(1);
  });

  it('still runs exactly five steps on the retry', async () => {
    const first = makeHarness({
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });
    await runExpectingFailure(first);

    const second = makeHarness({ store: first.store, snapshots: first.snapshots });
    await run(second);

    // A resumed phase is still a step — it is where the resume decision is made.
    // Skipping the step would make the pipeline's shape depend on its history.
    expect(second.runner.ids).toHaveLength(5);
  });
});

describe('a version bump invalidates a stored phase', () => {
  it('re-buys every phase when the prompt version moves', async () => {
    const first = makeHarness();
    await run(first);
    expect(first.meter.total).toBe(11);

    // `01 §4` Step 2: bump `prompt_version` on any edit to the rubric or the
    // mandates. `brief §1.3` exists so that a bump invalidates caches.
    const second = makeHarness({
      store: first.store,
      snapshots: first.snapshots,
      promptVersion: 'jury-v2',
    });
    const result = await run(second);

    const byStep = new Map(result.reports.map((report) => [report.step, report]));
    expect(byStep.get('score')?.status).toBe('ok');
    expect(byStep.get('score')?.calls).toBe(6);
    // Every phase, not just the scored one: `persona_version` and
    // `category_version` are unchanged, but a stale stamp on ANY of the four
    // fields refuses the whole envelope.
    expect(second.meter.total).toBe(11);
  });

  it('names which version moved rather than silently re-running', async () => {
    const first = makeHarness();
    await run(first);

    const bumped = makeHarness({ store: first.store, promptVersion: 'jury-v2' });
    const stored = await readStoredPhase(first.store, 'score', bumped.versions);

    expect(stored.state).toBe('stale');
    if (stored.state !== 'stale') throw new Error('unreachable');
    expect(stored.moved).toEqual(['prompt_version moved from "jury-v1" to "jury-v2"']);
  });

  it('reaches the same verdict the engine’s own resume gate reaches', async () => {
    // The drift pin. `resumePhase` is private to the engine, so the pipeline has
    // its own reader for the same envelopes; if the two ever disagreed, a phase
    // the pipeline called reusable would be re-bought inside the rank step — a
    // silent double charge on the one step that is supposed to spend nothing.
    const first = makeHarness();
    await run(first);

    const bumped = makeHarness({ store: first.store, promptVersion: 'jury-v2' });
    expect((await readStoredPhase(first.store, 'score', bumped.versions)).state).toBe('stale');

    const outcome = await runCategory({
      category: bumped.input.category,
      products: makeProducts(8),
      jury: makeJury('jury-v2'),
      personas: makePanel(),
      client: new FixtureClient(makeScript()),
      config: { categoryVersion: CATEGORY_VERSION, resume: true },
      store: first.store,
    });

    expect(outcome.status).toBe('delivered');
    expect(outcome.results.meta.warnings.join('\n')).toContain('refused the stored score phase');
    expect(outcome.results.meta.warnings.join('\n')).toContain('prompt_version moved');
  });
});

describe('a terminal failure does not get a free retry', () => {
  it('reports a max_tokens truncation as terminal (dispatch demotes it)', async () => {
    // `ModelCallError` says retryable, because at the adapter layer a truncation
    // might come back shorter. `dispatch` demotes it: the prompt is deterministic,
    // so the same category truncates on every attempt, and retrying it would burn
    // all three of `brief §2.3`'s free retries reproducing it.
    const harness = makeHarness({
      scoreError: () => new ModelCallError('answer truncated', { retryable: true, code: 'max_tokens' }),
    });

    const error = await runExpectingFailure(harness);
    expect(error).toBeInstanceOf(PhaseFailedError);
    expect((error as PhaseFailedError).retryable).toBe(false);
    expect((error as PhaseFailedError).failures[0]?.code).toBe('truncated');
  });

  it('never delivers a board for a run whose merit panel failed', async () => {
    const harness = makeHarness({
      scoreError: () => new ModelCallError('answer truncated', { retryable: true, code: 'max_tokens' }),
    });
    await runExpectingFailure(harness);

    // `brief §2.3`: never deliver a degraded verdict. No ranking, no snapshot, no
    // attempt consumed.
    expect(harness.store.ranking).toBeUndefined();
    expect(harness.snapshots.published).toHaveLength(0);
    expect(harness.delivered).toHaveLength(0);
  });
});
