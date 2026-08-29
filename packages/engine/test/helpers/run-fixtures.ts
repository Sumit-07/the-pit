/**
 * Fixtures for the orchestrator tests. Not a test file — `vitest.config.ts`
 * collects only `test/**\/*.test.ts`.
 *
 * The resolver below answers a request by reading what the request ACTUALLY
 * asked for: which tool it forced, and which `[id N]` markers appear in its last
 * system block (the products / sets block every prompt builder puts there). That
 * matters more than it sounds. A fixture keyed on call index would answer a
 * chunk-2 request with chunk-1's ids and the schema validator would reject it —
 * so the fixtures would be pinned to a chunking the orchestrator happens to use
 * today, and a test asserting the CHUNKING would be asserting against itself.
 * Reading the ids back out means the fixture panel answers whatever it was shown,
 * exactly as a real panel does, and the chunk-composition assertions stay honest.
 */

import { JUROR_COUNT } from '../../src/config/constants.js';
import type { FixtureResponse } from '../../src/model/fixture-client.js';
import type { ModelRequest } from '../../src/model/types.js';
import { ASSIGN_TOOL_NAME } from '../../src/panels/prompts/assign.js';
import { CHOICE_TOOL_NAME, SCORE_TOOL_NAME, UNIQ_TOOL_NAME } from '../../src/panels/schemas.js';
import type { Jury, JurorMandate, PersonaPanel, Product, RubricMetric } from '../../src/types.js';

export const CATEGORY = 'Health, Fitness & Wellness';
export const CATEGORY_VERSION = 'v7';

/** A category of `n` products with ids 0..n-1 — i.e. incoming leaderboard order. */
export function makeProducts(n: number): Product[] {
  return Array.from({ length: n }, (_, id) => ({
    id,
    name: `Product ${id}`,
    description: `A tool that helps someone do task number ${id} without a spreadsheet.`,
    url: `https://example.com/${id}`,
    normalized_url: `example.com/${id}`,
    orig_rank: id + 1,
  }));
}

export const METRICS: RubricMetric[] = [
  {
    name: 'Craft',
    description: 'How well the thing is actually built and finished.',
    anchors: { '100': 'Nothing to fix.', '80': 'Solid, one rough edge.', '50': 'Obviously unfinished.', '20': 'Barely holds together.' },
  },
  {
    name: 'Utility',
    description: 'How much real work it takes off someone.',
    anchors: { '100': 'Removes a whole chore.', '80': 'Saves real time.', '50': 'Helps a little.', '20': 'Nobody was struggling.' },
  },
  {
    name: 'Clarity',
    description: 'How quickly a stranger understands what it is.',
    anchors: { '100': 'One sentence and you know.', '80': 'Clear after a short read.', '50': 'You have to work for it.', '20': 'Could be anything.' },
  },
];

export const METRIC_NAMES = METRICS.map((metric) => metric.name);

/** Exactly `JUROR_COUNT` jurors, per `DECISIONS.md` S1. */
export const JURORS: JurorMandate[] = Array.from({ length: JUROR_COUNT }, (_, index) => ({
  role: `Juror ${index + 1}`,
  who: `Spent ${index + 4} years shipping things people paid for.`,
  cares_most: 'Whether it survives a real workday.',
  biased_against: 'Demos that only work on the happy path.',
  voice: 'Flat, specific, allergic to adjectives.',
  weights: { Craft: 1, Utility: 2, Clarity: 0.5 },
}));

export const JURY: Jury = {
  type: 'consumer',
  prompt_version: 'jury-v1',
  metrics: METRICS,
  jurors: JURORS,
};

export const PANEL: PersonaPanel = {
  persona_version: 'personas-v1',
  personas: Array.from({ length: 4 }, (_, index) => ({
    name: `Persona ${index + 1}`,
    description: `Runs a small thing out of a spare room, year ${index + 1}.`,
    needs: ['Works the first evening', 'No seat minimums'],
    price_sensitivity: index % 2 === 0 ? ('high' as const) : ('medium' as const),
  })),
};

/** The `[id N]` markers in a request's product/sets block, in render order. */
export function idsShown(request: ModelRequest): number[] {
  const last = request.system[request.system.length - 1];
  if (last === undefined) return [];
  return [...last.text.matchAll(/\[id (\d+)\]/g)].map((match) => Number(match[1]));
}

/**
 * A well-formed scoring answer for exactly the ids the juror was shown.
 * `score` is derived from the id so every product gets a different number and
 * `discrimination` is non-zero; deductions sum to exactly `100 - score`, which
 * `01 §5.1` requires and `validateScoreResult` enforces.
 */
export function scoreAnswer(ids: readonly number[], metricNames: readonly string[] = METRIC_NAMES): unknown {
  return {
    scores: ids.map((id) => ({
      id,
      metrics: metricNames.map((name, metricIndex) => {
        const score = 100 - ((id * 7 + metricIndex * 11) % 60);
        return {
          name,
          score,
          deductions: score === 100 ? [] : [{ points: 100 - score, reason: `thin evidence for ${name}` }],
        };
      }),
    })),
  };
}

/** How the fixture clustering pass should group the category. */
export type ClusterPlan = 'pairs' | 'all-solo' | 'one-big';

/** A well-formed uniqueness answer covering exactly the ids it was shown. */
export function uniquenessAnswer(ids: readonly number[], plan: ClusterPlan = 'pairs'): unknown {
  const groups = new Map<string, number[]>();
  const sorted = [...ids].sort((a, b) => a - b);

  for (const [index, id] of sorted.entries()) {
    const key =
      plan === 'all-solo' ? `solo-${id}` : plan === 'one-big' ? 'everything' : `pair-${Math.floor(index / 2)}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }

  const clusterOf = new Map<number, string>();
  for (const [key, members] of groups) for (const id of members) clusterOf.set(id, key);

  return {
    clusters: [...groups.entries()].map(([cluster_id, member_ids]) => ({
      cluster_id,
      label: `Things like ${member_ids[0]}`,
      member_ids,
    })),
    products: sorted.map((id) => ({
      id,
      uniqueness_score: 30 + ((id * 13) % 60),
      cluster_id: clusterOf.get(id) ?? 'everything',
      reason: `a handful of comparable tools exist for ${id}`,
    })),
  };
}

/** A well-formed choice answer: first pick is the lowest-id member of each set. */
export function choiceAnswer(request: ModelRequest): unknown {
  const last = request.system[request.system.length - 1];
  const text = last?.text ?? '';
  const blocks = [...text.matchAll(/\[set ([^\]]+)\]([\s\S]*?)(?=\n\[set |$)/g)];

  const choices = blocks.map((block) => {
    const clusterId = (block[1] ?? '').replaceAll('"', '').trim();
    const memberIds = [...(block[2] ?? '').matchAll(/\[id (\d+)\]/g)].map((match) => Number(match[1]));
    const [first, second] = [...memberIds].sort((a, b) => a - b);
    const choice: Record<string, unknown> = {
      cluster_id: clusterId,
      reason: 'closest to what I already do every week',
      strength: 70,
    };
    if (first !== undefined) choice['first_pick'] = first;
    if (second !== undefined) choice['second_pick'] = second;
    return choice;
  });

  return { choices };
}

/** How the fixture panel should behave. Every field defaults to "answers correctly". */
export interface ScriptOptions {
  clusterPlan?: ClusterPlan;
  /**
   * Juror roles that answer with an EMPTY score list — structurally a valid
   * response, containing nothing. That is what "a juror returned nothing" looks
   * like in practice, and it is more discriminating than a thrown error: it goes
   * through `validateScoreResult`, so it exercises the schema-failure path and
   * the coverage audit together.
   */
  silentJurors?: readonly string[];
  /** Make the clustering pass fail, with this error. */
  uniquenessError?: () => Error;
  /** Make every persona call fail, with this error. */
  personaError?: () => Error;
  /** Token usage attributed to each answered call. */
  usage?: FixtureResponse['usage'];
  /**
   * Override the model id every answer reports. Task 9's handoff adapter cannot
   * report a priced id at all, so this is how a test reaches the unpriced path.
   */
  modelId?: string;
  /** Answer for the incremental placement call. */
  assignAnswer?: unknown;
}

/**
 * A fixture panel that answers whatever it was shown.
 *
 * Throws for a configured failure, which is what a real adapter does — the
 * `FixtureClient` resolver is synchronous, so a throw here surfaces through
 * `dispatch`'s catch exactly as a rejected `complete()` would.
 */
export function makeScript(options: ScriptOptions = {}): (request: ModelRequest) => FixtureResponse {
  const usage = options.usage ?? { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 };
  const haiku = options.modelId ?? 'claude-haiku-4-5';
  const sonnet = options.modelId ?? 'claude-sonnet-5';

  return (request: ModelRequest): FixtureResponse => {
    switch (request.toolName) {
      case SCORE_TOOL_NAME: {
        const mandate = request.messages[0]?.content;
        const role = typeof mandate === 'string' ? (/You are (Juror \d+)\./.exec(mandate)?.[1] ?? '') : '';
        if (options.silentJurors?.includes(role) === true) {
          return { output: { scores: [] }, usage, model: haiku };
        }
        return { output: scoreAnswer(idsShown(request)), usage, model: haiku };
      }
      case UNIQ_TOOL_NAME: {
        if (options.uniquenessError !== undefined) throw options.uniquenessError();
        return {
          output: uniquenessAnswer(idsShown(request), options.clusterPlan ?? 'pairs'),
          usage,
          model: sonnet,
        };
      }
      case CHOICE_TOOL_NAME: {
        if (options.personaError !== undefined) throw options.personaError();
        return { output: choiceAnswer(request), usage, model: sonnet };
      }
      case ASSIGN_TOOL_NAME:
        return { output: options.assignAnswer ?? {}, usage, model: sonnet };
      default:
        throw new Error(`fixture: no answer for tool ${request.toolName}`);
    }
  };
}
