import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, ENGINE_VERSION, JUROR_COUNT } from '../../src/config/constants.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import { ModelCallError } from '../../src/model/types.js';
import { SCORE_TOOL_NAME, UNIQ_TOOL_NAME, CHOICE_TOOL_NAME } from '../../src/panels/schemas.js';
import { chunkItems } from '../../src/rank/chunk.js';
import { MemoryRunStore } from '../../src/run/store.js';
import { runCategory } from '../../src/run/run-category.js';
import type { RunOutcome } from '../../src/run/types.js';
import {
  CATEGORY,
  CATEGORY_VERSION,
  idsShown,
  JURY,
  makeProducts,
  makeScript,
  PANEL,
  type ScriptOptions,
} from '../helpers/run-fixtures.js';

/**
 * The orchestrator, end to end, entirely offline (Global Constraint 5).
 *
 * The cases are chosen so that no two can pass for each other. In particular the
 * legitimate Customer skip and the failed clustering pass produce IDENTICAL
 * ranking output — every product solo, no demand, `cluster.id` a stand-in — and
 * one must be delivered while the other must never be. If a change ever collapsed
 * the two, `delivers a run whose Floor legitimately does not convene` and
 * `a failed clustering pass is a retryable failure` would not both stay green.
 */

interface RunArgs {
  products?: number;
  options?: ScriptOptions;
  store?: MemoryRunStore;
  resume?: boolean;
  chunkSize?: number;
  jury?: typeof JURY;
  personas?: typeof PANEL;
  categoryVersion?: string;
}

async function run(args: RunArgs = {}): Promise<{ outcome: RunOutcome; client: FixtureClient; store: MemoryRunStore }> {
  const client = new FixtureClient(makeScript(args.options ?? {}));
  const store = args.store ?? new MemoryRunStore(CATEGORY);
  const outcome = await runCategory({
    category: CATEGORY,
    products: makeProducts(args.products ?? 10),
    jury: args.jury ?? JURY,
    personas: args.personas ?? PANEL,
    client,
    store,
    config: {
      categoryVersion: args.categoryVersion ?? CATEGORY_VERSION,
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      ...(args.chunkSize === undefined ? {} : { chunkSize: args.chunkSize }),
    },
  });
  return { outcome, client, store };
}

const toolsUsed = (client: FixtureClient, tool: string): number =>
  client.requests.filter((request) => request.toolName === tool).length;

describe('runCategory — a clean full run', () => {
  it('delivers, and spends exactly 01 §7.3’s JUROR_COUNT x chunks + 1 + personas calls', async () => {
    const { outcome, client } = await run({ products: 10 });

    expect(outcome.status).toBe('delivered');
    // n=10 with CHUNK_SIZE 40 is one chunk: 6 x 1 + 1 + 4 = 11.
    expect(client.callCount).toBe(JUROR_COUNT * 1 + 1 + PANEL.personas.length);
    expect(toolsUsed(client, SCORE_TOOL_NAME)).toBe(JUROR_COUNT);
    expect(toolsUsed(client, UNIQ_TOOL_NAME)).toBe(1);
    expect(toolsUsed(client, CHOICE_TOOL_NAME)).toBe(PANEL.personas.length);
  });

  it('runs Score and Uniqueness together and Customer only after them (01 §2)', async () => {
    const { client } = await run({ products: 10 });

    const firstChoice = client.requests.findIndex((request) => request.toolName === CHOICE_TOOL_NAME);
    const lastRound1 = client.requests.reduce(
      (last, request, index) => (request.toolName === CHOICE_TOOL_NAME ? last : index),
      -1,
    );
    // Every Round-1 call is dispatched before the first Round-2 call, because
    // Customer needs the clusters (01 §2). Score and Uniqueness interleave freely.
    expect(firstChoice).toBeGreaterThan(lastRound1);
  });

  it('produces a ranking whose every product carries a demand signal', async () => {
    const { outcome } = await run({ products: 10, options: { clusterPlan: 'pairs' } });
    if (outcome.status !== 'delivered') throw new Error('expected a delivery');

    expect(outcome.ranking.ranking).toHaveLength(10);
    expect(outcome.ranking.ranking.every((row) => row.demand_status === 'scored')).toBe(true);
    expect(outcome.ranking.health.discrimination).toBeGreaterThan(0);
  });

  it('writes results.json with 01 §4 Step 5’s five keys and a per-phase ledger', async () => {
    const { outcome, store } = await run({ products: 10 });
    if (outcome.status !== 'delivered') throw new Error('expected a delivery');

    expect(Object.keys(store.results ?? {}).sort()).toEqual([
      'demand',
      'flaggedInjections',
      'meta',
      'scoreLog',
      'uniqueness',
    ]);

    const { ledger } = outcome.results.meta;
    expect(ledger.phases.score.calls).toBe(JUROR_COUNT);
    expect(ledger.phases.uniqueness.calls).toBe(1);
    expect(ledger.phases.customer.calls).toBe(PANEL.personas.length);
    expect(ledger.total.calls).toBe(JUROR_COUNT + 1 + PANEL.personas.length);
    expect(ledger.total.cost_usd).toBeGreaterThan(0);
    // The sum is the sum, not a separately-tracked number that could drift.
    expect(ledger.total.cost_usd).toBeCloseTo(
      ledger.phases.score.cost_usd + ledger.phases.uniqueness.cost_usd + ledger.phases.customer.cost_usd,
      12,
    );
  });

  it('reports a cold prompt cache instead of swallowing it', async () => {
    const cold = await run({ products: 10, options: { usage: { input_tokens: 900, output_tokens: 100 } } });
    expect(cold.outcome.results.meta.warnings.some((line) => line.includes('prompt cache never hit'))).toBe(true);

    const warm = await run({ products: 10 });
    expect(warm.outcome.results.meta.warnings.some((line) => line.includes('prompt cache never hit'))).toBe(false);
  });
});

describe('runCategory — the Floor legitimately does not convene (DECISIONS.md S11)', () => {
  it('delivers, marks the phase skipped:no_sets, and spends no persona calls', async () => {
    const { outcome, client } = await run({ products: 10, options: { clusterPlan: 'all-solo' } });

    expect(outcome.status).toBe('delivered');
    expect(outcome.results.meta.phases.customer.status).toBe('skipped');
    expect(outcome.results.meta.phases.customer.skipped).toBe('no_sets');
    expect(toolsUsed(client, CHOICE_TOOL_NAME)).toBe(0);
    // 01 §7.3's formula still holds; the personas term is simply zero.
    expect(client.callCount).toBe(JUROR_COUNT + 1);
  });

  it('leaves every product at demand_status solo_cluster with no demand log', async () => {
    const { outcome } = await run({ products: 10, options: { clusterPlan: 'all-solo' } });
    if (outcome.status !== 'delivered') throw new Error('expected a delivery');

    expect(outcome.results.demand).toBeNull();
    expect(outcome.ranking.ranking.every((row) => row.demand_status === 'solo_cluster')).toBe(true);
    expect(outcome.ranking.ranking.every((row) => row.demand === undefined)).toBe(true);
  });

  it('records the skip as a DELIVERED outcome in meta', async () => {
    const { outcome } = await run({ products: 10, options: { clusterPlan: 'all-solo' } });
    expect(outcome.results.meta.outcome).toBe('delivered');
  });
});

describe('runCategory — a failed clustering pass (brief §2.3)', () => {
  const failing: ScriptOptions = {
    uniquenessError: () => new ModelCallError('upstream connect error', { retryable: true, status: 503 }),
  };

  it('fails retryably and never produces a ranking', async () => {
    const { outcome } = await run({ products: 10, options: failing });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.retryable).toBe(true);
    // The delivered arm is the only one that carries a `ranking`, so a degraded
    // verdict is unrenderable rather than merely discouraged.
    expect('ranking' in outcome).toBe(false);
  });

  it('is DISTINGUISHABLE from the legitimate skip, though the board would look identical', async () => {
    const skipped = await run({ products: 10, options: { clusterPlan: 'all-solo' } });
    const broken = await run({ products: 10, options: failing });

    // Both leave `results.demand` null and no cluster information...
    expect(skipped.outcome.results.demand).toBeNull();
    expect(broken.outcome.results.demand).toBeNull();
    // ...and the phase results say which is which.
    expect(skipped.outcome.results.meta.phases.customer.status).toBe('skipped');
    expect(broken.outcome.results.meta.phases.customer.status).toBe('failed');
    expect(skipped.outcome.results.meta.outcome).toBe('delivered');
    expect(broken.outcome.results.meta.outcome).toBe('failed');
  });

  it('does not report the Customer phase as skipped when it never got the chance to run', async () => {
    const { outcome } = await run({ products: 10, options: failing });
    // The trap this closes: with no clusters there are no sets, so a naive
    // Customer phase would return `skipped: 'no_sets'` — S11's SUCCESSFUL status
    // — for a run that failed.
    expect(outcome.results.meta.phases.customer.skipped).toBeUndefined();
  });

  it('spends no persona calls once the clusters are gone', async () => {
    const { client } = await run({ products: 10, options: failing });
    expect(toolsUsed(client, CHOICE_TOOL_NAME)).toBe(0);
  });

  it('names the clustering pass in the failure, not just the phase', async () => {
    const { outcome } = await run({ products: 10, options: failing });
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    const clustering = outcome.failures.find((failure) => failure.causes.some((cause) => cause.includes('clustering pass')));
    expect(clustering?.retryable).toBe(true);
  });
});

describe('runCategory — a juror that returns nothing (brief §2.3)', () => {
  const silent: ScriptOptions = { silentJurors: ['Juror 3'] };

  it('fails rather than delivering a five-juror composite', async () => {
    const { outcome } = await run({ products: 10, options: silent });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.retryable).toBe(true);
    expect(outcome.results.meta.outcome).toBe('failed');
  });

  it('surfaces the silent juror in substituted_roles rather than shrinking the panel', async () => {
    const { outcome } = await run({ products: 10, options: silent });
    const { coverage } = outcome.results.meta;

    expect(coverage.complete).toBe(false);
    expect(coverage.missing_roles).toEqual(['Juror 3']);
    expect(coverage.jurors_answered).toBe(JUROR_COUNT - 1);
    expect(coverage.jurors_expected).toBe(JUROR_COUNT);

    // Every (product, metric) cell names the juror that did not answer — the
    // exact field `ScorecardEntry.substituted_roles` publishes, so the disclosure
    // and the completeness check cannot disagree.
    expect(coverage.substituted).toHaveLength(10 * JURY.metrics.length);
    expect(coverage.substituted.every((cell) => cell.roles.includes('Juror 3'))).toBe(true);
  });

  it('names the juror in the failure causes', async () => {
    const { outcome } = await run({ products: 10, options: silent });
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    const causes = outcome.failures.flatMap((failure) => failure.causes);
    expect(causes.some((cause) => cause.includes('"Juror 3"'))).toBe(true);
    expect(causes.some((cause) => cause.includes('returned no scores at all'))).toBe(true);
  });

  it('writes NO partial score log into the field the ranker reads', async () => {
    const { outcome } = await run({ products: 10, options: silent });
    // A five-juror log in `results.scoreLog` is a degraded verdict waiting to be
    // recomputed offline. The diagnosis is kept; the votes are not.
    expect(outcome.results.scoreLog).toEqual([]);
    expect(outcome.results.meta.phases.score.failure?.coverage?.missing_roles).toEqual(['Juror 3']);
  });

  it('records it as a `schema` failure, not as a provider failure', async () => {
    // The silent juror ANSWERED — `{scores: []}` is a well-formed tool call that
    // then breaks `01 §5.1`. Reporting that as `model_call` names a provider
    // outage in the integrity record of a run where the provider worked fine.
    // `schema` is documented at run/types.ts and was unreachable at the phase
    // level; both codes are retryable, so only the record changes.
    const { outcome } = await run({ products: 10, options: silent });
    expect(outcome.results.meta.phases.score.failure?.code).toBe('schema');
    expect(outcome.results.meta.phases.score.failure?.retryable).toBe(true);
  });

  it('still says `model_call` when the provider is the one that failed', async () => {
    // The other half: a thrown `ModelCallError` must not be relabelled `schema`
    // just because the new branch exists.
    const { outcome } = await run({
      products: 10,
      options: { uniquenessError: () => new ModelCallError('503', { retryable: true, status: 503 }) },
    });
    expect(outcome.results.meta.phases.uniqueness.failure?.code).toBe('model_call');
  });
});

describe('runCategory — brief §2.3 partial success with every call successful', () => {
  /**
   * Two installed jurors sharing one `role`. `validateJury` refuses this at
   * install time, and the phase is the last line of defence if one ever reaches
   * it: every call returns and validates, nothing is missing and no cell is
   * substituted — but `mergeScoreLog` folds the twins into ONE juror, so
   * `computeComposite` divides by 5 where 6 are installed and every composite
   * (and `discrimination` over them) is scaled by 6/5.
   */
  const twinned = {
    ...JURY,
    jurors: [...JURY.jurors.slice(0, 5), { ...JURY.jurors[5]!, role: JURY.jurors[0]!.role }],
  };

  it('fails with `incomplete_panel` rather than delivering a board divided by five', async () => {
    const { outcome } = await run({ products: 10, jury: twinned });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    // `brief §2.3`: retry free, never deliver.
    expect(outcome.retryable).toBe(true);
    expect(outcome.results.meta.phases.score.failure?.code).toBe('incomplete_panel');
    expect(outcome.results.meta.outcome).toBe('failed');
  });

  it('reaches that branch with no failed call and no substituted cell', async () => {
    // What makes this case distinct from the silent-juror one above: there is
    // nothing wrong with any ANSWER. If a future change made the phase infer
    // partial success from failures alone, this test is the one that notices.
    const { outcome } = await run({ products: 10, jury: twinned });
    const coverage = outcome.results.meta.phases.score.failure?.coverage;

    expect(coverage?.missing_roles).toEqual([]);
    expect(coverage?.substituted).toEqual([]);
    expect(coverage?.jurors_answered).toBe(JUROR_COUNT - 1);
    expect(coverage?.jurors_expected).toBe(JUROR_COUNT);
    expect(outcome.results.meta.ledger.total.failed_calls).toBe(0);
  });

  it('names the cause, so a failure with no missing role is still readable', async () => {
    const { outcome } = await run({ products: 10, jury: twinned });
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    const causes = outcome.failures.flatMap((failure) => failure.causes);
    expect(causes.some((cause) => cause.includes('share a role'))).toBe(true);
    expect(causes.some((cause) => cause.includes('divides by 5'))).toBe(true);
  });
});

describe('runCategory — persistence and resumability', () => {
  it('persists Score and Uniqueness before the Customer phase fails', async () => {
    const { store } = await run({
      products: 10,
      options: { personaError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }) },
    });

    // The claim "persist as it lands" is a claim about ORDER, so it is asserted
    // as one: both Round-1 phases are on disk before the Round-2 failure is.
    expect(store.writes.indexOf('phase:score')).toBeLessThan(store.writes.indexOf('phase:customer'));
    expect(store.writes.indexOf('phase:uniqueness')).toBeLessThan(store.writes.indexOf('phase:customer'));
    expect(store.phases.get('score')).toBeDefined();
    expect(store.phases.get('uniqueness')).toBeDefined();
    // ...and results.json is written last, after every phase, on a failed run too.
    expect(store.writes.at(-1)).toBe('results');
    expect(store.ranking).toBeUndefined();
  });

  it('re-buys nothing that already succeeded when resuming', async () => {
    const first = await run({
      products: 10,
      options: { personaError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }) },
    });
    expect(first.outcome.status).toBe('failed');

    const second = await run({ products: 10, store: first.store, resume: true });

    expect(second.outcome.status).toBe('delivered');
    // Only the failed phase is re-run: four persona calls, no scoring, no clustering.
    expect(second.client.callCount).toBe(PANEL.personas.length);
    expect(toolsUsed(second.client, SCORE_TOOL_NAME)).toBe(0);
    expect(toolsUsed(second.client, UNIQ_TOOL_NAME)).toBe(0);
  });

  it('does not resume a persisted FAILURE, or the retry would be a no-op', async () => {
    const first = await run({
      products: 10,
      options: { uniquenessError: () => new ModelCallError('503', { retryable: true, status: 503 }) },
    });
    expect(first.outcome.status).toBe('failed');

    const second = await run({ products: 10, store: first.store, resume: true });
    expect(second.outcome.status).toBe('delivered');
    expect(toolsUsed(second.client, UNIQ_TOOL_NAME)).toBe(1);
  });

  it('stamps every persisted phase with the versions it was produced under', async () => {
    const { store } = await run({ products: 10 });
    const stored = store.phases.get('score') as { versions: Record<string, string>; result: { status: string } };

    expect(stored.result.status).toBe('ok');
    expect(stored.versions).toEqual({
      category_version: CATEGORY_VERSION,
      prompt_version: JURY.prompt_version,
      persona_version: PANEL.persona_version,
      engine_version: ENGINE_VERSION,
    });
  });

  it('writes ranking.json only on a delivery', async () => {
    const good = await run({ products: 10 });
    expect(good.store.ranking).toBeDefined();
    expect(good.store.writes).toContain('ranking');
  });
});

describe('runCategory — --resume refuses a stale phase (01 §9 rule 5, brief §1.3)', () => {
  const transientFailure: ScriptOptions = {
    personaError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }),
  };

  /** A failed run whose Score and Uniqueness phases are on disk. */
  async function failedThenResume(second: RunArgs) {
    const first = await run({ products: 10, options: transientFailure });
    expect(first.outcome.status).toBe('failed');
    return run({ products: 10, store: first.store, resume: true, ...second });
  }

  it('re-runs the Score phase when prompt_version was bumped between attempts', async () => {
    // The exact sequence 01 §4 Step 2 invites: edit the installed jury, bump
    // prompt_version, re-run. Without the version stamp the stored Score phase is
    // read straight off disk and delivered while meta.prompt_version says "v2" —
    // a board claiming scores from a rubric that never produced them.
    const bumped = { ...JURY, prompt_version: 'jury-v2' };
    const { outcome, client } = await failedThenResume({ jury: bumped });

    expect(outcome.status).toBe('delivered');
    expect(toolsUsed(client, SCORE_TOOL_NAME)).toBe(JUROR_COUNT);
    expect(outcome.results.meta.prompt_version).toBe('jury-v2');
    expect(outcome.results.meta.warnings.some((w) => w.includes('prompt_version moved from "jury-v1" to "jury-v2"'))).toBe(
      true,
    );
  });

  it('re-runs everything when category_version was bumped, because the chunks would differ', async () => {
    // The ordering seed is (slug, categoryVersion), so a resumed Score phase
    // would carry a chunk composition the current version never produces —
    // silently breaking this task's own orderedChunks guarantee for that run.
    const { outcome, client } = await failedThenResume({ categoryVersion: 'v8' });

    expect(outcome.status).toBe('delivered');
    expect(toolsUsed(client, SCORE_TOOL_NAME)).toBe(JUROR_COUNT);
    expect(toolsUsed(client, UNIQ_TOOL_NAME)).toBe(1);
    expect(outcome.results.meta.warnings.some((w) => w.includes('category_version moved'))).toBe(true);
  });

  it('re-runs when persona_version was bumped', async () => {
    const { outcome, client } = await failedThenResume({ personas: { ...PANEL, persona_version: 'personas-v2' } });

    expect(toolsUsed(client, SCORE_TOOL_NAME)).toBe(JUROR_COUNT);
    expect(outcome.results.meta.warnings.some((w) => w.includes('persona_version moved'))).toBe(true);
  });

  it('names every version that moved, not just the first', async () => {
    const { outcome } = await failedThenResume({
      jury: { ...JURY, prompt_version: 'jury-v2' },
      categoryVersion: 'v8',
    });
    const warning = outcome.results.meta.warnings.find((w) => w.startsWith('resume: refused the stored score'));

    expect(warning).toContain('category_version moved');
    expect(warning).toContain('prompt_version moved');
  });

  it('still resumes when nothing moved, so the guard costs a matched run nothing', async () => {
    const { outcome, client } = await failedThenResume({});

    expect(outcome.status).toBe('delivered');
    expect(client.callCount).toBe(PANEL.personas.length);
    expect(outcome.results.meta.warnings.some((w) => w.startsWith('resume: refused'))).toBe(false);
  });

  it('refuses a stored phase with no version stamp at all', async () => {
    const store = new MemoryRunStore(CATEGORY);
    // A file written by an older build, or by hand.
    await store.writePhase('uniqueness', { phase: 'uniqueness', status: 'ok', value: {} });

    const { outcome, client } = await run({ products: 10, store, resume: true });
    expect(outcome.status).toBe('delivered');
    expect(toolsUsed(client, UNIQ_TOOL_NAME)).toBe(1);
    expect(outcome.results.meta.warnings.some((w) => w.includes('not a version-stamped result'))).toBe(true);
  });
});

describe('runCategory — a TERMINAL failure is not a free retry (brief §2.3)', () => {
  // The boolean that decides "burn one of three free retries" versus "route to
  // the support queue". MAX_TOKENS_UNIQUENESS is derived from an unbounded
  // category size, so a category large enough to overflow it overflows on every
  // attempt — and anthropic-client.ts classifies that truncation as RETRYABLE.
  const truncating: ScriptOptions = {
    uniquenessError: () =>
      new ModelCallError('response was truncated at max_tokens', { retryable: true, code: 'max_tokens' }),
  };

  it('reports retryable:false end to end, overriding the adapter’s classification', async () => {
    const { outcome } = await run({ products: 10, options: truncating });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.retryable).toBe(false);
  });

  it('codes it `truncated` and names the constant to raise', async () => {
    const { outcome } = await run({ products: 10, options: truncating });
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    const truncation = outcome.failures.find((failure) => failure.code === 'truncated');
    expect(truncation).toBeDefined();
    expect(truncation!.retryable).toBe(false);
    expect(truncation!.causes.join(' ')).toContain('MAX_TOKENS_');
    expect(truncation!.causes.join(' ')).toContain('every retry will truncate identically');
  });

  it('is a DIFFERENT outcome from the same phase failing transiently', async () => {
    const transient = await run({
      products: 10,
      options: { uniquenessError: () => new ModelCallError('503', { retryable: true, status: 503 }) },
    });
    const terminal = await run({ products: 10, options: truncating });

    if (transient.outcome.status !== 'failed' || terminal.outcome.status !== 'failed') {
      throw new Error('expected two failures');
    }
    // Same phase, same non-delivery, opposite retry decisions.
    expect(transient.outcome.retryable).toBe(true);
    expect(terminal.outcome.retryable).toBe(false);
  });

  it('stays non-retryable even when another phase failed retryably', async () => {
    const { outcome } = await run({
      products: 10,
      options: { ...truncating, silentJurors: ['Juror 1'] },
    });
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    // One terminal failure means the run cannot come out differently, whatever
    // else also went wrong.
    expect(outcome.failures.some((failure) => failure.retryable)).toBe(true);
    expect(outcome.retryable).toBe(false);
  });
});

describe('runCategory — an unpriced model understates the cost', () => {
  it('warns rather than reporting $0.0000 as fact', async () => {
    // Task 9's handoff adapter cannot report a priced model id at all, so this is
    // the normal case for every locally-seeded run.
    const { outcome } = await run({ products: 10, options: { modelId: 'local-subagent' } });

    expect(outcome.status).toBe('delivered');
    expect(outcome.results.meta.ledger.total.cost_usd).toBe(0);
    expect(outcome.results.meta.ledger.total.unpriced_models).toEqual(['local-subagent']);
    expect(outcome.results.meta.warnings.some((w) => w.includes('cost is UNDERSTATED'))).toBe(true);
    expect(outcome.results.meta.warnings.some((w) => w.includes('lower bound'))).toBe(true);
  });

  it('says nothing when every id is priced', async () => {
    const { outcome } = await run({ products: 10 });
    expect(outcome.results.meta.ledger.total.unpriced_models).toEqual([]);
    expect(outcome.results.meta.warnings.some((w) => w.includes('cost is UNDERSTATED'))).toBe(false);
  });
});

describe('runCategory — the chunks are never rank-contiguous', () => {
  const HEALTH_AND_FITNESS = 44;

  it('does not hand any juror a rank-contiguous band of the incoming leaderboard', async () => {
    const { client } = await run({ products: HEALTH_AND_FITNESS });

    const scoreRequests = client.requests.filter((request) => request.toolName === SCORE_TOOL_NAME);
    expect(scoreRequests).toHaveLength(JUROR_COUNT * 2);

    // What the defect looks like: `chunkItems` in id order splits 44 into ranks
    // 1-22 and 23-44, so each half is scored against a differently-calibrated
    // field and `computeComposite` then z-normalizes both as one population.
    const naive = chunkItems(makeProducts(HEALTH_AND_FITNESS), CHUNK_SIZE).map((chunk) =>
      chunk.map((product) => product.id),
    );
    expect(naive[0]).toEqual([...Array(22).keys()]);

    for (const request of scoreRequests) {
      const ids = idsShown(request);
      expect(ids).toHaveLength(22);
      expect(ids.slice().sort((a, b) => a - b)).not.toEqual(naive[0]);
      expect(ids.slice().sort((a, b) => a - b)).not.toEqual(naive[1]);
      // Every chunk straddles the leaderboard's midpoint.
      expect(ids.some((id) => id < HEALTH_AND_FITNESS / 2)).toBe(true);
      expect(ids.some((id) => id >= HEALTH_AND_FITNESS / 2)).toBe(true);
    }
  });

  it('gives the clustering pass the same decorrelated order, not id order', async () => {
    const { client } = await run({ products: HEALTH_AND_FITNESS });
    const uniqueness = client.requests.find((request) => request.toolName === UNIQ_TOOL_NAME);
    expect(idsShown(uniqueness!)).not.toEqual([...Array(HEALTH_AND_FITNESS).keys()]);
  });

  it('shows every juror the identical chunk composition, so the cache prefix can hit', async () => {
    const { client } = await run({ products: HEALTH_AND_FITNESS });
    const scoreRequests = client.requests.filter((request) => request.toolName === SCORE_TOOL_NAME);

    // Six jurors x two chunks; the two distinct chunk compositions must repeat
    // exactly six times each, or the shared prefix is not shared.
    const seen = new Map<string, number>();
    for (const request of scoreRequests) {
      const key = idsShown(request).join(',');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.values()]).toEqual([JUROR_COUNT, JUROR_COUNT]);
  });

  it('still covers every product exactly once per juror', async () => {
    const { client } = await run({ products: HEALTH_AND_FITNESS });
    const perJuror = new Map<string, number[]>();

    for (const request of client.requests) {
      if (request.toolName !== SCORE_TOOL_NAME) continue;
      const mandate = request.messages[0]?.content;
      const role = typeof mandate === 'string' ? (/You are (Juror \d+)\./.exec(mandate)?.[1] ?? '?') : '?';
      perJuror.set(role, [...(perJuror.get(role) ?? []), ...idsShown(request)]);
    }

    expect(perJuror.size).toBe(JUROR_COUNT);
    for (const ids of perJuror.values()) {
      expect(ids.slice().sort((a, b) => a - b)).toEqual([...Array(HEALTH_AND_FITNESS).keys()]);
    }
  });
});

describe('runCategory — guards', () => {
  it('refuses a run with no products, no jurors, or no rubric', async () => {
    const base = {
      category: CATEGORY,
      jury: JURY,
      personas: PANEL,
      client: new FixtureClient([]),
      config: { categoryVersion: CATEGORY_VERSION },
    };
    await expect(runCategory({ ...base, products: [] })).rejects.toThrow(RangeError);
    await expect(runCategory({ ...base, products: makeProducts(4), jury: { ...JURY, jurors: [] } })).rejects.toThrow(
      RangeError,
    );
    await expect(runCategory({ ...base, products: makeProducts(4), jury: { ...JURY, metrics: [] } })).rejects.toThrow(
      RangeError,
    );
  });
});
