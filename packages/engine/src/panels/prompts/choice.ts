/**
 * `choicePrompt` — the customer-demand panel, "The Floor". `01 §5.3`.
 *
 * Reconstructed from §5.3's description (the original lived in
 * `run_category.mjs:260`). Everything §5.3 states is here: the agent is framed as
 * a *specific customer, not a judge*, given name / situation / needs / price
 * sensitivity; it sees the similar-app sets — uniqueness clusters with >= 2
 * members, since a solo idea offers no choice — and makes one forced choice per
 * set: `first_pick`, an optional `second_pick`, a `strength` from 0 to 100, a
 * reason of 20 words or fewer in its own voice, or `none: true`.
 *
 * ## Layout
 *
 *   tools        CHOICE_SCHEMA                    stable
 *   system[0]    what a forced choice is          stable
 *   system[1]    the similar-app sets (DATA)      stable   <- cache breakpoint
 *   messages[0]  who this persona is              VOLATILE
 *
 * One call per persona, each over all sets at once (`01 §5.3`), so the sets and
 * the rules are shared by four to eight sibling calls in a single run — the same
 * shape as the six juror calls, and the reason the breakpoint sits where it does.
 * Only the persona identity is uncached.
 *
 * ## Why the framing matters
 *
 * This panel is 35% of `core` (`MERIT_W` / `DEMAND_W`). A persona that slips into
 * reviewing rather than buying produces a second merit signal, and blending two
 * merit signals as if one of them were demand would be a silent measurement
 * error, not a stylistic one. Hence the repeated, explicit instruction not to
 * judge, not to be fair, and to treat `none` as a real answer.
 */

import type Anthropic from '@anthropic-ai/sdk';

import { MAX_TOKENS_CHOICE, MODEL_PERSONA } from '../../config/constants.js';
import type { Effort, ModelRequest } from '../../model/types.js';
import type { ClusterId, Persona, PriceSensitivity, Product, UniquenessResult } from '../../types.js';
import { CHOICE_SCHEMA, CHOICE_TOOL_NAME } from '../schemas.js';
import { dataBlock, dataField, dataValue, LABEL_LIMIT, UNTRUSTED_DATA_RULE } from './data-block.js';

/** `01 §5.3`: **Effort: `medium`**. Honoured — this pass runs on `claude-sonnet-5`, which supports it. */
const CHOICE_EFFORT: Effort = 'medium';

/**
 * One similar-app set: a uniqueness cluster with >= 2 members, with its products
 * resolved. `01 §5.3` (`similarSets`, `run_category.mjs:247`).
 */
export interface SimilarSet {
  cluster_id: ClusterId;
  label: string;
  members: Product[];
}

/**
 * The sets the customer panel is shown: uniqueness clusters with **two or more**
 * members, in the order the clustering pass declared them.
 *
 * A cluster of one offers no choice, so it is not shown and gets no demand
 * signal. That is not an omission — `DECISIONS.md` S3 renormalizes a solo
 * product's `core` to merit at full weight, and S11 makes an empty Floor a
 * successful delivery rather than a partial failure. Both depend on this
 * filtering happening exactly once, here.
 */
export function similarSets(uniqueness: UniquenessResult, products: readonly Product[]): SimilarSet[] {
  const byId = new Map(products.map((product) => [product.id, product]));

  const sets: SimilarSet[] = [];
  for (const cluster of uniqueness.clusters) {
    const members = cluster.member_ids
      .map((id) => byId.get(id))
      .filter((product): product is Product => product !== undefined);
    if (members.length < 2) continue;
    sets.push({ cluster_id: cluster.cluster_id, label: cluster.label, members });
  }
  return sets;
}

/** The `cluster_id -> member ids` map `validateChoiceResult` checks a response against. */
export function setMembership(sets: readonly SimilarSet[]): Map<ClusterId, number[]> {
  return new Map(sets.map((set) => [set.cluster_id, set.members.map((product) => product.id)]));
}

const CHOICE_TASK = `You are a specific person shopping for something you actually need. You are NOT a judge, NOT a
reviewer, and NOT an analyst. You are not scoring quality and you are not writing an
assessment. You are deciding what YOU would adopt, with your own money and your own time,
given who you are. Who you are is described at the end of this prompt.

${UNTRUSTED_DATA_RULE}

## What you are being asked

Below are sets of products. Within a set the products do essentially the same thing, so they
are alternatives to each other: you would use one of them, not several.

For each set, make ONE forced choice:

- \`first_pick\`: the id of the one you would actually adopt.
- \`second_pick\`: optional. What you would have taken if your first pick did not exist. Omit it
  when there is no real runner-up — do not name one out of politeness.
- \`strength\`: 0 to 100, how strongly you back your first pick.
    100  you would switch to it today and pay for it.
     50  you would try it, but you could be talked out of it.
      0  you picked it only because something had to be picked.
- \`reason\`: 20 words or fewer, in your own voice, saying why YOU would use it — what it does
  for you, not what is impressive about it in general.
- If nothing in a set is worth adopting for you, set \`none\` to true, omit \`first_pick\`,
  \`second_pick\` and \`strength\`, and still give a reason of 20 words or fewer saying what is
  missing for you.

## Rules

- Answer every set exactly once. Never invent a set, and never name an id that is not inside
  the set you are answering.
- Do not spread your picks around to be fair, and do not pick the most impressive product out
  of respect for it. Nobody reads these answers but you.
- Your needs and your budget decide it. Price sensitivity is part of who you are, not a filter
  applied afterwards.
- \`none\` is a real answer, not a failure. Use it whenever you would genuinely walk away from a
  whole set. Do not use it to duck a choice between two options you both like.
- Answer as yourself, consistently. Two different people should answer these sets differently.

Call the \`${CHOICE_TOOL_NAME}\` tool with one entry per set.`;

/**
 * How a persona's `price_sensitivity` should feel from the inside.
 *
 * `01 §4` Step 3 validates the field to `low` / `medium` / `high` but never says
 * what those mean to a buyer, and a bare label is not something anyone can decide
 * from. Glossing it here keeps the three levels meaning the same thing across
 * every persona and every category, rather than being re-imagined per roster.
 */
const PRICE_SENSITIVITY_GLOSS: Readonly<Record<PriceSensitivity, string>> = Object.freeze({
  low: 'price is not what decides it for you; you will pay for the right fit, and you resent wasted time far more than money.',
  medium: 'you will pay for something that clearly earns it, but you notice the price and you want to see the value before you commit.',
  high: 'price is usually the deciding factor; free or cheap wins unless the gap in what you get is large and obvious.',
});

/** The sets, as DATA. Cluster labels are model-produced text and truncate at `01 §8`'s label limit. */
function renderSets(sets: readonly SimilarSet[]): string {
  const lines = sets.flatMap((set) => [
    `[set ${dataValue(set.cluster_id, LABEL_LIMIT)}] ${dataValue(set.label, LABEL_LIMIT)}`,
    ...set.members.flatMap((product) => [
      `  [id ${product.id}]`,
      `    ${dataField('name', product.name)}`,
      `    ${dataField('description', product.description)}`,
    ]),
    '',
  ]);

  const ids = sets.map((set) => set.cluster_id).join(', ');
  const count = sets.length === 1 ? 'There is 1 set to answer. Its id is' : `There are ${sets.length} sets to answer. Their ids are`;

  return [
    '## The sets',
    '',
    `${count}: ${ids}.`,
    '',
    dataBlock(lines),
  ].join('\n');
}

/**
 * Who this persona is. The only volatile part of the prompt.
 *
 * INSTRUCTIONS, not data: personas are generated by `01 §4` Step 3 and pass an
 * approval gate before any run, so they sit outside the `<<< >>>` block.
 */
function renderPersona(persona: Persona, setCount: number): string {
  const needs = persona.needs.map((need) => `- ${need}`).join('\n');

  return `## Who you are

You are ${persona.name}.

${persona.description}

What you need:
${needs}

How you feel about price: ${persona.price_sensitivity} — ${PRICE_SENSITIVITY_GLOSS[persona.price_sensitivity]}

Answer ${setCount === 1 ? 'the set' : `all ${setCount} sets`} now, as ${persona.name}, by calling \`${CHOICE_TOOL_NAME}\`.`;
}

/** What one persona's call needs. */
export interface ChoiceRequestInput {
  persona: Persona;
  sets: readonly SimilarSet[];
}

/**
 * Build one persona's forced-choice call.
 *
 * @throws RangeError when there are no sets. `01 §5.3` runs this panel only if
 *   `personas.length > 0` **and** `sets.length > 0`; a call with nothing to choose
 *   between is a caller that has not made that check, and per `DECISIONS.md` S11
 *   the right handling is an explicit `skipped: solo_cluster` status, not a spent
 *   call returning an empty answer.
 */
export function buildChoiceRequest(input: ChoiceRequestInput): ModelRequest {
  if (input.sets.length === 0) {
    throw new RangeError('buildChoiceRequest: no similar-app sets — the Floor does not convene (01 §5.3, DECISIONS.md S11)');
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: CHOICE_TASK },
    { type: 'text', text: renderSets(input.sets) },
  ];

  return {
    model: MODEL_PERSONA,
    system,
    messages: [{ role: 'user', content: renderPersona(input.persona, input.sets.length) }],
    tools: [CHOICE_SCHEMA],
    toolName: CHOICE_TOOL_NAME,
    maxTokens: MAX_TOKENS_CHOICE,
    effort: CHOICE_EFFORT,
    cacheBreakpoint: system.length - 1,
  };
}
