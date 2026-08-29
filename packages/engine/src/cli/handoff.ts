/**
 * `engine seed --emit|--ingest --round N` — the keyless seeding path.
 *
 * `docs/plans/phase-1-engine.md` Task 9.2. Four commands seed a category with no
 * API key, in `01 §2`'s dependency order:
 *
 *   seed --emit  --round 1     writes one request file per juror-chunk, plus the clustering pass
 *   seed --ingest --round 1    reads the answers back, validates, persists both phases
 *   seed --emit  --round 2     the clusters are known now, so the sets can be shown to personas
 *   seed --ingest --round 2    reads the answers, persists, ranks, delivers
 *
 * ## One state mechanism, not two
 *
 * Nothing here tracks progress. The orchestrator already persists each phase the
 * moment it lands, in a version-stamped envelope under
 * `cjr/runs/<slug>/phases/<phase>.json`, and already refuses to resume one whose
 * versions moved. Both modes run the real `runCategory` with `resume: true`, so:
 *
 * - an ingested phase is READ BACK on the next invocation and makes no calls, which
 *   is what makes re-running `--ingest` a no-op rather than a re-validation;
 * - a round whose phases are not yet ok simply runs them again, and the client
 *   writes or reads files instead of calling a model;
 * - a bumped `prompt_version` invalidates the stored phase exactly as it would on
 *   the paid path.
 *
 * The handoff files are the request/response transport. The phase files are the
 * state. Adding a second progress file would give a future reader two things to
 * disagree with each other.
 *
 * ## Why the round-1 gate is checked here and not left to the run
 *
 * `--emit --round 2` needs the clusters in order to know which sets exist, and
 * therefore which persona calls the plan contains. Reaching that state by
 * accident — emitting round 2 while round 1 is unanswered — would re-emit round
 * 1's requests and report a confusing failure about a phase the person did not
 * ask about. So round 1's phases are checked up front and the answer is the
 * useful one: which response files are still missing.
 */

import { join } from 'node:path';

import {
  HandoffClient,
  LOCAL_SUBAGENT_SEEDING,
  PHASES_IN_ROUND,
  ROUND_OF_PHASE,
  fileExists,
  roundDir,
  type EmittedRequest,
  type HandoffCall,
  type HandoffPlan,
  type HandoffRound,
} from '../model/handoff-client.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { orderedChunks } from '../panels/ordering.js';
import { setMembership, similarSets } from '../panels/prompts/choice.js';
import { categorySlug } from '../panels/seeded.js';
import { phaseVersions, runCategory } from '../run/run-category.js';
import type { RunStore } from '../run/store.js';
import { FileRunStore } from '../run/store.js';
import type {
  PersistedPhase,
  PhaseName,
  PhaseVersions,
  RunOutcome,
  UniquenessPhaseValue,
} from '../run/types.js';
import type { Jury, PersonaPanel, Product, UniquenessResult } from '../types.js';
import { runDir } from './load.js';

// --- The plan -----------------------------------------------------------------

export interface HandoffPlanInput {
  products: readonly Product[];
  jury: Jury;
  personas: PersonaPanel;
  ordering: PanelOrdering;
  chunkSize?: number;
  /**
   * Round 1's clusters, once they are ingested. Absent before then, in which case
   * the customer leg of the plan is empty — which is correct: until the clusters
   * exist there is no set to put to anybody, and round 2 cannot be emitted.
   */
  uniqueness?: UniquenessResult;
}

/**
 * Every call this run will make, in the order the phases make them.
 *
 * Built from the SAME functions the phases use — `orderedChunks` for the chunk
 * composition, `similarSets`/`setMembership` for the sets — so this is a re-use
 * of the phase's logic, not a second copy of it. The only thing restated is the
 * iteration ORDER (`runScorePhase` is juror-major and chunk-minor; the Customer
 * phase is persona order), and that restatement is verified rather than trusted:
 * on ingest, the request the orchestrator builds must equal the emitted one byte
 * for byte, so a plan out of step with a phase fails loudly instead of filing one
 * juror's answer under another's name.
 */
export function buildHandoffPlan(input: HandoffPlanInput): HandoffPlan {
  const chunks = orderedChunks(input.products, input.ordering, input.chunkSize);
  const metricNames = input.jury.metrics.map((metric) => metric.name);
  const productIds = input.products.map((product) => product.id);

  const score: HandoffCall[] = input.jury.jurors.flatMap((juror, jurorIndex) =>
    chunks.map((chunk, chunkIndex) => ({
      phase: 'score' as const,
      key: `j${jurorIndex + 1}-${nameKey(juror.role)}-chunk-${chunkIndex + 1}`,
      juror_role: juror.role,
      chunk_index: chunkIndex + 1,
      expect: {
        phase: 'score' as const,
        productIds: chunk.map((product) => product.id),
        metricNames,
      },
    })),
  );

  const uniqueness: HandoffCall[] = [
    { phase: 'uniqueness', key: 'pass', expect: { phase: 'uniqueness', productIds } },
  ];

  // `01 §5.3`'s gate, mirrored: no clusters yet, no personas, or no set with two
  // or more members all mean the Floor does not convene and there is nothing to
  // emit. The Customer phase reaches the same conclusion on its own and returns
  // `skipped` (`DECISIONS.md` S11) without ever calling the client.
  const sets = input.uniqueness === undefined ? [] : similarSets(input.uniqueness, input.products);
  const membership = setMembership(sets);
  const customer: HandoffCall[] =
    sets.length === 0
      ? []
      : input.personas.personas.map((persona, index) => ({
          phase: 'customer' as const,
          key: `p${index + 1}-${nameKey(persona.name)}`,
          persona: persona.name,
          expect: { phase: 'customer' as const, sets: membership },
        }));

  return { score, uniqueness, customer };
}

/**
 * A juror role or persona name as a filename fragment.
 *
 * `categorySlug` is the engine's one slug function (`01 §3`: lowercase, collapse
 * non-alphanumerics to single dashes), reused so nothing invents a second
 * spelling. A name that slugifies to nothing still gets a file, because the
 * plan's ordinal prefix — `j3-`, `p2-` — carries the identity on its own.
 */
function nameKey(name: string): string {
  const slug = categorySlug(name);
  return slug === '' ? 'unnamed' : slug;
}

// --- Round state --------------------------------------------------------------

/** What one round looks like on disk right now. */
export interface RoundStatus {
  round: HandoffRound;
  /** Calls planned for this round, in call order. */
  planned: HandoffCall[];
  /** Planned calls with no `.request.json` yet. */
  unemitted: string[];
  /** Planned calls whose `.request.json` exists but `.response.json` does not. */
  missing: string[];
  /** Planned calls with an answer on disk. */
  answered: string[];
}

/** Where one call's two files live. */
export function callPaths(handoffDir: string, call: HandoffCall): { request: string; response: string } {
  const stem = join(handoffDir, roundDir(ROUND_OF_PHASE[call.phase]), `${call.phase}-${call.key}`);
  return { request: `${stem}.request.json`, response: `${stem}.response.json` };
}

/** The calls a round contains, in phase order then call order. */
export function callsInRound(plan: HandoffPlan, round: HandoffRound): HandoffCall[] {
  return PHASES_IN_ROUND[round].flatMap((phase) => [...plan[phase]]);
}

/**
 * Which of a round's files exist. This is what turns "the round is not finished"
 * into "these four files are still missing", which is the only form of that
 * sentence a person can act on.
 */
export async function inspectRound(handoffDir: string, plan: HandoffPlan, round: HandoffRound): Promise<RoundStatus> {
  const planned = callsInRound(plan, round);
  const status: RoundStatus = { round, planned, unemitted: [], missing: [], answered: [] };

  for (const call of planned) {
    const paths = callPaths(handoffDir, call);
    if (!(await fileExists(paths.request))) {
      status.unemitted.push(paths.request);
      continue;
    }
    if (await fileExists(paths.response)) status.answered.push(paths.response);
    else status.missing.push(paths.response);
  }

  return status;
}

// --- The command --------------------------------------------------------------

export interface HandoffCommandInput {
  category: string;
  slug: string;
  workdir: string;
  products: readonly Product[];
  jury: Jury;
  personas: PersonaPanel;
  categoryVersion: string;
  chunkSize?: number;
  mode: 'emit' | 'ingest';
  round: HandoffRound;
  log: (line: string) => void;
  /** Injected by tests; defaults to the real `FileRunStore`. */
  store?: RunStore;
}

/** Run one `--emit` or `--ingest` pass. Returns a process exit code. */
export async function handoffCommand(input: HandoffCommandInput): Promise<number> {
  const store = input.store ?? new FileRunStore(input.category, input.workdir);
  const handoffDir = join(runDir(input.workdir, input.slug), 'handoff');
  const ordering: PanelOrdering = { category: input.category, categoryVersion: input.categoryVersion };
  const versions = phaseVersions({
    config: { categoryVersion: input.categoryVersion },
    jury: input.jury,
    personas: input.personas,
  });

  // Round 2 needs round 1's clusters — to plan the persona calls at all, and
  // because `01 §2` says the Customer phase depends on them. Checked before
  // anything runs, so the message is about round 1 rather than about a round-2
  // pass that failed for a reason two steps away.
  const uniqueness = await readUniqueness(store, versions);
  if (input.round === 2 && uniqueness === undefined) {
    const plan = buildHandoffPlan({
      products: input.products,
      jury: input.jury,
      personas: input.personas,
      ordering,
      ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
    });
    input.log(await formatRoundOneIncomplete(handoffDir, plan, await roundOneReady(store, versions)));
    return 1;
  }

  const plan = buildHandoffPlan({
    products: input.products,
    jury: input.jury,
    personas: input.personas,
    ordering,
    ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
    ...(uniqueness === undefined ? {} : { uniqueness }),
  });

  const client = new HandoffClient({ dir: handoffDir, mode: input.mode, round: input.round, plan });

  const outcome = await runCategory({
    category: input.category,
    products: input.products,
    jury: input.jury,
    personas: input.personas,
    client,
    store,
    config: {
      categoryVersion: input.categoryVersion,
      resume: true,
      seeding: LOCAL_SUBAGENT_SEEDING,
      ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
    },
  });

  return input.mode === 'emit'
    ? emitReport(input, client, plan, handoffDir)
    : await ingestReport(input, client, plan, handoffDir, outcome);
}

/** `--emit`: say exactly what was written and what is now expected back. */
function emitReport(
  input: HandoffCommandInput,
  client: HandoffClient,
  plan: HandoffPlan,
  handoffDir: string,
): number {
  const planned = callsInRound(plan, input.round);
  const lines = [`EMIT ROUND ${input.round} — ${input.category}`, ''];

  if (client.stale.length > 0) {
    lines.push(
      '  REFUSED: the request changed under an answer that is already on disk.',
      '  Answering the old prompt and stamping the run with the new one is what 01 §9 rule 5 forbids.',
      '  Delete each response file below and re-answer it, or restore what changed:',
      ...client.stale.map((path) => `    ! ${path}`),
      '',
    );
    input.log(lines.join('\n'));
    return 1;
  }

  if (client.emitted.length === 0) {
    lines.push(
      ...(planned.length === 0
        ? [
            '  0 requests: this round has nothing to ask. The clustering pass found no similar-app set with',
            '  two or more members, so the Floor does not convene (01 §5.3, DECISIONS.md S11).',
          ]
        : [
            `  0 requests written. This round's phases are already ingested and were read back from`,
            `  ${join(runDir(input.workdir, input.slug), 'phases')}/. Nothing to do.`,
          ]),
      '',
    );
    input.log(lines.join('\n'));
    return 0;
  }

  // Printed in PLAN order, not in the order the writes happened to complete.
  // The list is what a person works through top to bottom, so juror 1 chunk 1
  // has to be the first line every time rather than whichever file the
  // filesystem finished first.
  const byPath = new Map(client.emitted.map((request) => [request.request_file, request]));
  const ordered = planned
    .map((call) => byPath.get(callPaths(handoffDir, call).request))
    .filter((request): request is EmittedRequest => request !== undefined);
  const answered = ordered.filter((request) => request.answered).length;
  lines.push(
    `  ${client.emitted.length} request file(s) written under ${join(handoffDir, roundDir(input.round))}/`,
    answered === 0
      ? '  0 already answered.'
      : `  ${answered} already answered; re-running --ingest over them is a no-op.`,
    '',
  );

  for (const request of ordered) {
    const who =
      request.phase === 'score'
        ? 'juror'
        : request.phase === 'customer'
          ? 'persona'
          : 'clustering pass';
    lines.push(`    ${request.answered ? '[answered]' : '[      ]'} ${request.request_file}   (${who})`);
  }

  lines.push(
    '',
    '  Answer each one by dispatching a subagent with its `prompt` field, then write the tool JSON to the',
    `  sibling <name>.response.json. Then: engine seed --category "…" --ingest --round ${input.round}`,
  );

  input.log(lines.join('\n'));
  return 0;
}

/** `--ingest`: validate, persist, and say what is still outstanding. */
async function ingestReport(
  input: HandoffCommandInput,
  client: HandoffClient,
  plan: HandoffPlan,
  handoffDir: string,
  outcome: RunOutcome,
): Promise<number> {
  const lines = [`INGEST ROUND ${input.round} — ${input.category}`, ''];
  const phases = PHASES_IN_ROUND[input.round];
  const summaries = outcome.results.meta.phases;
  const failed = phases.filter((phase) => summaries[phase].status === 'failed');

  lines.push(`  ${client.ingested.length} response file(s) validated and ingested.`);
  for (const phase of phases) {
    const summary = summaries[phase];
    const status = summary.status === 'skipped' ? `skipped:${summary.skipped ?? ''}` : summary.status;
    lines.push(`    ${phase.padEnd(11)} ${status}`);
  }
  lines.push('');

  if (failed.length === 0) {
    lines.push(
      `  Round ${input.round} is complete. Phase results are persisted under ` +
        `${join(runDir(input.workdir, input.slug), 'phases')}/.`,
    );
    if (input.round === 1) {
      lines.push('', '  Next: engine seed --category "…" --emit --round 2');
    } else if (outcome.status === 'delivered') {
      lines.push(
        '',
        `  RUN DELIVERED — ${outcome.ranking.ranking.length} products ranked; ` +
          `discrimination ${outcome.ranking.health.discrimination.toFixed(4)}.`,
        `  Written to ${runDir(input.workdir, input.slug)}/{results.json,ranking.json}`,
        '',
        '  Next: engine report --category "…"',
      );
    }
    lines.push('', `  ${LOCAL_SEEDING_LINE}`);
    input.log(lines.join('\n'));
    return 0;
  }

  const status = await inspectRound(handoffDir, plan, input.round);
  if (status.unemitted.length > 0) {
    lines.push(
      `  ${status.unemitted.length} request file(s) have not been emitted yet:`,
      ...status.unemitted.slice(0, 20).map((path) => `    ! ${path}`),
      '',
      `  Run: engine seed --category "…" --emit --round ${input.round}`,
    );
    input.log(lines.join('\n'));
    return 1;
  }

  if (status.missing.length > 0) {
    lines.push(
      `  ${status.answered.length}/${status.planned.length} answered. Still waiting on ` +
        `${status.missing.length} response file(s):`,
      ...status.missing.map((path) => `    ! ${path}`),
      '',
      '  Nothing was lost: the answers already on disk are re-read on the next --ingest.',
    );
    input.log(lines.join('\n'));
    return 1;
  }

  // Every file is present, so what failed is a file that is WRONG — or a coverage
  // gap the panel itself produced. Either way the phase failure carries the
  // detail, and every response-level failure names its file.
  lines.push('  Round did not complete. Every planned response file exists, so the problem is in one of them:');
  if (outcome.status === 'failed') {
    for (const failure of outcome.failures) {
      lines.push(`    [${failure.code}] ${failure.message}`, ...failure.causes.map((cause) => `      - ${cause}`));
    }
  }
  lines.push('', `  Partial results written to ${join(runDir(input.workdir, input.slug), 'results.json')}`);
  input.log(lines.join('\n'));
  return 1;
}

/** The one-line reminder printed after every successful ingest. */
const LOCAL_SEEDING_LINE =
  'Locally seeded: answers came from Claude Code subagents, so score LEVELS and per-run COST do not ' +
  'transfer to production. See meta.seeding in results.json.';

/** Round 1's two phases, as stored: ok under the current versions, or not. */
async function roundOneReady(store: RunStore, versions: PhaseVersions): Promise<Record<'score' | 'uniqueness', boolean>> {
  return {
    score: (await readOkPhase(store, 'score', versions)) !== undefined,
    uniqueness: (await readOkPhase(store, 'uniqueness', versions)) !== undefined,
  };
}

/** Round 1's clusters, if the uniqueness phase is stored, ok, and current. */
async function readUniqueness(store: RunStore, versions: PhaseVersions): Promise<UniquenessResult | undefined> {
  const result = await readOkPhase<UniquenessPhaseValue>(store, 'uniqueness', versions);
  return result?.uniqueness;
}

/**
 * A persisted phase's value, but only if it succeeded AND was produced under the
 * versions this invocation is using.
 *
 * The version check is the same one `resumePhase` applies inside the run. It is
 * repeated here rather than exported from there because this is a different
 * question — "can round 2 be planned?" rather than "may this result be reused?"
 * — and the answers must agree: planning round 2 off clusters the run is about
 * to discard would emit persona calls for sets that no longer exist.
 */
async function readOkPhase<T>(store: RunStore, phase: PhaseName, versions: PhaseVersions): Promise<T | undefined> {
  const stored = await store.readPhase(phase);
  if (stored === null || typeof stored !== 'object') return undefined;

  const envelope = stored as Partial<PersistedPhase<T>>;
  const result = envelope.result;
  if (result === undefined || result.status !== 'ok') return undefined;

  const stamped = envelope.versions;
  if (stamped === undefined) return undefined;
  const keys: (keyof PhaseVersions)[] = ['category_version', 'prompt_version', 'persona_version', 'engine_version'];
  if (keys.some((key) => stamped[key] !== versions[key])) return undefined;

  return result.value;
}

/** The message for a round-2 pass attempted before round 1 landed. */
async function formatRoundOneIncomplete(
  handoffDir: string,
  plan: HandoffPlan,
  ready: Record<'score' | 'uniqueness', boolean>,
): Promise<string> {
  const status = await inspectRound(handoffDir, plan, 1);
  const lines = [
    'ROUND 1 IS NOT INGESTED',
    '',
    '  Round 2 (Customer) chooses within the clusters round 1 produces, so it cannot be planned until',
    '  round 1 is ingested (01 §2). Stored round-1 phases under the current versions:',
    `    score        ${ready.score ? 'ok' : 'not ingested'}`,
    `    uniqueness   ${ready.uniqueness ? 'ok' : 'not ingested'}`,
    '',
  ];

  if (status.unemitted.length > 0) {
    lines.push(
      `  ${status.unemitted.length} of ${status.planned.length} round-1 request(s) have not been emitted.`,
      '  Run: engine seed --category "…" --emit --round 1',
      '',
    );
  }

  if (status.missing.length > 0) {
    lines.push(
      `  ${status.answered.length}/${status.planned.length} round-1 request(s) are answered. Still missing:`,
      ...status.missing.map((path) => `    ! ${path}`),
      '',
    );
  }

  lines.push('  Then: engine seed --category "…" --ingest --round 1');
  return lines.join('\n');
}
