/**
 * The three panel output schemas (`01 §5`) as strict tool definitions, plus the
 * validators that check a response against them and fail loudly.
 *
 * ## Why tools rather than `output_format`
 *
 * Structured output is requested by forcing a tool call. Each tool carries
 * `strict: true` at the top level (set in `buildMessageParams`, alongside
 * `name` / `description` / `input_schema` — never on `tool_choice`), every object
 * sets `additionalProperties: false`, and every non-optional property is listed
 * in `required`. The deprecated `output_format` parameter is not used anywhere.
 *
 * ## Why there are still validators
 *
 * `strict: true` guarantees the SHAPE. It cannot express the rules that actually
 * matter here, because the supported JSON Schema subset has no numeric
 * constraints (`minimum` / `maximum` are unsupported and would be stripped) and
 * no way to say "these ids and no others" or "these numbers must sum to exactly
 * 100 minus that one". Those are `01 §5.1`'s arithmetic law, the completeness
 * rules, and the `§1.1` rule that calibration peers are never re-scored — all of
 * them checked here, in TypeScript, against the set the caller actually asked
 * about. Ranges appear in the schema descriptions so the model is told, and are
 * enforced here so a violation cannot reach the ranking math.
 *
 * A validator throwing is a malformed panel response: `brief §2.3` classifies
 * that as a failure to retry, not something to paper over with a default.
 */

import type Anthropic from '@anthropic-ai/sdk';

import { LABEL_LIMIT } from '../config/constants.js';
import { RAW_SCORE_MAX, RAW_SCORE_MIN } from '../rank/stats.js';
import { dataValue } from './data-block.js';
import type { Cluster, ClusterId, DemandChoice, Deduction, MetricScore, ScoreRow, UniquenessProduct, UniquenessResult } from '../types.js';

/** A panel response that does not satisfy its schema or `01 §5`'s rules. */
export class SchemaValidationError extends Error {
  override readonly name = 'SchemaValidationError';
}

// --- Tool definitions ---------------------------------------------------------

/** Forced tool for the merit jury (`01 §5.1`). */
export const SCORE_TOOL_NAME = 'submit_scores';

/** Forced tool for the uniqueness / clustering pass (`01 §5.2`). */
export const UNIQ_TOOL_NAME = 'submit_uniqueness';

/** Forced tool for the customer-demand panel (`01 §5.3`). */
export const CHOICE_TOOL_NAME = 'submit_choices';

/**
 * `SCORE_SCHEMA` (`01 §5.1`):
 * `{scores:[{id, note?, metrics:[{name, score, deductions:[{points, reason}]}]}]}`
 */
export const SCORE_SCHEMA: Anthropic.Tool = {
  name: SCORE_TOOL_NAME,
  description:
    'Submit your scores. Include every product you were asked to score, exactly once, and every metric in the rubric for each product.',
  input_schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        description: 'One entry per product you were asked to score.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              description: 'The id of the product, copied exactly from the list you were given.',
            },
            note: {
              type: 'string',
              description: 'Optional. One short sentence about the product overall. Omit if you have nothing to add.',
            },
            metrics: {
              type: 'array',
              description: 'One entry per metric in the rubric. Every metric, every time.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The rubric metric name, copied exactly.' },
                  score: {
                    type: 'integer',
                    description:
                      'The metric score, a whole number from 0 to 100. Must equal 100 minus the sum of the deductions listed here.',
                  },
                  deductions: {
                    type: 'array',
                    description:
                      'Every deduction you took off the starting 100 for this metric. Empty when the score is 100.',
                    items: {
                      type: 'object',
                      properties: {
                        points: {
                          type: 'integer',
                          description: 'Whole points deducted, 1 or more.',
                        },
                        reason: {
                          type: 'string',
                          description:
                            'Why, in 20 words or fewer. Name the concrete shortcoming, not the metric.',
                        },
                      },
                      required: ['points', 'reason'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['name', 'score', 'deductions'],
                additionalProperties: false,
              },
            },
          },
          required: ['id', 'metrics'],
          additionalProperties: false,
        },
      },
    },
    required: ['scores'],
    additionalProperties: false,
  },
};

/**
 * `UNIQ_SCHEMA` (`01 §5.2`):
 * `{clusters:[{cluster_id, label, member_ids:[…]}], products:[{id, uniqueness_score, cluster_id, reason}]}`
 */
export const UNIQ_SCHEMA: Anthropic.Tool = {
  name: UNIQ_TOOL_NAME,
  description:
    'Submit the clusters and the per-product scarcity scores. Every product appears in exactly one cluster and has exactly one score.',
  input_schema: {
    type: 'object',
    properties: {
      clusters: {
        type: 'array',
        description: 'The groups of products that share a core idea. A product with no peer is a cluster of one.',
        items: {
          type: 'object',
          properties: {
            cluster_id: {
              type: 'string',
              description: 'A short identifier of your own choosing, unique within this answer.',
            },
            label: {
              type: 'string',
              description: 'A short neutral name for the shared idea, 60 characters or fewer.',
            },
            member_ids: {
              type: 'array',
              description: 'The ids of the products in this cluster.',
              items: { type: 'integer' },
            },
          },
          required: ['cluster_id', 'label', 'member_ids'],
          additionalProperties: false,
        },
      },
      products: {
        type: 'array',
        description: 'One entry per product you were given.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The product id, copied exactly.' },
            uniqueness_score: {
              type: 'integer',
              description:
                'Scarcity, a whole number from 0 to 100. 100 = rare or novel, 50 = familiar with a few peers, 0 = crowded commodity. Not a quality score.',
            },
            cluster_id: {
              type: 'string',
              description: 'The id of the cluster this product belongs to. Must be one you declared above.',
            },
            reason: {
              type: 'string',
              description: 'Why this scarcity score, in 20 words or fewer. Name the analogue or the crowd.',
            },
          },
          required: ['id', 'uniqueness_score', 'cluster_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['clusters', 'products'],
    additionalProperties: false,
  },
};

/**
 * `CHOICE_SCHEMA` (`01 §5.3`):
 * `{choices:[{cluster_id, first_pick?, second_pick?, strength?, reason, none?}]}`
 * — `cluster_id` and `reason` required, everything else optional.
 */
export const CHOICE_SCHEMA: Anthropic.Tool = {
  name: CHOICE_TOOL_NAME,
  description: 'Submit one choice for each set you were shown. Answer every set exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      choices: {
        type: 'array',
        description: 'One entry per set.',
        items: {
          type: 'object',
          properties: {
            cluster_id: {
              type: 'string',
              description: 'The id of the set you are answering, copied exactly.',
            },
            first_pick: {
              type: 'integer',
              description:
                'The id you would actually adopt. Omit it only when you set none to true. Must be a product in this set.',
            },
            second_pick: {
              type: 'integer',
              description:
                'Optional runner-up: what you would take if your first pick did not exist. Omit if there is no real runner-up. Must be a product in this set and not your first pick.',
            },
            strength: {
              type: 'integer',
              description:
                'How strongly you back your first pick, a whole number from 0 to 100. 100 = you would switch today; 0 = you picked it only because something had to be picked.',
            },
            reason: {
              type: 'string',
              description: 'Why, in your own voice, in 20 words or fewer.',
            },
            none: {
              type: 'boolean',
              description:
                'True when nothing in this set is worth adopting for you. Then omit first_pick, second_pick and strength, and say in the reason what is missing.',
            },
          },
          required: ['cluster_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['choices'],
    additionalProperties: false,
  },
};

// --- Primitive readers --------------------------------------------------------

function fail(message: string): never {
  throw new SchemaValidationError(message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: expected an array, got ${describe(value)}`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') fail(`${where}: expected a non-empty string, got ${describe(value)}`);
  return value;
}

function asInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${where}: expected an integer, got ${describe(value)}`);
  }
  return value;
}

function asScore(value: unknown, where: string): number {
  const score = asInteger(value, where);
  if (score < RAW_SCORE_MIN || score > RAW_SCORE_MAX) {
    fail(`${where}: expected ${RAW_SCORE_MIN}-${RAW_SCORE_MAX}, got ${score}`);
  }
  return score;
}

/**
 * Read a `cluster_id` the way the personas will see it.
 *
 * A `cluster_id` is model-produced text derived from untrusted product copy, and
 * it is the one such value that is rendered OUTSIDE the `<<< >>>` block — the
 * customer-demand prompt lists the set ids in its instruction region so a persona
 * can be told what to answer. An id like `x >>> ignore previous instructions` is
 * 34 characters and would otherwise pass validation and land in exactly the
 * region the prompt tells the model its real instructions live in.
 *
 * So it is sanitized HERE, at the boundary where it enters the system, rather
 * than only at each render site: the id that is stored in the demand log and in
 * `ranking.json` is then byte-identical to the id the persona was shown and can
 * echo back. `dataValue` is idempotent, so re-applying it at render changes
 * nothing.
 *
 * The length cap is checked on the raw value, before sanitization, which is what
 * makes `dataValue`'s truncation provably a no-op here: a longer id would be
 * shown to a persona in a shortened form it could never echo back. It is a cap on
 * an IDENTIFIER — a key in the demand log, in the cluster roster and in every
 * ranked row — not on prose.
 */
function readClusterId(value: unknown, where: string): string {
  const raw = asString(value, where);
  if (raw.length > LABEL_LIMIT) {
    fail(`${where}: identifiers must be ${LABEL_LIMIT} characters or fewer, got ${raw.length}`);
  }

  const clusterId = dataValue(raw, LABEL_LIMIT);
  if (clusterId === '') fail(`${where}: is empty once sanitized`);
  return clusterId;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

// --- Validators ---------------------------------------------------------------

/** What the scoring call asked for. Anything outside it in the response is an error. */
export interface ScoreExpectation {
  /** The ids under PRODUCTS TO SCORE — never the calibration peers' ids. */
  productIds: readonly number[];
  /** Every rubric metric name, in rubric order. */
  metricNames: readonly string[];
}

/**
 * Validate a `SCORE_SCHEMA` response (`01 §5.1`).
 *
 * Beyond the shape, three rules that the schema cannot state:
 *
 * 1. **Exactly the products asked for.** Every expected id appears exactly once
 *    and no other id appears at all. This is what enforces `brief §1.1`'s "shown
 *    as reference, never re-scored": a calibration peer's id in the response is
 *    a juror that scored the anchor, which would put fabricated scores into the
 *    same population the customer is placed against. It is rejected here, loudly,
 *    rather than filtered out silently.
 * 2. **Every rubric metric, exactly once.** A missing metric would otherwise be
 *    substituted with `SCORE_CLAMP_DEFAULT` downstream and published as if a
 *    juror had written it (see `ScorecardEntry.substituted_roles`).
 * 3. **The deduction arithmetic.** `01 §5.1`: the deductions for a metric must
 *    sum to exactly `100 - score`, and a perfect metric is score 100 with an
 *    empty list. This is the rule that makes a scorecard auditable by the
 *    customer, so an off-by-five is a failed call, not a rounding difference.
 */
export function validateScoreResult(output: unknown, expected: ScoreExpectation): ScoreRow[] {
  const root = asRecord(output, 'score response');
  const rawScores = asArray(root['scores'], 'score response.scores');

  const expectedIds = new Set(expected.productIds);
  const seenIds = new Set<number>();
  const rows: ScoreRow[] = [];

  for (const [index, rawRow] of rawScores.entries()) {
    const where = `score response.scores[${index}]`;
    const row = asRecord(rawRow, where);
    const id = asInteger(row['id'], `${where}.id`);

    if (!expectedIds.has(id)) {
      fail(
        `${where}: product id ${id} was not in the set this juror was asked to score. ` +
          'Calibration peers are reference only and must never be scored (brief §1.1).',
      );
    }
    if (seenIds.has(id)) fail(`${where}: product id ${id} was scored more than once`);
    seenIds.add(id);

    const metrics = validateMetrics(row['metrics'], `${where}.metrics`, expected.metricNames);

    const scoreRow: ScoreRow = { id, metrics };
    const note = row['note'];
    if (note !== undefined && note !== null) scoreRow.note = asString(note, `${where}.note`);
    rows.push(scoreRow);
  }

  const missing = expected.productIds.filter((id) => !seenIds.has(id));
  if (missing.length > 0) {
    fail(`score response: no scores returned for product id(s) ${missing.join(', ')}`);
  }

  return rows;
}

function validateMetrics(value: unknown, where: string, metricNames: readonly string[]): MetricScore[] {
  const rawMetrics = asArray(value, where);
  const expectedNames = new Set(metricNames);
  const seen = new Set<string>();
  const metrics: MetricScore[] = [];

  for (const [index, rawMetric] of rawMetrics.entries()) {
    const at = `${where}[${index}]`;
    const metric = asRecord(rawMetric, at);
    const name = asString(metric['name'], `${at}.name`);

    if (!expectedNames.has(name)) fail(`${at}: ${JSON.stringify(name)} is not a metric in this rubric`);
    if (seen.has(name)) fail(`${at}: metric ${JSON.stringify(name)} was scored more than once`);
    seen.add(name);

    const score = asScore(metric['score'], `${at}.score`);
    const deductions = validateDeductions(metric['deductions'], `${at}.deductions`);

    const total = deductions.reduce((sum, deduction) => sum + deduction.points, 0);
    if (total !== RAW_SCORE_MAX - score) {
      fail(
        `${at}: deductions sum to ${total} but the score is ${score}; ` +
          `01 §5.1 requires them to sum to exactly ${RAW_SCORE_MAX - score}`,
      );
    }

    metrics.push({ name, score, deductions });
  }

  const missing = metricNames.filter((name) => !seen.has(name));
  if (missing.length > 0) fail(`${where}: no score returned for metric(s) ${missing.map((n) => JSON.stringify(n)).join(', ')}`);

  return metrics;
}

function validateDeductions(value: unknown, where: string): Deduction[] {
  const raw = asArray(value, where);
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`;
    const deduction = asRecord(entry, at);
    const points = asInteger(deduction['points'], `${at}.points`);
    if (points < 1 || points > RAW_SCORE_MAX) fail(`${at}.points: expected 1-${RAW_SCORE_MAX}, got ${points}`);
    return { points, reason: asString(deduction['reason'], `${at}.reason`) };
  });
}

/**
 * Validate a `UNIQ_SCHEMA` response (`01 §5.2`).
 *
 * The clustering pass answers twice about the same fact — once in
 * `products[].cluster_id` and once in `clusters[].member_ids` — and the two views
 * must agree. `clusterMembers` (`src/rank/demand.ts`) reconciles a disagreement
 * when it reads a stored run, which is the right behaviour for data already on
 * disk; it is not a licence to accept a self-contradicting response here. A
 * response where a product's own `cluster_id` differs from the cluster listing it
 * is a malformed answer, and the clusters are reused as the customer panel's
 * choice sets, so the contradiction would propagate into the demand pass.
 */
export function validateUniquenessResult(output: unknown, productIds: readonly number[]): UniquenessResult {
  const root = asRecord(output, 'uniqueness response');
  const rawClusters = asArray(root['clusters'], 'uniqueness response.clusters');
  const rawProducts = asArray(root['products'], 'uniqueness response.products');

  const expectedIds = new Set(productIds);
  const clusters: Cluster[] = [];
  const clusterIds = new Set<ClusterId>();
  const memberOf = new Map<number, ClusterId>();

  for (const [index, rawCluster] of rawClusters.entries()) {
    const where = `uniqueness response.clusters[${index}]`;
    const cluster = asRecord(rawCluster, where);
    const clusterId = readClusterId(cluster['cluster_id'], `${where}.cluster_id`);
    if (clusterIds.has(clusterId)) fail(`${where}: cluster_id ${JSON.stringify(clusterId)} was declared more than once`);
    clusterIds.add(clusterId);

    const label = asString(cluster['label'], `${where}.label`);
    const memberIds = asArray(cluster['member_ids'], `${where}.member_ids`).map((id, memberIndex) =>
      asInteger(id, `${where}.member_ids[${memberIndex}]`),
    );

    for (const id of memberIds) {
      if (!expectedIds.has(id)) fail(`${where}.member_ids: product id ${id} was not in the set`);
      const existing = memberOf.get(id);
      if (existing !== undefined) {
        fail(`${where}.member_ids: product id ${id} is already a member of cluster ${JSON.stringify(existing)}`);
      }
      memberOf.set(id, clusterId);
    }

    clusters.push({ cluster_id: clusterId, label, member_ids: memberIds });
  }

  const seen = new Set<number>();
  const products: UniquenessProduct[] = [];

  for (const [index, rawProduct] of rawProducts.entries()) {
    const where = `uniqueness response.products[${index}]`;
    const product = asRecord(rawProduct, where);
    const id = asInteger(product['id'], `${where}.id`);

    if (!expectedIds.has(id)) fail(`${where}: product id ${id} was not in the set`);
    if (seen.has(id)) fail(`${where}: product id ${id} appears more than once`);
    seen.add(id);

    const clusterId = readClusterId(product['cluster_id'], `${where}.cluster_id`);
    if (!clusterIds.has(clusterId)) {
      fail(`${where}.cluster_id: ${JSON.stringify(clusterId)} is not one of the declared clusters`);
    }

    const declared = memberOf.get(id);
    if (declared === undefined) {
      fail(`${where}: product id ${id} is not listed in any cluster's member_ids`);
    }
    if (declared !== clusterId) {
      fail(
        `${where}: product id ${id} says it is in cluster ${JSON.stringify(clusterId)} but is listed as a member of ` +
          `${JSON.stringify(declared)}`,
      );
    }

    products.push({
      id,
      uniqueness_score: asScore(product['uniqueness_score'], `${where}.uniqueness_score`),
      cluster_id: clusterId,
      reason: asString(product['reason'], `${where}.reason`),
    });
  }

  const missing = productIds.filter((id) => !seen.has(id));
  if (missing.length > 0) fail(`uniqueness response: no entry for product id(s) ${missing.join(', ')}`);

  return { clusters, products };
}

/**
 * Validate a `CHOICE_SCHEMA` response (`01 §5.3`).
 *
 * `sets` is the similar-app sets the persona was actually shown: clusters with
 * >= 2 members. A persona that answers about a set it was not shown, or picks an
 * id from another set, is not making a forced choice among near-substitutes,
 * which is the only thing the demand reduction in `01 §6.2` is entitled to read.
 *
 * `none: true` and a pick are mutually exclusive. `strength` may legitimately be
 * absent — `STRENGTH_DEFAULT` exists precisely for that case (`01 §7.1`) — so its
 * absence is not an error.
 */
export function validateChoiceResult(output: unknown, sets: ReadonlyMap<ClusterId, readonly number[]>): DemandChoice[] {
  const root = asRecord(output, 'choice response');
  const rawChoices = asArray(root['choices'], 'choice response.choices');

  const seen = new Set<ClusterId>();
  const choices: DemandChoice[] = [];

  for (const [index, rawChoice] of rawChoices.entries()) {
    const where = `choice response.choices[${index}]`;
    const raw = asRecord(rawChoice, where);
    const clusterId = readClusterId(raw['cluster_id'], `${where}.cluster_id`);

    const members = sets.get(clusterId);
    if (members === undefined) fail(`${where}: cluster_id ${JSON.stringify(clusterId)} was not one of the sets shown`);
    if (seen.has(clusterId)) fail(`${where}: cluster ${JSON.stringify(clusterId)} was answered more than once`);
    seen.add(clusterId);

    const memberSet = new Set(members);
    const choice: DemandChoice = { cluster_id: clusterId, reason: asString(raw['reason'], `${where}.reason`) };

    const none = raw['none'];
    if (none !== undefined && none !== null) {
      if (typeof none !== 'boolean') fail(`${where}.none: expected a boolean, got ${describe(none)}`);
      if (none) choice.none = true;
    }

    const firstPick = raw['first_pick'];
    const secondPick = raw['second_pick'];
    const strength = raw['strength'];

    if (choice.none === true) {
      if (firstPick != null || secondPick != null || strength != null) {
        fail(`${where}: none is true, so first_pick, second_pick and strength must be omitted`);
      }
      choices.push(choice);
      continue;
    }

    if (firstPick == null) fail(`${where}: a choice with no first_pick must set none to true`);
    const first = asInteger(firstPick, `${where}.first_pick`);
    if (!memberSet.has(first)) fail(`${where}.first_pick: ${first} is not a member of set ${JSON.stringify(clusterId)}`);
    choice.first_pick = first;

    if (secondPick != null) {
      const second = asInteger(secondPick, `${where}.second_pick`);
      if (!memberSet.has(second)) {
        fail(`${where}.second_pick: ${second} is not a member of set ${JSON.stringify(clusterId)}`);
      }
      if (second === first) fail(`${where}.second_pick: cannot be the same product as first_pick`);
      choice.second_pick = second;
    }

    if (strength != null) choice.strength = asScore(strength, `${where}.strength`);

    choices.push(choice);
  }

  const missing = [...sets.keys()].filter((clusterId) => !seen.has(clusterId));
  if (missing.length > 0) {
    fail(`choice response: no choice returned for set(s) ${missing.map((id) => JSON.stringify(id)).join(', ')}`);
  }

  return choices;
}
