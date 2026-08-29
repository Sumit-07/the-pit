import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli/args.js';
import { rankCommand } from '../../src/cli/rank.js';
import { reportCommand } from '../../src/cli/report.js';
import { seedCommand } from '../../src/cli/seed.js';
import type { HandoffRequestFile } from '../../src/model/handoff-client.js';
import type { ModelRequest } from '../../src/model/types.js';
import { CHOICE_TOOL_NAME, SCORE_TOOL_NAME, UNIQ_TOOL_NAME } from '../../src/panels/schemas.js';
import type { RunResults } from '../../src/run/types.js';
import type { Ranking } from '../../src/types.js';
import {
  CATEGORY,
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
 * The `/seed-category` command sequence, driven end to end with a fixture-backed
 * responder standing in for the Claude Code subagents.
 *
 * This is the honest test for a procedural skill: run the procedure. The skill in
 * `.claude/skills/seed-category/SKILL.md` documents these exact six invocations,
 * in this exact order, and if a flag were named differently or a step could not
 * be reached from the one before it, this file would not compile or would not
 * pass. Nothing here mocks the engine: `seedCommand` builds the real prompts
 * through the real orchestrator, the responder reads the emitted request files
 * back off disk and answers what they actually asked for, and the answers go
 * through the real schema validators, the real ranking arithmetic and the real
 * report.
 *
 * No network, no API key, no `ModelClient` construction (Global Constraint 5).
 */

const SLUG = 'health-fitness-wellness';
const PRODUCT_COUNT = 10;

interface Capture {
  log: (line: string) => void;
  text: () => string;
}

function capture(): Capture {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), text: () => lines.join('\n') };
}

/** A workdir laid out as `01 §3` describes, with both approval gates already installed. */
async function makeWorkdir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'the-pit-seed-'));
  await mkdir(join(root, 'runs', SLUG), { recursive: true });
  await mkdir(join(root, 'references', 'jurors'), { recursive: true });
  await mkdir(join(root, 'references', 'personas'), { recursive: true });

  await writeFile(
    join(root, 'runs', SLUG, 'products.json'),
    JSON.stringify({ category: CATEGORY, products: makeProducts(PRODUCT_COUNT) }),
  );
  await writeFile(join(root, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(JURY));
  await writeFile(join(root, 'references', 'personas', `${SLUG}.json`), JSON.stringify(PANEL));
  return root;
}

/** A `seed` invocation, exactly as the skill writes it. */
async function seed(root: string, flags: string[], log: (line: string) => void): Promise<number> {
  return await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', root, ...flags]), {
    log,
    // The keyless path must never construct a client. If it tries, the test fails
    // here rather than by hitting the network.
    makeClient: () => {
      throw new Error('seed --emit/--ingest must not construct an API client');
    },
  });
}

function roundPath(root: string, round: 1 | 2): string {
  return join(root, 'runs', SLUG, 'handoff', `round-${round}`);
}

/** The request files of one round, sorted, as a person listing the directory would see them. */
async function requestFiles(root: string, round: 1 | 2): Promise<string[]> {
  const dir = roundPath(root, round);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith('.request.json')).sort();
}

/**
 * The subagent, in fixture form: it reads a request file and answers exactly what
 * that file asked for, the way `test/helpers/run-fixtures.ts` answers the
 * `FixtureClient`.
 */
function answerFor(payload: HandoffRequestFile): unknown {
  const asRequest = { system: payload.system, messages: payload.messages } as unknown as ModelRequest;
  switch (payload.tool_name) {
    case SCORE_TOOL_NAME:
      return scoreAnswer(idsShown(asRequest), METRIC_NAMES);
    case UNIQ_TOOL_NAME:
      return uniquenessAnswer(idsShown(asRequest), 'pairs');
    case CHOICE_TOOL_NAME:
      return choiceAnswer(asRequest);
    default:
      throw new Error(`no fixture answer for tool ${payload.tool_name}`);
  }
}

/** Answer every emitted request of a round, optionally leaving `skip` of them unanswered. */
async function answerRound(root: string, round: 1 | 2, skip = 0): Promise<string[]> {
  const files = await requestFiles(root, round);
  const answered: string[] = [];

  for (const name of files.slice(0, files.length - skip)) {
    const path = join(roundPath(root, round), name);
    const payload = JSON.parse(await readFile(path, 'utf8')) as HandoffRequestFile;
    const out = join(roundPath(root, round), payload.response_file);
    await writeFile(out, `${JSON.stringify(answerFor(payload), null, 2)}\n`, 'utf8');
    answered.push(out);
  }

  return answered;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('seed --emit / --ingest — the whole keyless sequence', () => {
  it('runs emit 1, ingest 1, emit 2, ingest 2, rank and report end to end', async () => {
    const root = await makeWorkdir();

    // --- Round 1: emit ------------------------------------------------------
    const emit1 = capture();
    expect(await seed(root, ['--emit', '--round', '1'], emit1.log)).toBe(0);

    const round1 = await requestFiles(root, 1);
    // `01 §7.3` with `DECISIONS.md` S1's six jurors: JUROR_COUNT x chunks + 1.
    expect(round1).toHaveLength(JURY.jurors.length * 1 + 1);
    expect(round1.filter((name) => name.startsWith('score-'))).toHaveLength(JURY.jurors.length);
    expect(round1).toContain('uniqueness-pass.request.json');
    expect(emit1.text()).toContain(`${round1.length} request file(s) written`);
    expect(emit1.text()).toContain('--ingest --round 1');

    // --- Round 1: ingest ----------------------------------------------------
    await answerRound(root, 1);
    const ingest1 = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], ingest1.log)).toBe(0);
    expect(ingest1.text()).toContain(`${round1.length} response file(s) validated and ingested`);
    expect(ingest1.text()).toContain('Round 1 is complete');
    expect(ingest1.text()).toContain('--emit --round 2');

    // --- Round 2: emit ------------------------------------------------------
    const emit2 = capture();
    expect(await seed(root, ['--emit', '--round', '2'], emit2.log)).toBe(0);
    const round2 = await requestFiles(root, 2);
    expect(round2).toHaveLength(PANEL.personas.length);
    expect(round2.every((name) => name.startsWith('customer-'))).toBe(true);

    // --- Round 2: ingest ----------------------------------------------------
    await answerRound(root, 2);
    const ingest2 = capture();
    expect(await seed(root, ['--ingest', '--round', '2'], ingest2.log)).toBe(0);
    expect(ingest2.text()).toContain('RUN DELIVERED');

    const results = await readJson<RunResults>(join(root, 'runs', SLUG, 'results.json'));
    expect(results.meta.outcome).toBe('delivered');
    expect(results.scoreLog).toHaveLength(JURY.jurors.length);
    expect(results.demand?.demandLog).toHaveLength(PANEL.personas.length);

    // Part C: the provenance caveat is stamped into the run, not left in a
    // document beside it, and it leads the warnings so a skimmer reads it first.
    expect(results.meta.seeding?.path).toBe('local_subagent');
    expect(results.meta.warnings[0]).toContain('ABSOLUTE SCORE LEVELS AND PER-RUN COST DO NOT TRANSFER');
    // And the cost is unmeasurable rather than free: every call was booked
    // against an id with no price, so the ledger says so out loud.
    expect(results.meta.ledger.total.calls).toBe(round1.length + round2.length);
    expect(results.meta.ledger.total.cost_usd).toBe(0);
    expect(results.meta.ledger.total.unpriced_models).toEqual(['local-claude-code-subagent']);
    // And no cold-cache alarm: there is no prompt cache on this path, so a
    // warning about one would be noise standing where a real cost regression
    // needs to be noticed.
    expect(results.meta.warnings.some((line) => line.includes('prompt cache never hit'))).toBe(false);

    // --- rank ---------------------------------------------------------------
    const ranked = capture();
    expect(await rankCommand(parseArgs(['rank', '--category', CATEGORY, '--workdir', root]), { log: ranked.log })).toBe(
      0,
    );
    expect(ranked.text()).toContain(`${PRODUCT_COUNT} products`);
    const ranking = await readJson<Ranking>(join(root, 'runs', SLUG, 'ranking.json'));
    expect(ranking.ranking).toHaveLength(PRODUCT_COUNT);

    // --- report -------------------------------------------------------------
    const reported = capture();
    const written = new Map<string, string>();
    const code = await reportCommand(parseArgs(['report', '--category', CATEGORY, '--workdir', root]), {
      log: reported.log,
      write: async (path, contents) => {
        written.set(path, contents);
        return await Promise.resolve();
      },
    });
    // Exit 1 because the fix-1.1 A/B has not been produced for this run — the
    // gate is MISSING, which the report is supposed to say rather than hide.
    expect(code).toBe(1);

    const markdown = [...written.values()].join('\n');
    expect(markdown).toContain('UNMEASURED — not $0.00');
    expect(markdown).toContain('ABSOLUTE SCORE LEVELS AND PER-RUN COST DO NOT TRANSFER');
  });

  it('is idempotent: re-emitting and re-ingesting a finished round changes nothing', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);
    await seed(root, ['--ingest', '--round', '1'], quiet.log);

    const before = await readJson<unknown>(join(root, 'runs', SLUG, 'phases', 'score.json'));

    const again = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], again.log)).toBe(0);
    // Nothing was re-read, because the phase came back off disk: one state
    // mechanism, and it is the orchestrator's.
    expect(again.text()).toContain('0 response file(s) validated');
    expect(again.text()).toContain('Round 1 is complete');

    const reEmit = capture();
    expect(await seed(root, ['--emit', '--round', '1'], reEmit.log)).toBe(0);
    expect(reEmit.text()).toContain('0 requests written');

    expect(await readJson<unknown>(join(root, 'runs', SLUG, 'phases', 'score.json'))).toEqual(before);
  });

  it('names the response files a partially-answered round is still waiting for', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1, 2);

    const partial = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], partial.log)).toBe(1);
    expect(partial.text()).toMatch(/Still waiting on 2 response file\(s\)/);
    expect(partial.text()).toContain('.response.json');
    // Not a data-loss event: what is answered stays answered.
    expect(partial.text()).toContain('re-read on the next --ingest');

    // Finish it and the same command succeeds, with nothing re-answered.
    await answerRound(root, 1);
    const finished = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], finished.log)).toBe(0);
    expect(finished.text()).toContain('Round 1 is complete');
  });

  it('refuses round 2 before round 1 is ingested, and says which files are outstanding', async () => {
    const root = await makeWorkdir();
    const quiet = capture();

    // Nothing emitted at all.
    const cold = capture();
    expect(await seed(root, ['--emit', '--round', '2'], cold.log)).toBe(1);
    expect(cold.text()).toContain('ROUND 1 IS NOT INGESTED');
    expect(cold.text()).toContain('--emit --round 1');
    expect(await requestFiles(root, 2)).toEqual([]);

    // Emitted and half answered: now the message is about the specific files.
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1, 3);
    const warm = capture();
    expect(await seed(root, ['--ingest', '--round', '2'], warm.log)).toBe(1);
    expect(warm.text()).toContain('ROUND 1 IS NOT INGESTED');
    expect(warm.text()).toMatch(/round-1 request\(s\) are answered\. Still missing:/);
  });

  it('refuses an answer whose deduction ledger does not add up, naming the file', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);

    // One juror "rounds" one metric. It is the whole panel's problem: the
    // deduction ledger is what makes a scorecard auditable (`01 §5.1`).
    const victim = (await requestFiles(root, 1)).find((name) => name.startsWith('score-'));
    if (victim === undefined) throw new Error('no score request was emitted');
    const responsePath = join(roundPath(root, 1), victim.replace('.request.json', '.response.json'));
    const answer = await readJson<{ scores: { metrics: { score: number; deductions: unknown[] }[] }[] }>(responsePath);
    const metric = answer.scores[0]?.metrics[0];
    if (metric === undefined) throw new Error('fixture answer has no metric');
    metric.score = 70;
    metric.deductions = [{ points: 10, reason: 'thin evidence' }];
    await writeFile(responsePath, JSON.stringify(answer), 'utf8');

    const broken = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], broken.log)).toBe(1);
    expect(broken.text()).toContain(responsePath);
    expect(broken.text()).toContain('deductions sum to 10 but the score is 70');
  });

  it('refuses to re-emit a request over an answer to the old one', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);

    // Edited mandate, same prompt_version: the request would change while an
    // answer to the old one sits beside it. Overwriting would make the stale
    // answer look current, so the emit refuses instead.
    const edited = {
      ...JURY,
      jurors: [{ ...JURY.jurors[0], cares_most: 'Something else entirely.' }, ...JURY.jurors.slice(1)],
    };
    await writeFile(join(root, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(edited));

    const refused = capture();
    expect(await seed(root, ['--emit', '--round', '1'], refused.log)).toBe(1);
    expect(refused.text()).toContain('REFUSED');
    expect(refused.text()).toContain('01 §9 rule 5');
  });

  it('refuses an answer to a prompt that has changed under it', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);

    // The rubric is reworded and `prompt_version` is left alone — the mistake no
    // version check can see, because the versions are identical.
    const edited = {
      ...JURY,
      metrics: [{ ...JURY.metrics[0], description: 'Reworded after the requests went out.' }, ...JURY.metrics.slice(1)],
    };
    await writeFile(join(root, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(edited));

    const stale = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], stale.log)).toBe(1);
    expect(stale.text()).toContain('the request the engine would send now differs from the one that was emitted');
  });

  it('rejects --round on the paid modes and requires it on the keyless ones', async () => {
    const root = await makeWorkdir();
    const quiet = capture();

    await expect(seed(root, ['--dry-run', '--round', '1'], quiet.log)).rejects.toThrow(
      /--round applies only to --emit and --ingest/,
    );
    await expect(seed(root, ['--emit'], quiet.log)).rejects.toThrow(/--round must be 1 .* or 2/);
    await expect(seed(root, ['--emit', '--round', '3'], quiet.log)).rejects.toThrow(/--round must be 1/);
    await expect(seed(root, ['--emit', '--ingest', '--round', '1'], quiet.log)).rejects.toThrow(
      /exactly one of --dry-run, --run, --emit or --ingest/,
    );
  });

  it('chunks the same way on both passes, and says so when it would not have', async () => {
    const root = await makeWorkdir();
    const quiet = capture();

    // Four products per call over ten products: three chunks, six jurors.
    expect(await seed(root, ['--emit', '--round', '1', '--chunk-size', '4'], quiet.log)).toBe(0);
    const files = await requestFiles(root, 1);
    expect(files.filter((name) => name.startsWith('score-'))).toHaveLength(JURY.jurors.length * 3);
    expect(files).toContain(
      `score-j1-${JURY.jurors[0]?.role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-chunk-3.request.json`,
    );

    await answerRound(root, 1);
    // Ingesting with a different chunk size would file answers against a chunk
    // composition that never produced them. The request bytes disagree, loudly.
    const wrong = capture();
    expect(await seed(root, ['--ingest', '--round', '1'], wrong.log)).toBe(1);
    expect(wrong.text()).toContain('the request the engine would send now differs');

    const right = capture();
    expect(await seed(root, ['--ingest', '--round', '1', '--chunk-size', '4'], right.log)).toBe(0);
    expect(right.text()).toContain('Round 1 is complete');
  });

  it('leaves a delivered run delivered when an earlier round is re-emitted', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);
    await seed(root, ['--ingest', '--round', '1'], quiet.log);
    await seed(root, ['--emit', '--round', '2'], quiet.log);
    await answerRound(root, 2);
    await seed(root, ['--ingest', '--round', '2'], quiet.log);

    const again = capture();
    expect(await seed(root, ['--emit', '--round', '1'], again.log)).toBe(0);

    const results = await readJson<RunResults>(join(root, 'runs', SLUG, 'results.json'));
    expect(results.meta.outcome).toBe('delivered');
  });

  it('refuses to rank a run that has not finished', async () => {
    const root = await makeWorkdir();
    const quiet = capture();
    await seed(root, ['--emit', '--round', '1'], quiet.log);
    await answerRound(root, 1);
    await seed(root, ['--ingest', '--round', '1'], quiet.log);

    await expect(
      rankCommand(parseArgs(['rank', '--category', CATEGORY, '--workdir', root]), { log: quiet.log }),
    ).rejects.toThrow(/records outcome "failed"/);

    await rm(join(root, 'runs', SLUG, 'results.json'));
    await expect(
      rankCommand(parseArgs(['rank', '--category', CATEGORY, '--workdir', root]), { log: quiet.log }),
    ).rejects.toThrow(/no .*results\.json/);
  });
});
