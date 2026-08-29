/**
 * `assignPrompt` — placing ONE new product into a category's existing clusters.
 *
 * The incremental counterpart to `01 §5.2`'s clustering pass, and the piece
 * `brief §1.5` requires that `01` never had:
 *
 * > "Demand votes are keyed to `cluster_id`. Re-clustering invalidates every
 * > stored vote. Clusters are **append-only**: a new product joins an existing
 * > cluster or opens a new one. Full re-clustering is an explicit admin operation
 * > that clears demand for that category."
 *
 * Re-running `buildUniquenessRequest` over the whole category for every paid
 * submission would break exactly that rule: the model would re-derive the cluster
 * roster from scratch, and every existing `cluster_id` — and therefore every
 * demand vote hanging off it — would be gone. So the new product is placed
 * against the roster that already exists, and the answer can only ever be "this
 * existing cluster_id" or "a new cluster with this label". Append-only is not a
 * convention here; it is the only thing the schema can express.
 *
 * ## Layout
 *
 *   tools        ASSIGN_SCHEMA                    stable
 *   system[0]    the task + untrusted-data rule   stable
 *   system[1]    the existing clusters (DATA)     stable per category snapshot
 *   system[2]    the new product (DATA)           VOLATILE   <- breakpoint at [1]
 *   messages[0]  the go-ahead                     stable
 *
 * The breakpoint sits after the cluster roster rather than at the end, because
 * the roster is what repeats — it is identical for every submission against a
 * given category snapshot, while the product is different every time. This is the
 * one prompt in the engine where a cross-submission cache hit is actually
 * plausible.
 *
 * ## Untrusted text
 *
 * The new product's name and description are UNTRUSTED (Global Constraint 2) and
 * so are the cluster labels and member names — those were produced by a model
 * from untrusted copy in the first place. All of it is sanitized, truncated and
 * wrapped in `<<< >>>`; nothing here is INSTRUCTIONS.
 *
 * Nothing in this file produces or sees a rank (Global Constraint 1).
 */

import type Anthropic from '@anthropic-ai/sdk';

import { LABEL_LIMIT, MAX_TOKENS_ASSIGN, MODEL_CLUSTER, SANITIZE_LIMIT } from '../../config/constants.js';
import { sanitize } from '../../ingest/sanitize.js';
import type { Effort, ModelRequest } from '../../model/types.js';
import { RAW_SCORE_MAX, RAW_SCORE_MIN } from '../../rank/stats.js';
import type { Cluster, ClusterId, Product } from '../../types.js';
import { dataBlock, dataField, dataValue, UNTRUSTED_DATA_RULE } from '../data-block.js';
import { SchemaValidationError } from '../schemas.js';

/** `01 §5.2`'s clustering effort, honoured — this runs on `claude-sonnet-5`. */
const ASSIGN_EFFORT: Effort = 'medium';

/** Forced tool for the incremental cluster assignment. */
export const ASSIGN_TOOL_NAME = 'submit_assignment';

/**
 * `ASSIGN_SCHEMA`: `{cluster_id?, new_cluster_label?, uniqueness_score, reason}`.
 *
 * `cluster_id` and `new_cluster_label` are both optional in the SHAPE because
 * exactly one of them must be present, which JSON Schema's supported subset here
 * cannot say. `validateAssignResult` enforces the exclusivity, the same division
 * of labour the other three panels use (`src/panels/schemas.ts`): `strict: true`
 * guarantees the shape, TypeScript guarantees the rules.
 */
export const ASSIGN_SCHEMA: Anthropic.Tool = {
  name: ASSIGN_TOOL_NAME,
  description:
    'Place the new product: either name an existing cluster it belongs to, or open exactly one new cluster for it. Never both.',
  input_schema: {
    type: 'object',
    properties: {
      cluster_id: {
        type: 'string',
        description:
          'The id of the EXISTING cluster this product joins, copied exactly from the list. Omit it if you are opening a new cluster.',
      },
      new_cluster_label: {
        type: 'string',
        description: `A short neutral name for a NEW cluster, ${LABEL_LIMIT} characters or fewer. Set it only when no existing cluster fits, and then omit cluster_id.`,
      },
      uniqueness_score: {
        type: 'integer',
        description:
          'Scarcity of this product’s idea, a whole number from 0 to 100. 100 = rare or novel, 50 = familiar with a few peers, 0 = crowded commodity. Not a quality score.',
      },
      reason: {
        type: 'string',
        description: 'Why this placement and this scarcity score, in 20 words or fewer.',
      },
    },
    required: ['uniqueness_score', 'reason'],
    additionalProperties: false,
  },
};

const ASSIGN_TASK = `You are placing ONE new product into a category whose products have already been grouped by idea.

You never rank, order, or say which product is best, and scarcity is not a verdict on any product.
The ranking is computed elsewhere by arithmetic you are not part of.

${UNTRUSTED_DATA_RULE}

## Your two jobs

1. **Place it.** Decide whether the new product's core idea is essentially the same as an existing
   cluster's. If it is, answer with that cluster's id, copied exactly. If no existing cluster is a
   real match, open exactly one new cluster and give it a short neutral label.

   The existing clusters are FIXED. You cannot rename them, merge them, split them, move any
   existing product between them, or propose a different grouping. The only thing you decide is
   where this one new product goes. "Essentially the same idea" means a buyer shopping for one
   would seriously consider the other — not merely the same broad market or the same buyer.

2. **Score its scarcity, 0-100.** How rare the IDEA is, not how good the product is:
   - 100 — you know of no close analogue, inside this category or outside it.
   - 50 — familiar, with a few peers.
   - 0 — a crowded commodity with many interchangeable versions.
   Judge from the peers you were shown AND from what you know of the wider market. A product that
   joins a large existing cluster is by definition not scarce.

Give a reason of 20 words or fewer for the placement and the score together.`;

/** The existing roster, as DATA. Labels and member names came from untrusted copy. */
function renderClusters(clusters: readonly Cluster[], products: ReadonlyMap<number, Product>): string {
  if (clusters.length === 0) {
    return [
      '## EXISTING CLUSTERS',
      '',
      'There are none yet. Open a new cluster for this product.',
    ].join('\n');
  }

  const lines = clusters.flatMap((cluster) => {
    const members = cluster.member_ids
      .map((id) => products.get(id))
      .filter((product): product is Product => product !== undefined)
      .map((product) => dataValue(sanitize(product.name, SANITIZE_LIMIT)));

    return [
      `[cluster_id ${dataValue(cluster.cluster_id)}]`,
      `  ${dataField('label', cluster.label)}`,
      `  members (${cluster.member_ids.length}): ${members.length === 0 ? '(none resolvable)' : members.join(' | ')}`,
      '',
    ];
  });

  return [
    '## EXISTING CLUSTERS',
    '',
    'These are the groups this category already has. Copy an id exactly if the new product joins one.',
    '',
    dataBlock(lines),
  ].join('\n');
}

/** The one product being placed, as DATA. */
function renderNewProduct(product: Product): string {
  return [
    '## THE NEW PRODUCT',
    '',
    `Place this product, and only this product. Its id is ${product.id}.`,
    '',
    dataBlock([
      `[id ${product.id}]`,
      `  ${dataField('name', product.name)}`,
      `  ${dataField('description', product.description)}`,
    ]),
  ].join('\n');
}

export interface AssignRequestInput {
  /** The product being placed. */
  product: Product;
  /** The category's existing clusters. Fixed — `brief §1.5`'s append-only rule. */
  clusters: readonly Cluster[];
  /** The existing products, for resolving member names. */
  products: readonly Product[];
}

/** Build the incremental cluster-assignment call. */
export function buildAssignRequest(input: AssignRequestInput): ModelRequest {
  const byId = new Map(input.products.map((product) => [product.id, product]));

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: ASSIGN_TASK },
    { type: 'text', text: renderClusters(input.clusters, byId) },
    { type: 'text', text: renderNewProduct(input.product) },
  ];

  return {
    model: MODEL_CLUSTER,
    system,
    messages: [
      {
        role: 'user',
        content: `Place product ${input.product.id} and score its scarcity now, by calling \`${ASSIGN_TOOL_NAME}\`.`,
      },
    ],
    tools: [ASSIGN_SCHEMA],
    toolName: ASSIGN_TOOL_NAME,
    maxTokens: MAX_TOKENS_ASSIGN,
    effort: ASSIGN_EFFORT,
    // After the roster, not at the end: the roster is what repeats across
    // submissions against one category snapshot. See the header.
    cacheBreakpoint: 1,
  };
}

/** A validated placement: either an existing cluster or exactly one new one. */
export interface Assignment {
  /** Present when the product joined an existing cluster. */
  cluster_id?: ClusterId;
  /** Present when it opened a new one. Truncated to `LABEL_LIMIT`. */
  new_cluster_label?: string;
  uniqueness_score: number;
  reason: string;
}

/**
 * Check an assignment against the roster it was shown.
 *
 * Fails loudly on the two answers that would break `brief §1.5`: a `cluster_id`
 * that is not one of the existing clusters (which would invent a cluster id, and
 * with it a set of demand votes that never happened), and an answer that does
 * both or neither.
 */
export function validateAssignResult(output: unknown, existingIds: ReadonlySet<ClusterId>): Assignment {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new SchemaValidationError('assignment response: expected an object');
  }
  const root = output as Record<string, unknown>;

  const rawClusterId = root['cluster_id'];
  const rawLabel = root['new_cluster_label'];
  const hasClusterId = typeof rawClusterId === 'string' && rawClusterId !== '';
  const hasLabel = typeof rawLabel === 'string' && rawLabel !== '';

  if (hasClusterId && hasLabel) {
    throw new SchemaValidationError(
      'assignment response: returned both cluster_id and new_cluster_label; a product joins an existing cluster or opens one, never both',
    );
  }
  if (!hasClusterId && !hasLabel) {
    throw new SchemaValidationError(
      'assignment response: returned neither cluster_id nor new_cluster_label; the product must be placed somewhere',
    );
  }
  if (hasClusterId && !existingIds.has(rawClusterId)) {
    throw new SchemaValidationError(
      `assignment response: cluster_id ${JSON.stringify(rawClusterId)} is not one of the existing clusters. ` +
        'Clusters are append-only (brief §1.5) — an invented id would carry demand votes that were never cast.',
    );
  }

  const score = root['uniqueness_score'];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < RAW_SCORE_MIN || score > RAW_SCORE_MAX) {
    throw new SchemaValidationError(
      `assignment response: uniqueness_score must be a whole number from ${RAW_SCORE_MIN} to ${RAW_SCORE_MAX}, got ${JSON.stringify(score)}`,
    );
  }

  const reason = root['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new SchemaValidationError('assignment response: reason must be a non-empty string');
  }

  const assignment: Assignment = { uniqueness_score: score, reason };
  if (hasClusterId) assignment.cluster_id = rawClusterId;
  // Truncated exactly as `01 §8` truncates model-produced labels, and for the
  // same reason: this label is derived from untrusted copy and is rendered back
  // into the customer-demand prompt.
  else assignment.new_cluster_label = sanitize(rawLabel as string, LABEL_LIMIT);

  return assignment;
}
