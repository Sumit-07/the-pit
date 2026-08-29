import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildHandoffPlan, callPaths } from '../../src/cli/handoff.js';
import { MODEL_ID_LOCAL_SUBAGENT } from '../../src/config/constants.js';
import {
  HandoffClient,
  HandoffPendingError,
  HandoffResponseError,
  LOCAL_SEEDING_CAVEAT,
  ROUND_OF_PHASE,
  phaseForTool,
  sameRequest,
  type HandoffCall,
  type HandoffPlan,
  type HandoffRequestFile,
} from '../../src/model/handoff-client.js';
import type { ModelRequest } from '../../src/model/types.js';
import { orderedChunks } from '../../src/panels/ordering.js';
import { buildChoiceRequest, similarSets } from '../../src/panels/prompts/choice.js';
import { buildScoreRequest } from '../../src/panels/prompts/score.js';
import { buildUniquenessRequest } from '../../src/panels/prompts/uniqueness.js';
import { CHOICE_TOOL_NAME, SCORE_TOOL_NAME, UNIQ_TOOL_NAME } from '../../src/panels/schemas.js';
import type { UniquenessResult } from '../../src/types.js';
import {
  CATEGORY,
  CATEGORY_VERSION,
  JURY,
  METRIC_NAMES,
  PANEL,
  choiceAnswer,
  idsShown,
  makeProducts,
  scoreAnswer,
  uniquenessAnswer,
} from '../helpers/run-fixtures.js';

/**
 * `HandoffClient` — the keyless path (`01 §1`, `§9` rule 1), which is how every
 * Phase 1 category is actually going to be seeded.
 *
 * The through-line of this file is that a handoff must be LOUD. A file exchange
 * answered by hand has failure modes an API call does not: an answer to a
 * question that has since changed, an answer filed under the wrong juror, an
 * answer whose arithmetic does not add up. Each of those is asserted to fail with
 * the path of the offending file in the message, because sixty files is too many
 * to bisect by hand.
 *
 * Everything here is offline and touches only a temp directory (Global
 * Constraint 5).
 */

const PRODUCTS = makeProducts(6);
const ORDERING = { category: CATEGORY, categoryVersion: CATEGORY_VERSION };
const CHUNK = orderedChunks(PRODUCTS, ORDERING)[0] ?? [];

/** A cluster roster over the six products: three pairs, so every set has a choice in it. */
const UNIQUENESS = uniquenessAnswer(
  PRODUCTS.map((product) => product.id),
  'pairs',
) as UniquenessResult;

const PLAN: HandoffPlan = buildHandoffPlan({
  products: PRODUCTS,
  jury: JURY,
  personas: PANEL,
  ordering: ORDERING,
  uniqueness: UNIQUENESS,
});

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'the-pit-handoff-'));
}

/** The request the Score phase would build for juror `index`, chunk 1. */
function scoreRequest(index: number): ModelRequest {
  const juror = JURY.jurors[index];
  if (juror === undefined) throw new Error(`no juror ${index}`);
  return buildScoreRequest({ metrics: JURY.metrics, products: CHUNK, juror, ordering: ORDERING });
}

/** The request the Customer phase would build for persona `index`. */
function choiceRequest(index: number): ModelRequest {
  const persona = PANEL.personas[index];
  if (persona === undefined) throw new Error(`no persona ${index}`);
  return buildChoiceRequest({ persona, sets: similarSets(UNIQUENESS, PRODUCTS), ordering: ORDERING });
}

function call(phase: 'score' | 'uniqueness' | 'customer', index = 0): HandoffCall {
  const entry = PLAN[phase][index];
  if (entry === undefined) throw new Error(`no planned ${phase} call ${index}`);
  return entry;
}

/** Emit one request, then answer it with `answer`. Returns both paths. */
async function emitThenAnswer(
  dir: string,
  request: ModelRequest,
  planned: HandoffCall,
  answer: unknown,
): Promise<{ request: string; response: string }> {
  const client = new HandoffClient({ dir, mode: 'emit', round: ROUND_OF_PHASE[planned.phase], plan: PLAN });
  await expect(client.complete(request)).rejects.toBeInstanceOf(HandoffPendingError);

  const paths = callPaths(dir, planned);
  await writeFile(paths.response, `${JSON.stringify(answer, null, 2)}\n`, 'utf8');
  return paths;
}

/** Ingest one request against whatever is on disk. */
function ingestOne(dir: string, request: ModelRequest, planned: HandoffCall): Promise<unknown> {
  const client = new HandoffClient({ dir, mode: 'ingest', round: ROUND_OF_PHASE[planned.phase], plan: PLAN });
  return client.complete(request);
}

describe('HandoffClient — emit', () => {
  it('writes one request file per call, carrying the rendered prompt, the schema and who it is for', async () => {
    const dir = await makeDir();
    const client = new HandoffClient({ dir, mode: 'emit', round: 1, plan: PLAN });

    await expect(client.complete(scoreRequest(0))).rejects.toBeInstanceOf(HandoffPendingError);
    await expect(client.complete(scoreRequest(1))).rejects.toBeInstanceOf(HandoffPendingError);
    await expect(client.complete(buildUniquenessRequest(PRODUCTS, ORDERING))).rejects.toBeInstanceOf(
      HandoffPendingError,
    );

    expect(client.emitted).toHaveLength(3);
    expect(client.emitted.map((entry) => entry.request_file)).toEqual([
      join(dir, 'round-1', `score-${call('score', 0).key}.request.json`),
      join(dir, 'round-1', `score-${call('score', 1).key}.request.json`),
      join(dir, 'round-1', 'uniqueness-pass.request.json'),
    ]);

    const first = JSON.parse(await readFile(client.emitted[0]?.request_file ?? '', 'utf8')) as HandoffRequestFile;
    expect(first.phase).toBe('score');
    expect(first.juror_role).toBe(JURY.jurors[0]?.role);
    expect(first.chunk_index).toBe(1);
    expect(first.tool_name).toBe(SCORE_TOOL_NAME);
    expect(first.tools[0]?.name).toBe(SCORE_TOOL_NAME);
    expect(first.response_file).toBe(`score-${call('score', 0).key}.response.json`);
    // The prompt is the whole thing a subagent needs: the standing method, the
    // rubric, the products, and this juror's own mandate.
    expect(first.prompt).toContain('## The rubric');
    expect(first.prompt).toContain('## PRODUCTS TO SCORE');
    expect(first.prompt).toContain(`You are ${JURY.jurors[0]?.role}.`);
  });

  it('files each phase under the round it belongs to, whatever round was asked for', async () => {
    const dir = await makeDir();
    const round2 = new HandoffClient({ dir, mode: 'emit', round: 2, plan: PLAN });

    await expect(round2.complete(choiceRequest(0))).rejects.toBeInstanceOf(HandoffPendingError);
    expect(round2.emitted[0]?.request_file).toContain(join('round-2', 'customer-'));

    // A Score call reaching a round-2 pass is deferred, not misfiled: `01 §2`
    // puts Score in round 1 and nothing about the invocation changes that.
    await expect(round2.complete(scoreRequest(0))).rejects.toMatchObject({ reason: 'other_round' });
    expect(round2.deferred).toBe(1);
    expect(round2.emitted).toHaveLength(1);
  });

  it('refuses to overwrite a request that has already been answered', async () => {
    const dir = await makeDir();
    const planned = call('score', 0);
    await emitThenAnswer(dir, scoreRequest(0), planned, scoreAnswer(idsShown(scoreRequest(0)), METRIC_NAMES));

    // The jury is edited — a new mandate — but `prompt_version` is NOT bumped, so
    // no version check anywhere can see it. The request bytes can.
    const editedJuror = { ...JURY.jurors[0], cares_most: 'Something else entirely.' };
    const edited = buildScoreRequest({
      metrics: JURY.metrics,
      products: CHUNK,
      juror: editedJuror as (typeof JURY.jurors)[number],
      ordering: ORDERING,
    });

    const client = new HandoffClient({ dir, mode: 'emit', round: 1, plan: PLAN });
    await expect(client.complete(edited)).rejects.toThrow(/already answers the old one/);
    expect(client.stale).toEqual([callPaths(dir, planned).request]);

    // And the file on disk is untouched, so the answer still matches its question.
    const stored = JSON.parse(await readFile(callPaths(dir, planned).request, 'utf8')) as HandoffRequestFile;
    expect(stored.prompt).toContain(JURY.jurors[0]?.cares_most ?? '');
  });

  it('reports a request that is already answered rather than pretending it is new', async () => {
    const dir = await makeDir();
    const planned = call('score', 0);
    await emitThenAnswer(dir, scoreRequest(0), planned, scoreAnswer(idsShown(scoreRequest(0)), METRIC_NAMES));

    const client = new HandoffClient({ dir, mode: 'emit', round: 1, plan: PLAN });
    await expect(client.complete(scoreRequest(0))).rejects.toBeInstanceOf(HandoffPendingError);
    expect(client.emitted[0]?.answered).toBe(true);
    expect(client.stale).toEqual([]);
  });
});

describe('HandoffClient — ingest', () => {
  it('round-trips a well-formed answer and books it as unmeasured, not free', async () => {
    const dir = await makeDir();
    const planned = call('score', 0);
    const request = scoreRequest(0);
    await emitThenAnswer(dir, request, planned, scoreAnswer(idsShown(request), METRIC_NAMES));

    const client = new HandoffClient({ dir, mode: 'ingest', round: 1, plan: PLAN });
    const response = await client.complete(request);

    expect(client.ingested).toEqual([callPaths(dir, planned).response]);
    // The whole point of the id: it has no entry in `MODEL_PRICES`, so the ledger
    // carries it out in `unpriced_models` and the report prints
    // "UNMEASURED — not $0.00" instead of a confident zero.
    expect(response.model).toBe(MODEL_ID_LOCAL_SUBAGENT);
    expect(response.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect((response.output as { scores: unknown[] }).scores).toHaveLength(PRODUCTS.length);
  });

  it('accepts an envelope that reports its own tokens and model', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    await emitThenAnswer(dir, request, call('score', 0), {
      output: scoreAnswer(idsShown(request), METRIC_NAMES),
      usage: { input_tokens: 1200, output_tokens: 340 },
      model: 'claude-haiku-4-5',
    });

    const response = await ingestOne(dir, request, call('score', 0));
    expect(response).toMatchObject({
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0 },
    });
  });

  it('says which response files are still missing instead of failing on the first one', async () => {
    const dir = await makeDir();
    const emit = new HandoffClient({ dir, mode: 'emit', round: 1, plan: PLAN });
    for (let index = 0; index < 3; index += 1) {
      await expect(emit.complete(scoreRequest(index))).rejects.toBeInstanceOf(HandoffPendingError);
    }
    // Only the middle juror has been answered.
    const request = scoreRequest(1);
    await writeFile(
      callPaths(dir, call('score', 1)).response,
      JSON.stringify(scoreAnswer(idsShown(request), METRIC_NAMES)),
      'utf8',
    );

    const client = new HandoffClient({ dir, mode: 'ingest', round: 1, plan: PLAN });
    const results = await Promise.allSettled([
      client.complete(scoreRequest(0)),
      client.complete(scoreRequest(1)),
      client.complete(scoreRequest(2)),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'rejected']);
    expect(client.missing).toEqual([
      callPaths(dir, call('score', 0)).response,
      callPaths(dir, call('score', 2)).response,
    ]);
    expect(client.ingested).toEqual([callPaths(dir, call('score', 1)).response]);
  });

  it('refuses an answer to a request that has since changed, naming the file', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    await emitThenAnswer(dir, request, call('score', 0), scoreAnswer(idsShown(request), METRIC_NAMES));

    // Same juror, same version — a silently edited rubric. `resumePhase` compares
    // versions and sees nothing; the emitted request bytes do.
    const edited = buildScoreRequest({
      metrics: [{ ...JURY.metrics[0], description: 'Reworded overnight.' } as (typeof JURY.metrics)[number], ...JURY.metrics.slice(1)],
      products: CHUNK,
      juror: JURY.jurors[0] as (typeof JURY.jurors)[number],
      ordering: ORDERING,
    });

    await expect(ingestOne(dir, edited, call('score', 0))).rejects.toThrow(
      /score-.*\.request\.json: the request the engine would send now differs/,
    );
  });

  it('refuses to ingest a round that was never emitted', async () => {
    const dir = await makeDir();
    await expect(ingestOne(dir, scoreRequest(0), call('score', 0))).rejects.toThrow(
      /no .*score-.*\.request\.json\. Emit this round first/,
    );
  });

  it('names the file when the JSON does not parse', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    const paths = await emitThenAnswer(dir, request, call('score', 0), {});
    await writeFile(paths.response, '{ "scores": [', 'utf8');

    await expect(ingestOne(dir, request, call('score', 0))).rejects.toThrow(/response\.json: is not valid JSON/);
  });
});

describe('HandoffClient — a bad answer is a failure, never a warning', () => {
  it('rejects deductions that do not sum to exactly 100 - score', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    const answer = scoreAnswer(idsShown(request), METRIC_NAMES) as {
      scores: { metrics: { score: number; deductions: { points: number; reason: string }[] }[] }[];
    };
    // Off by five: the exact shape of a juror that "rounded".
    const metric = answer.scores[0]?.metrics[0];
    if (metric === undefined) throw new Error('fixture has no metric to break');
    metric.score = 80;
    metric.deductions = [{ points: 15, reason: 'thin evidence' }];

    await emitThenAnswer(dir, request, call('score', 0), answer);
    const error = await ingestOne(dir, request, call('score', 0)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HandoffResponseError);
    expect((error as Error).message).toMatch(/score-.*\.response\.json:/);
    expect((error as Error).message).toMatch(/deductions sum to \d+ but the score is \d+/);
    expect((error as Error).message).toContain('01 §5.1 requires them to sum to exactly');
    // Terminal: the same bytes fail the same way forever, so a retry loop would
    // burn `brief §2.3`'s free retries reproducing it.
    expect((error as HandoffResponseError).retryable).toBe(false);
  });

  it('rejects a product id the juror was never shown', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    const answer = scoreAnswer([...idsShown(request), 99], METRIC_NAMES);

    await emitThenAnswer(dir, request, call('score', 0), answer);
    await expect(ingestOne(dir, request, call('score', 0))).rejects.toThrow(
      /score-.*\.response\.json: .*product id 99 was not in the set this juror was asked to score/s,
    );
  });

  it('rejects a missing required field', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    const answer = scoreAnswer(idsShown(request), METRIC_NAMES) as {
      scores: { metrics: { deductions?: unknown }[] }[];
    };
    delete answer.scores[0]?.metrics[0]?.deductions;

    await emitThenAnswer(dir, request, call('score', 0), answer);
    await expect(ingestOne(dir, request, call('score', 0))).rejects.toThrow(
      /score-.*\.response\.json: .*deductions: expected an array, got undefined/s,
    );
  });

  it('rejects a persona that answers the same set twice', async () => {
    const dir = await makeDir();
    const request = choiceRequest(0);
    const answer = choiceAnswer(request) as { choices: unknown[] };
    const first = answer.choices[0];
    if (first === undefined) throw new Error('fixture produced no choices');
    answer.choices.push(JSON.parse(JSON.stringify(first)) as unknown);

    await emitThenAnswer(dir, request, call('customer', 0), answer);
    await expect(ingestOne(dir, request, call('customer', 0))).rejects.toThrow(
      /customer-.*\.response\.json: .*was answered more than once/s,
    );
  });

  it('rejects a uniqueness answer that contradicts its own clusters', async () => {
    const dir = await makeDir();
    const request = buildUniquenessRequest(PRODUCTS, ORDERING);
    const answer = uniquenessAnswer(idsShown(request), 'pairs') as {
      products: { cluster_id: string }[];
    };
    const row = answer.products[0];
    if (row === undefined) throw new Error('fixture produced no rows');
    row.cluster_id = answer.products[answer.products.length - 1]?.cluster_id ?? 'pair-0';

    await emitThenAnswer(dir, request, call('uniqueness', 0), answer);
    await expect(ingestOne(dir, request, call('uniqueness', 0))).rejects.toThrow(
      /uniqueness-pass\.response\.json: .*but is listed as a member of/s,
    );
  });

  it('rejects usage a responder made up', async () => {
    const dir = await makeDir();
    const request = scoreRequest(0);
    await emitThenAnswer(dir, request, call('score', 0), {
      output: scoreAnswer(idsShown(request), METRIC_NAMES),
      usage: { input_tokens: 'lots' },
    });

    await expect(ingestOne(dir, request, call('score', 0))).rejects.toThrow(
      /usage\.input_tokens must be a non-negative number/,
    );
  });
});

describe('HandoffClient — plumbing', () => {
  it('reads the phase off the forced tool, not off the prompt text', () => {
    expect(phaseForTool(SCORE_TOOL_NAME)).toBe('score');
    expect(phaseForTool(UNIQ_TOOL_NAME)).toBe('uniqueness');
    expect(phaseForTool(CHOICE_TOOL_NAME)).toBe('customer');
    expect(() => phaseForTool('submit_something')).toThrow(/no panel forces the tool/);
  });

  it('ignores the derived prompt when comparing two requests', () => {
    const a = { tool_name: 't', system: [{ type: 'text', text: 'x' }], prompt: 'one' } as unknown as HandoffRequestFile;
    const b = { tool_name: 't', system: [{ type: 'text', text: 'x' }], prompt: 'two' } as unknown as HandoffRequestFile;
    expect(sameRequest(a, b)).toBe(true);
  });

  it('refuses a call the plan does not describe rather than filing it anywhere', async () => {
    const dir = await makeDir();
    const empty: HandoffPlan = { score: [], uniqueness: [], customer: [] };
    const client = new HandoffClient({ dir, mode: 'emit', round: 1, plan: empty });
    await expect(client.complete(scoreRequest(0))).rejects.toThrow(/the plan describes only 0/);
  });

  it('states the provenance caveat in the words the plan requires', () => {
    expect(LOCAL_SEEDING_CAVEAT).toContain('Claude Code subagents');
    expect(LOCAL_SEEDING_CAVEAT).toContain('ABSOLUTE SCORE LEVELS AND PER-RUN COST DO NOT TRANSFER TO PRODUCTION');
    expect(LOCAL_SEEDING_CAVEAT).toContain('re-baselined once a key exists');
  });
});
