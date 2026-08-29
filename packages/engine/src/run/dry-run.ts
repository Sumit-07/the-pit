/**
 * The dry run — `01 §4` Step 4, **APPROVAL GATE 3**.
 *
 * "It prints the projected agent-call count (see §7) and spends nothing. Show the
 * user the projection and budget. On approval, re-invoke without `dryRun`."
 *
 * `01 §7.3` gives the call count and stops there, because its panels were local
 * subagents with no per-token bill. On the Messages API the count is the cheap
 * half of the question, so this also estimates tokens and dollars.
 *
 * ## Spending nothing, honestly
 *
 * No `ModelClient` is constructed and none is accepted as an argument, so this
 * function CANNOT spend: there is nothing here to spend with. That is stronger
 * than a `dryRun` flag threaded through the runner, where a missed branch is a
 * silent charge — a caller who has a projection has not, by construction, made a
 * call.
 *
 * ## Where the numbers come from
 *
 * The INPUT side is measured, not guessed: the projection builds the exact
 * requests a real run would send and counts their rendered characters, so it
 * moves when a prompt changes. Only the characters-to-tokens ratio is an
 * approximation. The OUTPUT side is genuinely estimated, from the same per-row
 * derivations already written against the `MAX_TOKENS_*` constants, because the
 * only way to know what a model will write is to pay it to write it.
 *
 * The Customer phase cannot be rendered before the clusters exist (`01 §2` puts
 * it strictly after Uniqueness), so its input is projected as an UPPER BOUND: one
 * synthetic set holding every product, which is the most product text any real
 * set of sets could contain. That is stated in `caveats` rather than buried,
 * because a projection shown at an approval gate is only useful if the person
 * approving knows which way it errs.
 */

import {
  EST_CHARS_PER_TOKEN,
  EST_OUTPUT_TOKENS_PER_CHOICE,
  EST_OUTPUT_TOKENS_PER_SCORED_METRIC,
  EST_OUTPUT_TOKENS_PER_UNIQUENESS_ROW,
  MODEL_CLUSTER,
  MODEL_JUROR,
  MODEL_PERSONA,
  TOKENS_PER_PRICE_UNIT,
} from '../config/constants.js';
import type { ModelRequest, ModelTier } from '../model/types.js';
import type { CalibrationSample } from '../panels/calibration.js';
import type { PanelOrdering } from '../panels/ordering.js';
import { orderedChunks } from '../panels/ordering.js';
import { buildChoiceRequest } from '../panels/prompts/choice.js';
import type { SimilarSet } from '../panels/prompts/choice.js';
import { buildScoreRequest } from '../panels/prompts/score.js';
import { buildUniquenessRequest } from '../panels/prompts/uniqueness.js';
import type { Jury, Persona, Product } from '../types.js';
import { tierPrices } from './ledger.js';
import type { DryRunPhase, DryRunProjection } from './types.js';

export interface DryRunInput {
  category: string;
  products: readonly Product[];
  jury: Jury;
  personas: readonly Persona[];
  ordering: PanelOrdering;
  chunkSize?: number;
  /** Present only when projecting the incremental path (`brief §1.1`). */
  calibration?: CalibrationSample;
}

/** Project what a run would cost. Spends nothing — see the header. */
export function projectRun(input: DryRunInput): DryRunProjection {
  const chunks = orderedChunks(input.products, input.ordering, input.chunkSize);
  const jurors = input.jury.jurors.length;
  const metrics = input.jury.metrics.length;
  const personas = input.personas.length;

  const scoreRequests = input.jury.jurors.flatMap((juror) =>
    chunks.map((chunk) =>
      buildScoreRequest({
        metrics: input.jury.metrics,
        products: chunk,
        juror,
        ordering: input.ordering,
        ...(input.calibration === undefined ? {} : { calibration: input.calibration }),
      }),
    ),
  );

  const scorePhase = phaseEstimate(
    'score',
    MODEL_JUROR,
    scoreRequests,
    // Every juror scores every product on every metric (`01 §5.1`).
    jurors * input.products.length * metrics * EST_OUTPUT_TOKENS_PER_SCORED_METRIC,
  );

  const uniquenessPhase = phaseEstimate(
    'uniqueness',
    MODEL_CLUSTER,
    input.products.length === 0 ? [] : [buildUniquenessRequest(input.products, input.ordering)],
    // One row per product, plus the cluster roster, which is smaller.
    input.products.length * EST_OUTPUT_TOKENS_PER_UNIQUENESS_ROW,
  );

  const customerPhase = phaseEstimate(
    'customer',
    MODEL_PERSONA,
    projectedChoiceRequests(input),
    // Worst case: every product sits in a multi-member set, so every persona
    // answers about every cluster. Bounded above by one choice per product.
    personas * input.products.length * EST_OUTPUT_TOKENS_PER_CHOICE,
  );

  const phases = [scorePhase, uniquenessPhase, customerPhase];

  return {
    category: input.category,
    products: input.products.length,
    chunks: chunks.length,
    jurors,
    personas,
    // `01 §7.3`'s formula, with `DECISIONS.md` S1's six jurors:
    // `JUROR_COUNT x chunks + 1 + personas`.
    calls: jurors * chunks.length + uniquenessPhase.calls + personas,
    phases,
    estimated_input_tokens: sum(phases, (phase) => phase.estimated_input_tokens),
    estimated_output_tokens: sum(phases, (phase) => phase.estimated_output_tokens),
    estimated_cost_usd: sum(phases, (phase) => phase.estimated_cost_usd),
    caveats: [
      `input tokens are the rendered prompts of the real requests, at ~${EST_CHARS_PER_TOKEN} characters per token`,
      'output tokens are estimated from the worst-case per-row derivations behind the MAX_TOKENS_* constants',
      'the Customer phase cannot be rendered before the clusters exist, so its input is an UPPER BOUND: ' +
        'one synthetic set holding every product',
      'a cold prompt cache is assumed — a real run reads the shared juror prefix from cache and costs less',
    ],
  };
}

/**
 * The Customer phase's requests, as far as they can be known before Uniqueness
 * has run. One synthetic set with every product in it; see the header.
 */
function projectedChoiceRequests(input: DryRunInput): ModelRequest[] {
  if (input.personas.length === 0 || input.products.length < 2) return [];

  const projected: SimilarSet = {
    cluster_id: 'projected',
    label: 'projected upper bound: every product as one similar-app set',
    members: [...input.products],
  };
  return input.personas.map((persona) =>
    buildChoiceRequest({ persona, sets: [projected], ordering: input.ordering }),
  );
}

/** Roll a phase's requests into one estimate. */
function phaseEstimate(
  phase: DryRunPhase['phase'],
  tier: ModelTier,
  requests: readonly ModelRequest[],
  outputTokens: number,
): DryRunPhase {
  const inputTokens = sum(requests, estimateRequestTokens);
  const prices = tierPrices(tier);
  return {
    phase,
    calls: requests.length,
    estimated_input_tokens: inputTokens,
    estimated_output_tokens: requests.length === 0 ? 0 : outputTokens,
    estimated_cost_usd:
      (inputTokens * prices.input + (requests.length === 0 ? 0 : outputTokens) * prices.output) /
      TOKENS_PER_PRICE_UNIT,
  };
}

/**
 * Rendered size of one request, in estimated tokens.
 *
 * Counts the tool definitions too: they are the first thing rendered
 * (`tools -> system -> messages`) and `SCORE_SCHEMA` is not small. Message
 * content is a string in every prompt this engine builds; a structured content
 * array is measured through its JSON, which is close enough for an estimate and
 * cannot silently count zero.
 */
export function estimateRequestTokens(request: ModelRequest): number {
  let characters = JSON.stringify(request.tools).length;
  for (const block of request.system) characters += block.text.length;
  for (const message of request.messages) {
    characters += typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length;
  }
  return Math.ceil(characters / EST_CHARS_PER_TOKEN);
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}

/** Render a projection for a terminal, for `01 §4` Step 4's approval gate. */
export function formatProjection(projection: DryRunProjection): string {
  const money = (usd: number): string => `$${usd.toFixed(4)}`;
  const lines = [
    `DRY RUN — ${projection.category}`,
    '',
    `  products            ${projection.products}`,
    `  chunks              ${projection.chunks}`,
    `  jurors              ${projection.jurors}`,
    `  personas            ${projection.personas}`,
    `  PROJECTED CALLS     ${projection.calls}   (${projection.jurors} jurors x ${projection.chunks} chunk(s) + 1 clustering + ${projection.personas} personas)`,
    '',
    '  phase        calls   est. input   est. output   est. cost',
  ];

  for (const phase of projection.phases) {
    lines.push(
      `  ${phase.phase.padEnd(11)}${String(phase.calls).padStart(6)}${String(phase.estimated_input_tokens).padStart(13)}${String(phase.estimated_output_tokens).padStart(14)}${money(phase.estimated_cost_usd).padStart(12)}`,
    );
  }

  lines.push(
    `  ${'TOTAL'.padEnd(11)}${String(projection.calls).padStart(6)}${String(projection.estimated_input_tokens).padStart(13)}${String(projection.estimated_output_tokens).padStart(14)}${money(projection.estimated_cost_usd).padStart(12)}`,
    '',
    '  Estimates, not quotes:',
    ...projection.caveats.map((caveat) => `    - ${caveat}`),
    '',
    '  Nothing was spent. Re-run with --run to execute.',
  );

  return lines.join('\n');
}
