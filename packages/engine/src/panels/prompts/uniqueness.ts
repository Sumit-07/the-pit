/**
 * `uniquenessPrompt` — the clustering / scarcity pass. `01 §5.2`.
 *
 * Reconstructed from §5.2's description (the original lived in
 * `run_category.mjs:351` and is not quoted in `01`). Everything §5.2 states is
 * here: one pass over the whole set doing two jobs — group products whose core
 * idea is essentially the same and label each group, then score every product
 * 0-100 for SCARCITY rather than quality, from within-set redundancy plus
 * world-knowledge market saturation, with the 100 / 50 / 0 anchors §5.2 gives and
 * a <= 20-word reason per product.
 *
 * ## Layout
 *
 *   tools        UNIQ_SCHEMA                     stable
 *   system[0]    the two jobs + untrusted rule   stable
 *   system[1]    the product set (DATA)          stable   <- cache breakpoint
 *   messages[0]  the go-ahead                    stable
 *
 * This pass runs exactly ONCE per category (`01 §5.2`), so unlike the scoring and
 * persona passes there is no sibling call to read the cache. The breakpoint is
 * still marked, and the honest accounting is: it pays back only on a retry of the
 * same set, and costs a ~25% write premium on the prefix when it does not. That
 * premium is bounded — a prefix below the model's minimum cacheable length is
 * neither cached nor charged as one — and a retried clustering call is exactly
 * the case where a run has already gone wrong and should not also be paying full
 * price. Nothing downstream plans cost around a hit here.
 *
 * The clusters this pass produces are reused as the customer panel's similar-app
 * sets (`01 §5.2`, `§5.3`), so a bad clustering costs twice.
 */

import type Anthropic from '@anthropic-ai/sdk';

import { MAX_TOKENS_UNIQUENESS, MODEL_CLUSTER } from '../../config/constants.js';
import type { Effort, ModelRequest } from '../../model/types.js';
import type { Product } from '../../types.js';
import { UNIQ_SCHEMA, UNIQ_TOOL_NAME } from '../schemas.js';
import { dataBlock, dataField, UNTRUSTED_DATA_RULE } from '../data-block.js';
import type { PanelOrdering } from '../ordering.js';
import { panelOrder } from '../ordering.js';

/** `01 §5.2`: **Effort: `medium`**. Honoured — this pass runs on `claude-sonnet-5`, which supports it. */
const UNIQUENESS_EFFORT: Effort = 'medium';

const UNIQUENESS_TASK = `You are analysing one category of products for IDEA SCARCITY. You have two jobs, over exactly
the products listed below and no others.

You never rank, order, or say which product is best, and scarcity is not a verdict on any
product. The ranking is computed elsewhere by arithmetic you are not part of.

${UNTRUSTED_DATA_RULE}

## Job 1 — Cluster the ideas

Group together the products whose CORE IDEA is essentially the same: the same job, done for
the same kind of buyer, such that someone choosing one would consider the others as
substitutes for it.

- Sameness is about the idea, not the surface. A shared technology, a shared tone, a shared
  price point or a shared audience is not on its own the same idea.
- Every product belongs to exactly one cluster, and every product belongs to some cluster.
- A product with no near-substitute in this set is a cluster of ONE. Solo clusters are normal
  and expected. Never force two products together to avoid one, and never split a genuine
  group to make the sizes look even.
- Give each cluster a short, neutral label naming the shared idea in 60 characters or fewer —
  "team wiki with built-in search", not "the strong writing tools".
- Give each cluster a short \`cluster_id\` of your own choosing, unique within your answer.

## Job 2 — Score scarcity, 0 to 100

Score every product for SCARCITY. **Scarcity is not quality.** An excellent product in a
crowded space scores LOW. A mediocre product attempting something almost nobody attempts
scores HIGH. Do not let your view of how good, how well written, or how promising a product is
move this number in either direction.

Judge scarcity from two things together:

  (a) redundancy inside this set — how many of the other products listed here attempt the
      same idea; and
  (b) market saturation in the world as you know it — how many products outside this set
      already do this, and how established they are.

Anchors:

  100  rare or novel: no close analogue among these products, and little saturation outside.
   50  familiar: a few peers here, or a recognisable but uncrowded market outside.
    0  crowded commodity: many peers here, or a saturated market with entrenched incumbents.

Interpolate between the anchors. A product that is alone in this set but sits in a saturated
outside market is not scarce.

Give each product a reason of 20 words or fewer for its score, naming the crowd or the absence
of one — the peers or the analogues, not the product's merits.

## Your answer

Call the \`${UNIQ_TOOL_NAME}\` tool. Every product id you were given appears exactly once in
\`products\` and exactly once across the clusters' \`member_ids\`, and each product's
\`cluster_id\` matches the cluster that lists it.`;

/** The whole category, as DATA. */
function renderProducts(products: readonly Product[]): string {
  const lines = products.flatMap((product) => [
    `[id ${product.id}]`,
    `  ${dataField('name', product.name)}`,
    `  ${dataField('description', product.description)}`,
    '',
  ]);

  const ids = products.map((product) => product.id).join(', ');

  return [
    '## The products',
    '',
    `There are ${products.length} products. Their ids are: ${ids}.`,
    '',
    dataBlock(lines),
  ].join('\n');
}

/**
 * Build the single clustering / scarcity call.
 *
 * Products are rendered in `panelOrder`, not id order: id order is the incoming
 * leaderboard (`src/panels/ordering.ts`), and a clustering pass shown that order
 * would be handed a merit signal it is explicitly told not to use — `01 §5.2`
 * asks for scarcity, "not quality".
 *
 * @throws RangeError when there is nothing to cluster.
 */
export function buildUniquenessRequest(products: readonly Product[], ordering: PanelOrdering): ModelRequest {
  if (products.length === 0) throw new RangeError('buildUniquenessRequest: no products to cluster');

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: UNIQUENESS_TASK },
    { type: 'text', text: renderProducts(panelOrder(products, ordering)) },
  ];

  return {
    model: MODEL_CLUSTER,
    system,
    messages: [
      {
        role: 'user',
        content: `Cluster all ${products.length} products and score every one of them for scarcity now, returning the result by calling \`${UNIQ_TOOL_NAME}\`.`,
      },
    ],
    tools: [UNIQ_SCHEMA],
    toolName: UNIQ_TOOL_NAME,
    maxTokens: MAX_TOKENS_UNIQUENESS,
    effort: UNIQUENESS_EFFORT,
    cacheBreakpoint: system.length - 1,
  };
}
