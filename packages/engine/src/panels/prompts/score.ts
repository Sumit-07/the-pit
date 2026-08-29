/**
 * `scorePrompt` — the merit jury's scoring call. `01 §5.1`.
 *
 * `01` describes this prompt but never gives it verbatim (it lived in
 * `run_category.mjs:300`), so the text below is a reconstruction from §5.1's
 * description. Everything §5.1 states is present and marked: the juror mandate as
 * INSTRUCTIONS, the metric rubric with all four anchors, the product list as
 * DATA, and the method — start at 100 and deduct, each deduction pairing points
 * with a <= 20-word reason, deductions for a metric summing to exactly
 * (100 - score), a perfect metric being score 100 with an empty deductions list.
 * `brief §1.1`'s calibration sample is added on the incremental path.
 *
 * ## Layout, and why it is this way
 *
 * Prompt caching is a prefix match rendered `tools` -> `system` -> `messages`.
 * Across the six jurors of one run (`DECISIONS.md` S1) everything is identical
 * except the mandate, so the split is:
 *
 *   tools          SCORE_SCHEMA                      stable
 *   system[0]      method + untrusted-data rule      stable
 *   system[1]      the rubric with its anchors       stable
 *   system[2]      calibration peers, if any (DATA)  stable within a run
 *   system[3]      the products to score (DATA)      stable   <- cache breakpoint
 *   messages[0]    the juror's mandate               VOLATILE
 *
 * The mandate is last because it is the only volatile part, and a prefix match
 * gives nothing back if the volatile part comes first. It is a user message
 * rather than a trailing system block because the API needs at least one message
 * anyway, and putting it there keeps the cached prefix entirely inside `system`.
 *
 * The calibration block sits INSIDE the cached prefix but is NOT what the
 * breakpoint is for. Per the note at the top of `src/panels/calibration.ts`, the
 * sample's seed includes `categoryVersion`, which bumps on every placement and
 * every nightly rebuild, so the anchor is redrawn per submission and never
 * repeats across customers. It earns its place in the prefix because the six
 * jurors of a single run share it; it would earn nothing as a breakpoint of its
 * own, and planning cost around one would be planning around a cache that never
 * hits.
 *
 * ## Untrusted text
 *
 * Product names and descriptions — for the targets and for the calibration peers
 * alike — are sanitized, truncated to `SANITIZE_LIMIT`, delimiter-neutralized and
 * wrapped in `<<< >>>` (`data-block.ts`). The mandate, the rubric and the method
 * are INSTRUCTIONS and appear only outside the block (Global Constraint 2).
 */

import type Anthropic from '@anthropic-ai/sdk';

import { MAX_TOKENS_SCORE, MODEL_JUROR } from '../../config/constants.js';
import type { ModelRequest } from '../../model/types.js';
import type { JurorMandate, Product, RubricMetric } from '../../types.js';
import type { CalibrationSample } from '../calibration.js';
import { SCORE_SCHEMA, SCORE_TOOL_NAME } from '../schemas.js';
import { dataBlock, dataField, dataValue, UNTRUSTED_DATA_RULE } from './data-block.js';

/** What one scoring call needs. */
export interface ScoreRequestInput {
  /** The rubric, in order, with all four anchors per metric (`01 §4` Step 2). */
  metrics: readonly RubricMetric[];
  /** The products this call scores — one chunk (`01 §5.1`, `brief §1.4`). */
  products: readonly Product[];
  /** The juror whose mandate this call runs under. */
  juror: JurorMandate;
  /**
   * Already-scored peers shown as reference on the incremental path
   * (`brief §1.1`). Omit on a full-category run, where the chunk itself is the
   * comparison set.
   */
  calibration?: CalibrationSample;
}

/** The four anchor levels, highest first, exactly as `01 §4` Step 2 keys them. */
const ANCHOR_LEVELS = ['100', '80', '50', '20'] as const;

/**
 * The standing scoring instructions: what a juror is, what it must never do, how
 * to read the data block, and the deduction method.
 *
 * Byte-stable across every juror and every run of a given prompt version — it is
 * the head of the cache prefix, so anything varying belongs elsewhere.
 */
const SCORING_METHOD = `You are one juror on a merit jury. The jury scores every product in a single category
against one fixed rubric. Each juror scores the same products under a different mandate, and
the jury is meant to disagree — your mandate is given to you at the end of this prompt.

You produce raw scores only. You never rank, order, or say which product is best, and nothing
you write may refer to a product's position, rank, or place. The ranking is computed elsewhere,
from your numbers and the other jurors', by arithmetic you are not part of.

${UNTRUSTED_DATA_RULE}

## How to score

Score every metric in the rubric, for every product listed under PRODUCTS TO SCORE.

1. Start the metric at 100.
2. Take a deduction for each specific, concrete way the product falls short of that metric's
   100 anchor. Each deduction pairs a whole number of points with a reason of 20 words or fewer
   naming the shortcoming. A reason that restates the metric, or says only "weak" or
   "unclear", is not a reason.
3. The score is 100 minus the sum of that metric's deductions. The deductions you list for a
   metric MUST sum to exactly (100 - score). Add them up and check before you answer. If the
   arithmetic does not come out, fix the deductions or fix the score — never leave them
   inconsistent, and never round.
4. A metric with nothing to deduct is score 100 with an empty deductions list. Do not invent a
   token deduction to avoid a perfect score, and do not drop a real deduction to make a sum work.
5. Scores are whole numbers from 0 to 100.
6. Judge each product against the anchor text for that metric. The other products in the list
   are your comparison set and make the anchors concrete — use them to calibrate — but every
   score must still be defensible against the anchor wording itself.
7. Judge only what the product's own text supports. Absence of a claim is not evidence of a
   flaw, and a confident tone is not evidence of a strength.
8. \`note\` is optional: at most one short sentence about the product overall. Omit it when you
   have nothing to add.

Answer by calling the \`${SCORE_TOOL_NAME}\` tool. Score every product in PRODUCTS TO SCORE exactly
once, with every metric of the rubric for each.`;

/**
 * The rubric block: each metric with its description and all four anchors.
 *
 * `01 §5.1` requires all four anchor levels to be shown. They are what makes a
 * score mean the same thing to six different jurors, so a rubric rendered without
 * them would leave every juror inventing its own scale.
 */
function renderRubric(metrics: readonly RubricMetric[]): string {
  const blocks = metrics.map((metric, index) => {
    const anchors = ANCHOR_LEVELS.map((level) => `  ${level.padStart(3)}: ${metric.anchors[level]}`);
    return [`${index + 1}. ${metric.name}`, `  What it measures: ${metric.description}`, ...anchors].join('\n');
  });

  return [
    '## The rubric',
    '',
    'Score every product on each of these metrics. The four anchors describe what that score',
    'looks like; interpolate between them.',
    '',
    ...blocks,
  ].join('\n');
}

/**
 * The calibration block (`brief §1.1`).
 *
 * `selectCalibrationSample` hands back peers WITH their published scores and
 * cannot itself stop those peers being presented in a way that invites
 * re-scoring. Making that impossible is this function's job, and it does it three
 * ways at once: the heading says it, the rules say it in the imperative, and the
 * schema validator rejects any response containing a peer's id
 * (`validateScoreResult`). Prompt wording alone would not be enough — a juror
 * that re-scores an anchor injects fabricated scores into the very population the
 * paying customer is placed against.
 */
function renderCalibration(sample: CalibrationSample): string {
  const lines = sample.sample.flatMap((peer) => [
    `[id ${peer.id}] ALREADY SCORED — REFERENCE ONLY`,
    `  ${dataField('name', peer.name)}`,
    `  ${dataField('description', peer.description)}`,
    `  scores already assigned: ${renderPeerScores(peer.scores)}`,
    '',
  ]);

  return [
    '## Calibration — already scored, DO NOT SCORE THESE',
    '',
    'The products below were scored earlier, by this jury, against this same rubric. Their scores',
    'are shown so you can see what these numbers already mean in this category.',
    '',
    '- They are NOT part of your task. They must not appear in your answer at all.',
    '- Do not score them, re-score them, revise their scores, or take deductions against them.',
    '- Use them only to calibrate: a product no better than one of these peers on a metric should',
    '  not out-score it on that metric, and a clearly better one should out-score it.',
    '- Your answer must contain exactly the ids listed under PRODUCTS TO SCORE, and no others.',
    '',
    `Calibration set version: ${sample.calibration_version}`,
    '',
    dataBlock(lines),
  ].join('\n');
}

/** `metric: score` pairs for one peer, in the order the calibration sample carries them. */
function renderPeerScores(scores: Record<string, number>): string {
  const pairs = Object.entries(scores).map(([metric, score]) => `${dataValue(metric)} ${score}`);
  return pairs.length === 0 ? '(none recorded)' : pairs.join(' | ');
}

/** The products this call scores, as DATA. */
function renderProducts(products: readonly Product[]): string {
  const lines = products.flatMap((product) => [
    `[id ${product.id}]`,
    `  ${dataField('name', product.name)}`,
    `  ${dataField('description', product.description)}`,
    '',
  ]);

  const ids = products.map((product) => product.id).join(', ');
  const which = products.length === 1 ? 'this 1 product, and only it' : `these ${products.length} products, and only these`;

  return [
    '## PRODUCTS TO SCORE',
    '',
    `Score ${which}. The id${products.length === 1 ? ' is' : 's are'}: ${ids}.`,
    '',
    dataBlock(lines),
  ].join('\n');
}

/**
 * The juror's mandate. The only volatile part of the prompt, and the reason the
 * six jurors of one run are six different calls rather than one.
 *
 * INSTRUCTIONS, not data: mandates are generated by the jury pass and cleared
 * through `01 §4` Step 2's approval gate before any run, so they are trusted and
 * belong outside the `<<< >>>` block (Global Constraint 2). They are not
 * sanitized or truncated — truncating a mandate would silently change what a
 * juror weighs.
 */
function renderMandate(juror: JurorMandate, productCount: number): string {
  return `## Your mandate

You are ${juror.role}.

Who you are: ${juror.who}
What you care most about: ${juror.cares_most}
What you are biased against: ${juror.biased_against}
How you write: ${juror.voice}

Score from inside this mandate. It decides what counts as a shortcoming, how heavily it weighs,
and how your reasons read — another juror looking at the same product should reach a different
number and say so differently. It does not change the rubric, the four anchors, the method, or
which products you score.

Score ${productCount === 1 ? 'the product' : `all ${productCount} products`} in PRODUCTS TO SCORE now and return
the result by calling \`${SCORE_TOOL_NAME}\`.`;
}

/**
 * Build one juror's scoring call.
 *
 * @throws RangeError when there is nothing to score or no rubric — both are
 *   caller bugs that would otherwise spend a call on an empty prompt.
 */
export function buildScoreRequest(input: ScoreRequestInput): ModelRequest {
  if (input.products.length === 0) throw new RangeError('buildScoreRequest: no products to score');
  if (input.metrics.length === 0) throw new RangeError('buildScoreRequest: the rubric has no metrics');

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SCORING_METHOD },
    { type: 'text', text: renderRubric(input.metrics) },
  ];

  // Only present on the incremental path. A run with no calibration sample omits
  // the block entirely rather than emitting an empty one: an empty "calibration"
  // heading tells a juror it has peers when it has none.
  if (input.calibration !== undefined && input.calibration.sample.length > 0) {
    system.push({ type: 'text', text: renderCalibration(input.calibration) });
  }

  system.push({ type: 'text', text: renderProducts(input.products) });

  return {
    model: MODEL_JUROR,
    system,
    messages: [{ role: 'user', content: renderMandate(input.juror, input.products.length) }],
    tools: [SCORE_SCHEMA],
    toolName: SCORE_TOOL_NAME,
    maxTokens: MAX_TOKENS_SCORE,
    // No `effort`. `01 §5.1` asks for `low`, but jurors run on `claude-haiku-4-5`,
    // which rejects `output_config.effort` on the Messages API. See the divergence
    // note on `buildMessageParams` in `src/model/anthropic-client.ts`.
    cacheBreakpoint: system.length - 1,
  };
}
