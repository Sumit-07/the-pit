/**
 * `HandoffClient` — the third `ModelClient`, for running the whole pipeline with
 * **no Anthropic API key**. `docs/plans/phase-1-engine.md` Task 9.
 *
 * This is not a workaround. `01 §1` and `01 §9` rule 1 describe exactly this
 * shape: "no Anthropic API key, no deployment, no auth, no payments — jurors and
 * personas are **local** subagents", with the Workflow return value hand-written
 * to `cjr/runs/<slug>/results.json` (`01 §4` Step 5). What this adapter adds is
 * repeatability: instead of a person transcribing a panel's answer into one
 * hand-built JSON document, every would-be request is serialized to a file, a
 * local Claude Code subagent answers each one into a sibling file, and the
 * answers are read back through the SAME orchestrator, the SAME schemas and the
 * SAME ranking arithmetic a keyed run would use.
 *
 * ## Why files, and why rounds
 *
 * A Node process cannot dispatch a Claude Code subagent — the Agent tool belongs
 * to the harness driving the process, not to the process. So the handoff is a
 * file exchange, and it has to respect `01 §2`'s phase graph, because a request
 * that does not exist yet cannot be written down:
 *
 *   round 1   Score || Uniqueness    both read only the products
 *   round 2   Customer               needs round 1's clusters
 *
 * The round is a property of the PHASE (`ROUND_OF_PHASE`), not of the invocation,
 * so a request always lands in the directory its phase belongs to and a round-2
 * emit cannot scatter round-1 files.
 *
 * ## Emit and ingest are the same code path
 *
 * Both modes run the real `runCategory`. Emit answers nothing — every call
 * writes its request and then throws `HandoffPendingError`, so the phase fails
 * and the CLI reports what it wrote. Ingest answers from `.response.json` files.
 * That symmetry is the point: the request a subagent is shown is byte-identical
 * to the request the ingest pass validates against, because the same prompt
 * builders produced both. Nothing here re-renders a prompt.
 *
 * ## Two guards worth their weight
 *
 * 1. **Request integrity.** Ingest compares the request the orchestrator just
 *    built against the one on disk and refuses a mismatch by name. This is what
 *    catches the mistake `01 §9` rule 5 exists for and that no version check can
 *    see: editing an installed jury WITHOUT bumping `prompt_version`. The
 *    resume check compares versions, and identical versions look fine to it; the
 *    mandate text does not.
 * 2. **Per-file validation.** A response is validated against its phase's
 *    schema (`SCORE_SCHEMA` / `UNIQ_SCHEMA` / `CHOICE_SCHEMA`) and against what
 *    that specific call actually asked for, and a violation names THE FILE and
 *    the constraint. A juror whose deductions do not sum to exactly `100 - score`
 *    is a hard failure, never a warning: the deduction ledger is what makes a
 *    scorecard auditable (`01 §5.1`), and one file quietly papered over would
 *    put an unaudited number into the same population a paying customer is
 *    placed against.
 *
 * ## Cost
 *
 * A local subagent cannot report a priced model id, so every answer is booked
 * against `MODEL_ID_LOCAL_SUBAGENT`, which is deliberately absent from
 * `MODEL_PRICES`. The ledger therefore records the calls, books $0, and carries
 * the id out in `PhaseCost.unpriced_models`; `costBasis` turns that into
 * `unmeasured` and the report prints "UNMEASURED — not $0.00". A response file
 * MAY carry its own `usage` and `model`, and if it names a priced id the ledger
 * prices it — but nothing here ever invents one.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';

import { MODEL_ID_LOCAL_SUBAGENT } from '../config/constants.js';
import {
  CHOICE_TOOL_NAME,
  SCORE_TOOL_NAME,
  SchemaValidationError,
  UNIQ_TOOL_NAME,
  validateChoiceResult,
  validateScoreResult,
  validateUniquenessResult,
} from '../panels/schemas.js';
import type { ClusterId } from '../types.js';
// Type-only, and therefore erased: `PhaseName` and `RunSeeding` are the
// orchestrator's vocabulary and re-declaring them here would create a second
// spelling of the same three phases to keep in agreement.
import type { PhaseName, RunSeeding } from '../run/types.js';
import { ZERO_USAGE } from './fixture-client.js';
import { ModelCallError, type Effort, type ModelClient, type ModelRequest, type ModelResponse, type ModelTier, type TokenUsage } from './types.js';

/** `01 §2`'s phase graph as rounds. Round 1 needs only products; round 2 needs clusters. */
export type HandoffRound = 1 | 2;

/** Which round each phase belongs to. The single source of that mapping. */
export const ROUND_OF_PHASE: Readonly<Record<PhaseName, HandoffRound>> = Object.freeze({
  score: 1,
  uniqueness: 1,
  customer: 2,
});

/** The phases of one round, in the orchestrator's own order. */
export const PHASES_IN_ROUND: Readonly<Record<HandoffRound, readonly PhaseName[]>> = Object.freeze({
  1: Object.freeze(['score', 'uniqueness'] as const),
  2: Object.freeze(['customer'] as const),
});

/**
 * The model-provenance caveat, stamped into `results.json.meta.seeding` and
 * repeated in `meta.warnings` so it travels with the run into the report.
 *
 * Verbatim from `docs/plans/phase-1-engine.md` Task 9.3.
 */
export const LOCAL_SEEDING_CAVEAT =
  'Locally-seeded scores come from Claude Code subagents, not from the claude-haiku-4-5 / ' +
  'claude-sonnet-5 Messages API calls production will make, and the local path exposes no effort ' +
  'control. The pipeline, the fix-1.1 A/B, cluster behaviour, discrimination and juror-correlation ' +
  'results are all valid. ABSOLUTE SCORE LEVELS AND PER-RUN COST DO NOT TRANSFER TO PRODUCTION and ' +
  'must be re-baselined once a key exists.';

/** What `runCategory` stamps into `meta.seeding` for a locally-seeded run. */
export const LOCAL_SUBAGENT_SEEDING: Readonly<RunSeeding> = Object.freeze({
  path: 'local_subagent',
  caveat: LOCAL_SEEDING_CAVEAT,
});

/** The directory one round's files live in, under `<run>/handoff/`. */
export function roundDir(round: HandoffRound): string {
  return `round-${round}`;
}

// --- The plan -----------------------------------------------------------------

/**
 * What one call is entitled to be answered with — the same expectation the phase
 * hands its own validator, so a response that passes here passes there.
 */
export type HandoffExpectation =
  | { phase: 'score'; productIds: readonly number[]; metricNames: readonly string[] }
  | { phase: 'uniqueness'; productIds: readonly number[] }
  | { phase: 'customer'; sets: ReadonlyMap<ClusterId, readonly number[]> };

/**
 * One planned call: which phase it belongs to, what to name its files, and who
 * or what it is for.
 *
 * `key` is what makes a filename readable by the person dispatching it —
 * `score-j3-the-skeptical-sre-chunk-2` rather than a hash — and it carries the
 * juror index so two jurors whose roles slugify identically cannot collide.
 */
export interface HandoffCall {
  phase: PhaseName;
  key: string;
  juror_role?: string;
  persona?: string;
  /** 1-based, as printed. Only on Score calls. */
  chunk_index?: number;
  expect: HandoffExpectation;
}

/**
 * Every call the run will make, per phase, IN THE ORDER THE PHASES MAKE THEM.
 *
 * Score is juror-major and chunk-minor (`runScorePhase`'s flat fan-out); Customer
 * is persona order. That ordering is how a request is matched to its descriptor,
 * and it is verified rather than trusted: on ingest the request the orchestrator
 * built must equal the one on disk byte for byte, so a plan that drifted out of
 * step with the phase fails loudly instead of attributing one juror's answer to
 * another.
 */
export interface HandoffPlan {
  score: readonly HandoffCall[];
  uniqueness: readonly HandoffCall[];
  customer: readonly HandoffCall[];
}

// --- The files ----------------------------------------------------------------

/** Format version of the emitted request document. */
export const HANDOFF_FILE_VERSION = 1;

/**
 * `<phase>-<key>.request.json` — everything needed to answer one call by hand.
 *
 * `prompt` is the concatenation of the system blocks and the user turn, provided
 * so a subagent can be dispatched with a copy of it and nothing has to
 * re-assemble the prompt correctly. It is DERIVED and is excluded from the
 * integrity comparison, which reads only the fields a model would actually be
 * sent.
 */
export interface HandoffRequestFile {
  handoff_version: number;
  round: HandoffRound;
  phase: PhaseName;
  key: string;
  juror_role?: string;
  persona?: string;
  chunk_index?: number;
  /** The file the answer goes in, as a basename beside this one. */
  response_file: string;
  /** What the answer must satisfy, in one line, for whoever writes it. */
  answer_with: string;
  model_tier: ModelTier;
  max_tokens: number;
  effort?: Effort;
  tool_name: string;
  tools: readonly Anthropic.Tool[];
  system: readonly Anthropic.TextBlockParam[];
  messages: readonly Anthropic.MessageParam[];
  /** Derived: `system` blocks then the user turn, joined. Not compared. */
  prompt: string;
}

/**
 * `<phase>-<key>.response.json` — what a subagent wrote back.
 *
 * Two accepted shapes, because the simple one is the one a person gets right:
 * the bare tool input (`{"scores": […]}`), or an envelope
 * (`{"output": {...}, "usage": {...}, "model": "…"}`) for a responder that can
 * report tokens. The envelope is recognised by an `output` object, which no
 * panel schema has at its root.
 */
export interface HandoffResponseFile {
  output: unknown;
  usage?: Partial<TokenUsage>;
  model?: string;
}

// --- Errors -------------------------------------------------------------------

/** Why a call could not be answered from disk. Every reason is a normal state of a round in progress. */
export type HandoffPendingReason =
  /** The request was just written; nobody has answered it yet. */
  | 'emitted'
  /** The request is on disk and the response file is not there yet. */
  | 'awaiting_response'
  /** This phase belongs to the other round, so it is not this invocation's business. */
  | 'other_round'
  /** Ingest found no request file — the round was never emitted. */
  | 'not_emitted'
  /** The request changed while an answer to the old one is still on disk. */
  | 'stale_request';

/**
 * A call that cannot be answered YET.
 *
 * A `ModelCallError` subclass so `dispatch` classifies it as an ordinary
 * retryable `model_call` failure rather than as `internal`, which is reserved for
 * engine bugs. The phase fails, the CLI reads the client's own log to say what is
 * still outstanding, and re-running after the files are written succeeds — which
 * is exactly what "retryable" means here.
 */
export class HandoffPendingError extends ModelCallError {
  readonly reason: HandoffPendingReason;
  readonly file: string | undefined;

  constructor(reason: HandoffPendingReason, message: string, file?: string) {
    super(message, { retryable: true });
    this.reason = reason;
    this.file = file;
  }
}

/**
 * A response file that exists and is wrong.
 *
 * Terminal, not retryable: the file on disk will fail identically on every
 * re-ingest, so a retry loop would spend attempts reproducing it. The message
 * always begins with the path, because the person reading it has to open exactly
 * one file out of sixty.
 */
export class HandoffResponseError extends ModelCallError {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`, { retryable: false });
    this.file = file;
  }
}

// --- The adapter --------------------------------------------------------------

export interface HandoffClientOptions {
  /** The run's handoff root, i.e. `<workdir>/runs/<slug>/handoff`. */
  dir: string;
  mode: 'emit' | 'ingest';
  round: HandoffRound;
  plan: HandoffPlan;
  /** Overridden only by a responder that knows which model answered. */
  modelId?: string;
}

/** One emitted request, as the CLI reports it. */
export interface EmittedRequest {
  phase: PhaseName;
  key: string;
  request_file: string;
  response_file: string;
  /** True when an answer to this exact request is already on disk. */
  answered: boolean;
}

export class HandoffClient implements ModelClient {
  readonly dir: string;
  readonly mode: 'emit' | 'ingest';
  readonly round: HandoffRound;

  private readonly plan: HandoffPlan;
  private readonly modelId: string;
  private readonly cursor: Record<PhaseName, number> = { score: 0, uniqueness: 0, customer: 0 };

  /** Requests written (or found already written) by an `--emit` pass, in call order. */
  readonly emitted: EmittedRequest[] = [];
  /** Response files read and validated by an `--ingest` pass. */
  readonly ingested: string[] = [];
  /** Response files this round is still waiting for. */
  readonly missing: string[] = [];
  /** Requests that changed under an existing answer. Never overwritten; always reported. */
  readonly stale: string[] = [];
  /** Calls skipped because their phase belongs to the other round. */
  deferred = 0;

  constructor(options: HandoffClientOptions) {
    this.dir = options.dir;
    this.mode = options.mode;
    this.round = options.round;
    this.plan = options.plan;
    this.modelId = options.modelId ?? MODEL_ID_LOCAL_SUBAGENT;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Everything up to the first `await` runs synchronously inside the phase's
    // fan-out, which is what keeps the cursor in the phase's own call order.
    const phase = phaseForTool(request.toolName);

    if (ROUND_OF_PHASE[phase] !== this.round) {
      this.deferred += 1;
      throw new HandoffPendingError(
        'other_round',
        `handoff: the ${phase} phase belongs to round ${ROUND_OF_PHASE[phase]}, and this is round ${this.round}. ` +
          'Finish this round first (01 §2: Customer needs Round 1’s clusters).',
      );
    }

    const index = this.cursor[phase];
    this.cursor[phase] = index + 1;
    const call = this.plan[phase][index];
    if (call === undefined) {
      throw new ModelCallError(
        `handoff: the ${phase} phase made call ${index + 1}, but the plan describes only ` +
          `${this.plan[phase].length}. The plan and the phase disagree about how many calls this run makes; ` +
          'nothing was written, because an unplanned call cannot be named or validated.',
        { retryable: false },
      );
    }

    const stem = join(this.dir, roundDir(ROUND_OF_PHASE[phase]), `${phase}-${call.key}`);
    const requestPath = `${stem}.request.json`;
    const responsePath = `${stem}.response.json`;
    const payload = buildRequestFile(call, request, `${phase}-${call.key}.response.json`);

    return this.mode === 'emit'
      ? await this.emit(call, payload, requestPath, responsePath)
      : await this.ingest(call, payload, requestPath, responsePath);
  }

  /** Write one request and stop. Emit answers nothing, by construction. */
  private async emit(
    call: HandoffCall,
    payload: HandoffRequestFile,
    requestPath: string,
    responsePath: string,
  ): Promise<never> {
    const existing = await readJsonFile(requestPath);
    // Existence only, never parsed: an unparseable answer is the INGEST pass's
    // business, and failing an emit over it would stop a person from regenerating
    // the very request they need in order to answer it again.
    const answered = await fileExists(responsePath);

    if (existing !== undefined && answered && !sameRequest(existing as Partial<HandoffRequestFile>, payload)) {
      // Refusing to overwrite is the whole guard. Overwriting would make the
      // stored answer look like an answer to the new prompt, and the ingest
      // integrity check — which compares against this very file — would then
      // pass. See `01 §9` rule 5.
      this.stale.push(requestPath);
      throw new HandoffPendingError(
        'stale_request',
        `handoff: ${requestPath} would change, but ${responsePath} already answers the old one. ` +
          'The installed jury, panel or product set moved under an answered request. Delete the response ' +
          'file and re-answer it, or restore what changed (01 §9 rule 5).',
        requestPath,
      );
    }

    await mkdir(dirname(requestPath), { recursive: true });
    await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    this.emitted.push({
      phase: call.phase,
      key: call.key,
      request_file: requestPath,
      response_file: responsePath,
      answered,
    });

    throw new HandoffPendingError(
      'emitted',
      `handoff: wrote ${requestPath}; awaiting ${responsePath}`,
      responsePath,
    );
  }

  /** Read one answer back, checking the request it answers and the answer itself. */
  private async ingest(
    call: HandoffCall,
    payload: HandoffRequestFile,
    requestPath: string,
    responsePath: string,
  ): Promise<ModelResponse> {
    const emittedRequest = await readJsonFile(requestPath);
    if (emittedRequest === undefined) {
      throw new HandoffPendingError(
        'not_emitted',
        `handoff: no ${requestPath}. Emit this round first: engine seed --category "…" --emit --round ${this.round}.`,
        requestPath,
      );
    }

    if (!sameRequest(emittedRequest as Partial<HandoffRequestFile>, payload)) {
      throw new HandoffResponseError(
        requestPath,
        'the request the engine would send now differs from the one that was emitted. Something that ' +
          'shapes the prompt changed — an edited juror mandate, an edited rubric, a different product ' +
          'set or chunk size — without the emitted files being regenerated. Answering the old prompt ' +
          'and stamping the run with the new version is what 01 §9 rule 5 forbids. Re-emit this round ' +
          'and re-answer it.',
      );
    }

    const raw = await readJsonFile(responsePath);
    if (raw === undefined) {
      this.missing.push(responsePath);
      throw new HandoffPendingError('awaiting_response', `handoff: no answer yet at ${responsePath}`, responsePath);
    }

    const answer = unwrapResponse(raw, responsePath);
    validateAgainst(call.expect, answer.output, responsePath);
    this.ingested.push(responsePath);

    return {
      output: answer.output,
      usage: { ...ZERO_USAGE, ...answer.usage },
      model: answer.model ?? this.modelId,
    };
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Which phase a request belongs to, read off the tool it forces.
 *
 * Structural, not textual: the forced tool name IS the panel's identity
 * (`01 §5`), so this cannot be fooled by prompt wording changing.
 */
export function phaseForTool(toolName: string): PhaseName {
  switch (toolName) {
    case SCORE_TOOL_NAME:
      return 'score';
    case UNIQ_TOOL_NAME:
      return 'uniqueness';
    case CHOICE_TOOL_NAME:
      return 'customer';
    default:
      throw new ModelCallError(
        `handoff: no panel forces the tool ${JSON.stringify(toolName)}, so there is no phase to file it under`,
        { retryable: false },
      );
  }
}

/** The one-line answer contract printed into every request file. */
function answerContract(phase: PhaseName): string {
  switch (phase) {
    case 'score':
      return 'JSON matching tools[0].input_schema. Every product in PRODUCTS TO SCORE exactly once, every rubric metric for each, and each metric’s deductions summing to exactly (100 - score).';
    case 'uniqueness':
      return 'JSON matching tools[0].input_schema. Every product in exactly one cluster, one scarcity row per product, and every products[].cluster_id declared in clusters[].';
    case 'customer':
      return 'JSON matching tools[0].input_schema. One choice per set shown, each set answered exactly once, picks drawn only from that set’s members.';
  }
}

/** Assemble the request document. Pure — no I/O, so it is testable on its own. */
export function buildRequestFile(call: HandoffCall, request: ModelRequest, responseFile: string): HandoffRequestFile {
  const file: HandoffRequestFile = {
    handoff_version: HANDOFF_FILE_VERSION,
    round: ROUND_OF_PHASE[call.phase],
    phase: call.phase,
    key: call.key,
    response_file: responseFile,
    answer_with: answerContract(call.phase),
    model_tier: request.model,
    max_tokens: request.maxTokens,
    tool_name: request.toolName,
    tools: request.tools,
    system: request.system,
    messages: request.messages,
    prompt: renderPrompt(request),
  };

  if (call.juror_role !== undefined) file.juror_role = call.juror_role;
  if (call.persona !== undefined) file.persona = call.persona;
  if (call.chunk_index !== undefined) file.chunk_index = call.chunk_index;
  if (request.effort !== undefined) file.effort = request.effort;
  return file;
}

/**
 * The whole prompt as one string, in render order.
 *
 * Convenience for whoever dispatches the subagent, and nothing more: it is not
 * compared, not validated, and never read back. The authoritative request is
 * `system` + `messages`.
 */
function renderPrompt(request: ModelRequest): string {
  const systemText = request.system.map((block) => block.text);
  const userText = request.messages.map((message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
  );
  return [...systemText, ...userText].join('\n\n');
}

/**
 * Whether two request documents would send the same thing to a model.
 *
 * Compares only what a model sees — tools, system, messages, the forced tool, the
 * tier, the budget and the effort. `prompt` is derived from those and is
 * excluded, so a change to `renderPrompt`'s formatting can never invalidate a
 * category's answered files.
 */
export function sameRequest(a: Partial<HandoffRequestFile>, b: Partial<HandoffRequestFile>): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

function comparable(file: Partial<HandoffRequestFile>): unknown {
  return {
    tool_name: file.tool_name,
    model_tier: file.model_tier,
    max_tokens: file.max_tokens,
    effort: file.effort ?? null,
    tools: file.tools,
    system: file.system,
    messages: file.messages,
  };
}

/** Whether a file is there at all. Used where the CONTENT is not this pass's business. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}

/** Read and parse a JSON file; `undefined` when it is not there. A bad parse names the file. */
async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HandoffResponseError(path, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Accept either the bare tool input or a `{output, usage, model}` envelope. */
export function unwrapResponse(raw: unknown, path: string): HandoffResponseFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HandoffResponseError(path, `expected a JSON object at the top level, got ${describe(raw)}`);
  }

  const record = raw as Record<string, unknown>;
  const output = record['output'];
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { output: record };
  }

  const envelope: HandoffResponseFile = { output };
  const usage = record['usage'];
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    envelope.usage = readUsage(usage as Record<string, unknown>, path);
  }
  const model = record['model'];
  if (typeof model === 'string' && model !== '') envelope.model = model;
  return envelope;
}

/** Token counts, when the responder reports them. A non-number is an error, not a zero. */
function readUsage(usage: Record<string, unknown>, path: string): Partial<TokenUsage> {
  const fields: (keyof TokenUsage)[] = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  const out: Partial<TokenUsage> = {};
  for (const field of fields) {
    const value = usage[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new HandoffResponseError(path, `usage.${field} must be a non-negative number, got ${describe(value)}`);
    }
    out[field] = value;
  }
  return out;
}

/**
 * Run the phase's own validator over one file's answer, and name the file when it
 * refuses.
 *
 * The validators are `src/panels/schemas.ts`'s, unchanged and unwrapped — the
 * same functions `dispatch` runs a moment later. Re-implementing a looser check
 * here would create a second, kinder definition of a valid panel answer, and the
 * kinder one would be the one the locally-seeded categories were built on.
 */
export function validateAgainst(expect: HandoffExpectation, output: unknown, path: string): void {
  try {
    switch (expect.phase) {
      case 'score':
        validateScoreResult(output, { productIds: expect.productIds, metricNames: expect.metricNames });
        return;
      case 'uniqueness':
        validateUniquenessResult(output, expect.productIds);
        return;
      case 'customer':
        validateChoiceResult(output, expect.sets);
        return;
    }
  } catch (error) {
    if (error instanceof SchemaValidationError) throw new HandoffResponseError(path, error.message);
    throw error;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}
