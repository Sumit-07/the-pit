/**
 * The status page's one requirement, from `brief` Part 6:
 *
 * > "**Status page** — resumable. Someone who closes the tab at 40s returns to
 * > live progress, not a spinner or a dead job."
 *
 * Every test here reads the status of a run through `readRunStatus` WITHOUT ever
 * having observed the run happen — no listener, no stream, no in-memory handle
 * on the pipeline. That is the whole claim: state is reconstructed from the
 * persisted phase envelopes, so the reloading customer and the customer who never
 * left see the same thing.
 *
 * The second theme is honesty about what is actually banked. A phase stored under
 * a version that has since moved is reported PENDING, not done — the next attempt
 * re-buys it, and a progress bar that counted it would run backwards in the only
 * way a progress bar can: by taking longer at 60% than it did at 20%.
 */

import { ModelCallError } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { readRunStatus } from '@/lib/pipeline/status';
import { PIPELINE_STEPS } from '@/lib/pipeline/types';

import { makeHarness, run, runExpectingFailure } from './helpers/run.js';

describe('a run nobody has started', () => {
  it('reads as queued with every step pending', async () => {
    const harness = makeHarness();
    const status = await readRunStatus({
      store: harness.store,
      versions: harness.versions,
      snapshots: harness.snapshots,
    });

    expect(status.state).toBe('queued');
    expect(status.steps.map((step) => step.step)).toEqual([...PIPELINE_STEPS]);
    expect(status.steps.every((step) => step.state === 'pending')).toBe(true);
    expect(status.completed).toBe(0);
    expect(status.total).toBe(5);
    expect(status.votes_cached).toBe(0);
  });
});

describe('a run interrupted halfway', () => {
  it('shows the phases that landed, reconstructed from disk alone', async () => {
    // The tab-closed-at-40s case. The Six have answered, clustering has not.
    const harness = makeHarness({
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });
    await runExpectingFailure(harness);

    const status = await readRunStatus({
      store: harness.store,
      versions: harness.versions,
      snapshots: harness.snapshots,
    });

    const byStep = new Map(status.steps.map((step) => [step.step, step]));
    expect(byStep.get('score')?.state).toBe('done');
    expect(byStep.get('score')?.calls).toBe(6);
    expect(byStep.get('cluster')?.state).toBe('failed');
    expect(byStep.get('persona')?.state).toBe('pending');
    expect(byStep.get('rank')?.state).toBe('pending');
    expect(byStep.get('deliver')?.state).toBe('pending');

    // Not a spinner, and not a dead job: one step done out of five, and the
    // failure named as free.
    expect(status.completed).toBe(1);
    expect(status.state).toBe('retrying');
    expect(status.failure?.retryable).toBe(true);
    expect(status.votes_cached).toBe(48);
  });

  it('separates a free retry from a run that needs a person', async () => {
    const harness = makeHarness({
      scoreError: () => new ModelCallError('answer truncated', { retryable: true, code: 'max_tokens' }),
    });
    await runExpectingFailure(harness);

    const status = await readRunStatus({ store: harness.store, versions: harness.versions });

    // `dispatch` demoted the truncation to terminal, so this is the end of the
    // automatic road — and the page must not tell the customer it is retrying.
    expect(status.state).toBe('needs_support');
    expect(status.failure?.retryable).toBe(false);
  });
});

describe('a delivered run', () => {
  it('reads as delivered with all five steps closed out', async () => {
    const harness = makeHarness();
    await run(harness);

    const status = await readRunStatus({
      store: harness.store,
      versions: harness.versions,
      snapshots: harness.snapshots,
    });

    expect(status.state).toBe('delivered');
    expect(status.completed).toBe(5);
    expect(status.delivered_at).toBe('2026-03-01T12:00:00.000Z');
    expect(status.failure).toBeUndefined();
  });

  it('counts a solo-cluster skip as a completed step, not a missing one', async () => {
    const harness = makeHarness({ clusterPlan: 'all-solo' });
    await run(harness);

    const status = await readRunStatus({
      store: harness.store,
      versions: harness.versions,
      snapshots: harness.snapshots,
    });

    const persona = status.steps.find((step) => step.step === 'persona');
    expect(persona?.state).toBe('skipped');
    // `DECISIONS.md` S11: a terminal, SUCCESSFUL status. A progress bar that
    // stalled at 4/5 forever would be showing a complete run as stuck.
    expect(status.completed).toBe(5);
    expect(status.state).toBe('delivered');
    expect(persona?.detail).toContain('a complete run');
  });
});

describe('a stored phase whose versions have moved', () => {
  it('is reported pending, with the version that moved named', async () => {
    const first = makeHarness();
    await run(first);

    const bumped = makeHarness({ store: first.store, promptVersion: 'jury-v2' });
    const status = await readRunStatus({ store: first.store, versions: bumped.versions });

    const score = status.steps.find((step) => step.step === 'score');
    expect(score?.state).toBe('pending');
    expect(score?.detail).toContain('prompt_version moved from "jury-v1" to "jury-v2"');
    // And nothing is claimed as banked, because nothing is.
    expect(status.votes_cached).toBe(0);
  });
});
