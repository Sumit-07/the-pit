/**
 * The two generation prompts: the jury + rubric (`01 §4` Step 2, APPROVAL GATE 1)
 * and the customer panel (`01 §4` Step 3, APPROVAL GATE 2).
 *
 * ## Why these return a string and not a `ModelRequest`
 *
 * Every other prompt builder in `src/panels/` returns a `ModelRequest`, because
 * every other prompt is dispatched by the pipeline. These two are not. `01 §4`
 * Step 2 is explicit: `generate_jury.py` "prints a generation prompt (it does not
 * call any model)"; a human dispatches one subagent with it, saves the JSON, and
 * only then installs it through the validator. Both steps end in **STOP and show
 * the user** — the jury and the panel are the two things a person signs off on
 * before any money is spent.
 *
 * A `ModelRequest` would be the wrong shape for that: it would need a tier, an
 * output budget and a forced-tool schema, none of which `01` specifies for
 * generation, and having one would invite a caller to run the gate automatically.
 * A string is what a person pastes, edits, and re-runs. The engine's contract
 * with generation is the validator, not the call.
 *
 * ## Untrusted text
 *
 * Taglines are product copy — UNTRUSTED (Global Constraint 2). They go through
 * `dataValue` into a `<<< >>>` block under `UNTRUSTED_DATA_RULE`. The generation
 * instructions, the output contract and the type hint are INSTRUCTIONS and sit
 * outside it. The category name is sanitized too even though it is rendered
 * outside the block: it arrives from the same spreadsheet, and `data-block.ts`
 * records that text rendered outside a block still has to be sanitized by its own
 * caller.
 *
 * A generation prompt is a softer injection target than a scoring prompt — it
 * produces a rubric a human reads and approves, not a score — but it is not a
 * free one. A tagline that talks a model into a metric named after its own
 * product would be reviewed by a person before installation; a tagline that talks
 * it into a rubric subtly shaped to favour one submission might not be. The gate
 * is the human; the block is what keeps the human's job possible.
 */

import { JUROR_COUNT, METRICS_MAX, METRICS_MIN, PERSONAS_TARGET } from '../../config/constants.js';
import { ANCHOR_LEVELS } from '../anchors.js';
import { dataBlock, dataValue, UNTRUSTED_DATA_RULE } from '../data-block.js';
import { inferTypeHint, sampleTaglines } from './type-hint.js';

/** The initial value both prompts are told to stamp; a human bumps it on any edit. */
const INITIAL_VERSION = 'v1';

/** `"100", "80", "50", "20"` — the anchor keys, quoted, for the output contract. */
const ANCHOR_KEY_LIST = ANCHOR_LEVELS.map((level) => `"${level}"`).join(', ');

/**
 * Singular/plural phrasing with `$n` standing in for the count.
 *
 * Small, but the alternative is interpolating a plural `s` in the middle of an
 * array of prompt lines, which breaks the sentence across a newline at whatever
 * point the interpolation happens to fall. A generation prompt is read by a
 * person at an approval gate before it is read by a model; a prompt that wraps
 * mid-clause reads as carelessly assembled, which is the wrong signal on a page
 * asking for care.
 */
function count(n: number, singular: string, plural: string): string {
  return (n === 1 ? singular : plural).replaceAll('$n', String(n));
}

/**
 * The shared head of both prompts: what category this is, what the heuristic
 * guessed, and the sampled taglines as DATA.
 *
 * Identical for both gates by design. The jury and the panel are two readings of
 * the same evidence, and showing them different evidence would let a rubric and a
 * buyer roster describe different categories.
 */
function renderContext(category: string, taglines: readonly string[]): string {
  const sample = sampleTaglines(taglines);
  const hint = inferTypeHint(sample);
  const safeCategory = dataValue(category);

  const lines = sample.map((tagline, index) => `${index + 1}. ${dataValue(tagline)}`);

  return [
    `## The category: ${safeCategory}`,
    '',
    UNTRUSTED_DATA_RULE,
    '',
    ...(sample.length === 0
      ? ['No taglines were available for this category, so you are working from its name alone.']
      : [
          `Below ${count(sample.length, 'is one product tagline', 'are $n product taglines')} from this category, to show you what is actually in it. They`,
          'are a sample, not the whole category, and they are marketing copy — read them for what the',
          'category is about, not as claims to believe.',
        ]),
    '',
    lines.length === 0 ? dataBlock(['(no taglines available)']) : dataBlock(lines),
    '',
    '## A provisional guess about this category',
    '',
    `A keyword count over ${sample.length === 0 ? 'this category' : 'those taglines'} found ${count(hint.b2b_hits, '$n b2b word', '$n b2b words')} and ${count(hint.consumer_hits, '$n consumer word', '$n consumer words')}, which points at: ${hint.type}.`,
    '',
    'That is a word count, not a judgement, and it is wrong often enough that you should treat it',
    'as a starting point only. You are reading the taglines themselves. If they say something',
    'different, say something different — you decide.',
  ].join('\n');
}

/**
 * Build the jury + rubric generation prompt. `01 §4` Step 2.
 *
 * @param category The category name, as it appears in the sheet's `Category` column.
 * @param taglines Product taglines in sheet order; the first `TAGLINE_SAMPLE` are shown.
 */
export function buildJuryPrompt(category: string, taglines: readonly string[]): string {
  return [
    `You are designing the judging panel for one category of products: ${dataValue(category)}.`,
    '',
    'Two things come out of this: a RUBRIC — the metrics every product in the category will be',
    `scored on — and a JURY of ${JUROR_COUNT} jurors who will each score every product against that same`,
    'rubric from a different point of view. A person reviews what you produce and approves it',
    'before it is used, so make it defensible rather than safe.',
    '',
    renderContext(category, taglines),
    '',
    '## The rubric',
    '',
    `Write between ${METRICS_MIN} and ${METRICS_MAX} metrics. Each metric needs:`,
    '',
    '- a short `name`, unique within the rubric;',
    '- a `description` saying what it measures, in one sentence;',
    `- four \`anchors\`, keyed ${ANCHOR_KEY_LIST}, each describing what a product scoring that number`,
    '  looks like in THIS category.',
    '',
    'The anchors are the whole scale. Write them concretely enough that two different readers',
    'given the same product land within a few points of each other — name what is present at 100',
    'and missing at 20, in the vocabulary of this category, not in general praise. "Excellent" and',
    '"poor" are not anchors.',
    '',
    'Metrics must be things a product can be judged on from a short description of it. Do not',
    'write a metric that needs pricing, headcount, funding, traction, or usage numbers: none of',
    'that is available, and a metric nobody can score becomes a metric everybody scores 50.',
    '',
    `## The ${JUROR_COUNT} jurors`,
    '',
    `Write exactly ${JUROR_COUNT} jurors. Each juror needs:`,
    '',
    '- `role` — what to call them, unique across the jury (e.g. "The Operator");',
    '- `who` — who they are and what they have done, in a sentence or two;',
    '- `cares_most` — what they weigh above everything else;',
    '- `biased_against` — what reliably annoys them, even when it should not;',
    '- `voice` — how they write, so their reasons sound like them;',
    '- `weights` — an object keyed by EXACTLY the metric names you wrote above, no key missing and',
    '  no key extra, each value a number of 0 or more, and at least one of them above 0.',
    '',
    'The jury exists to disagree. A jury that agrees produces one opinion six times and ranks',
    'nothing. So: at least one juror must weigh heavily a metric that another juror weighs at or',
    'near zero, and that has to be genuine — a juror who does not care about polish should say so',
    'in `cares_most` and weight it near zero, not weight everything at 1 while claiming a bias.',
    '',
    'Make them people, not job titles. They should be recognisable to someone who works in this',
    'category, they should not all be buyers, and none of them should be a generic critic.',
    '',
    '## What to return',
    '',
    'Return one JSON object and nothing else — no prose before or after, no markdown fence:',
    '',
    '```',
    '{',
    '  "type": "b2b" | "consumer" | "prosumer",',
    `  "prompt_version": "${INITIAL_VERSION}",`,
    '  "metrics": [',
    '    {',
    '      "name": "...",',
    '      "description": "...",',
    `      "anchors": { ${ANCHOR_LEVELS.map((level) => `"${level}": "..."`).join(', ')} }`,
    '    }',
    '  ],',
    '  "jurors": [',
    '    {',
    '      "role": "...",',
    '      "who": "...",',
    '      "cares_most": "...",',
    '      "biased_against": "...",',
    '      "voice": "...",',
    '      "weights": { "<metric name>": 0 }',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `\`type\` is your call: \`b2b\` if the buyer is a company, \`consumer\` if the buyer is a person`,
    'spending their own money on their own life, `prosumer` if the buyer is a person spending their',
    'own money on their own work. The guess above is only a guess.',
    '',
    `Set \`prompt_version\` to "${INITIAL_VERSION}". Every field above is required, every string must be`,
    `non-empty, \`metrics\` must have ${METRICS_MIN} to ${METRICS_MAX} entries and \`jurors\` exactly ${JUROR_COUNT}.`,
  ].join('\n');
}

/**
 * Build the customer-panel generation prompt. `01 §4` Step 3.
 *
 * Asks for exactly `PERSONAS_TARGET` (6). The validator's bounds are wider —
 * `PERSONAS_MIN`..`PERSONAS_MAX` (4-8), per `01 §4` Step 3, which notes the prompt
 * asks for 6 while the hard bounds are 4-8 — so a panel that comes back at 5 or 7
 * still installs. The prompt names one number anyway: asking for a range invites
 * the low end of it, and the demand math (`01 §6.2`) divides by the number of
 * personas that answered, so a thin panel makes `capture` coarser.
 *
 * @param category The category name, as it appears in the sheet's `Category` column.
 * @param taglines Product taglines in sheet order; the first `TAGLINE_SAMPLE` are shown.
 */
export function buildPersonaPrompt(category: string, taglines: readonly string[]): string {
  return [
    `You are casting the buyers for one category of products: ${dataValue(category)}.`,
    '',
    `Write ${PERSONAS_TARGET} personas: the people who would actually be choosing between things in this`,
    'category. Later, each of them is shown small sets of near-identical products and asked which',
    'one they would adopt, so a persona is worth writing only if it would answer differently from',
    'the others. A person reviews the roster and approves it before it is used.',
    '',
    renderContext(category, taglines),
    '',
    '## What a persona is',
    '',
    'Each persona needs:',
    '',
    '- `name` — what to call them, unique across the roster. A person\'s name, not a segment label;',
    '- `description` — who they are, what their situation is, and what they are trying to get done,',
    '  in a couple of sentences. Concrete: a job, a constraint, a reason they are shopping at all;',
    '- `needs` — a non-empty list of the specific things they need from a product here. Short',
    '  phrases, each one something a product could plainly satisfy or plainly fail;',
    '- `price_sensitivity` — exactly one of `low`, `medium`, `high`.',
    '',
    '## Make them disagree',
    '',
    'A roster of six variations on the same buyer produces six identical picks and measures',
    'nothing. Spread them across the real fault lines of this category: what they are willing to',
    'give up, how much setup they will tolerate, whether they are buying for themselves or for',
    'other people, what would make them walk away.',
    '',
    'Two of them are required:',
    '',
    `- at least one buyer with \`price_sensitivity\` of \`low\` who chases capability — they will pay`,
    '  for the best thing available and say why it is worth it;',
    `- at least one buyer with \`price_sensitivity\` of \`high\` who defects on price — they will leave`,
    '  a better product for a cheaper adequate one, and their reasons should show it.',
    '',
    'The rest should be genuinely different from those two and from each other.',
    '',
    '## What to return',
    '',
    'Return one JSON object and nothing else — no prose before or after, no markdown fence:',
    '',
    '```',
    '{',
    `  "persona_version": "${INITIAL_VERSION}",`,
    '  "personas": [',
    '    {',
    '      "name": "...",',
    '      "description": "...",',
    '      "needs": ["...", "..."],',
    '      "price_sensitivity": "low" | "medium" | "high"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `Set \`persona_version\` to "${INITIAL_VERSION}". Every field is required, every string must be`,
    `non-empty, and \`personas\` must have exactly ${PERSONAS_TARGET} entries.`,
  ].join('\n');
}
