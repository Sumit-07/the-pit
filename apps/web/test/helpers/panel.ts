/**
 * An offline panel that answers whatever it was shown. Not a test file —
 * `vitest.config.ts` collects only `test/**\/*.test.ts`.
 *
 * Global Constraint 5, restated for this package: the whole suite runs with no
 * network, no database and no API key. Every run below goes through the engine's
 * `FixtureClient`, which replays recorded JSON and records the requests it was
 * handed — so a test can assert both what the pipeline SENT and what it did with
 * what came back.
 *
 * The resolver answers by reading what each request actually asked for: which
 * tool it forced, and which `[id N]` markers appear in its last system block.
 * Keying on call index instead would pin the fixtures to a chunking the pipeline
 * happens to use today, and a test asserting the fan-out would be asserting
 * against itself.
 *
 * These are deliberately NOT the engine's own `test/helpers/run-fixtures.ts`:
 * that file lives outside the engine's published entry point, and reaching into
 * another package's test directory would make this suite depend on a path the
 * engine is free to move. Everything here imports from `@the-pit/engine`.
 */

import {
  ASSIGN_TOOL_NAME,
  CHOICE_TOOL_NAME,
  JUROR_COUNT,
  SCORE_TOOL_NAME,
  UNIQ_TOOL_NAME,
  categorySlug,
  type FixtureResponse,
  type Jury,
  type JurorMandate,
  type ModelRequest,
  type PersonaPanel,
  type Product,
  type RubricMetric,
} from '@the-pit/engine';

export const CATEGORY = 'Health, Fitness & Wellness';
export const CATEGORY_SLUG = categorySlug(CATEGORY);
export const CATEGORY_VERSION = 'cat-v1';
export const PROMPT_VERSION = 'jury-v1';
export const PERSONA_VERSION = 'personas-v1';

/** A category of `n` products with ids `0..n-1` — incoming leaderboard order. */
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
    anchors: {
      '100': 'Nothing to fix.',
      '80': 'Solid, one rough edge.',
      '50': 'Obviously unfinished.',
      '20': 'Barely holds together.',
    },
  },
  {
    name: 'Utility',
    description: 'How much real work it takes off someone.',
    anchors: {
      '100': 'Removes a whole chore.',
      '80': 'Saves real time.',
      '50': 'Helps a little.',
      '20': 'Nobody was struggling.',
    },
  },
  {
    name: 'Clarity',
    description: 'How quickly a stranger understands what it is.',
    anchors: {
      '100': 'One sentence and you know.',
      '80': 'Clear after a short read.',
      '50': 'You have to work for it.',
      '20': 'Could be anything.',
    },
  },
];

export const METRIC_NAMES = METRICS.map((metric) => metric.name);

/** Exactly `JUROR_COUNT` jurors — `DECISIONS.md` S1's Six. */
export const JURORS: JurorMandate[] = Array.from({ length: JUROR_COUNT }, (_, index) => ({
  role: `Juror ${index + 1}`,
  who: `Spent ${index + 4} years shipping things people paid for.`,
  cares_most: 'Whether it survives a real workday.',
  biased_against: 'Demos that only work on the happy path.',
  voice: 'Flat, specific, allergic to adjectives.',
  weights: { Craft: 1, Utility: 2, Clarity: 0.5 },
}));

export function makeJury(promptVersion: string = PROMPT_VERSION): Jury {
  return { type: 'consumer', prompt_version: promptVersion, metrics: METRICS, jurors: JURORS };
}

/** Four personas. Chosen so the Floor's call count is distinguishable from the jury's six. */
export function makePanel(personaVersion: string = PERSONA_VERSION): PersonaPanel {
  return {
    persona_version: personaVersion,
    personas: Array.from({ length: 4 }, (_, index) => ({
      name: `Persona ${index + 1}`,
      description: `Runs a small thing out of a spare room, year ${index + 1}.`,
      needs: ['Works the first evening', 'No seat minimums'],
      price_sensitivity: index % 2 === 0 ? ('high' as const) : ('medium' as const),
    })),
  };
}

/** The `[id N]` markers in a request's product/sets block, in render order. */
export function idsShown(request: ModelRequest): number[] {
  const last = request.system[request.system.length - 1];
  if (last === undefined) return [];
  return [...last.text.matchAll(/\[id (\d+)\]/g)].map((match) => Number(match[1]));
}

/**
 * A well-formed scoring answer for exactly the ids the juror was shown.
 *
 * `01 §5.1` requires deductions to sum to exactly `100 - score`, and
 * `validateScoreResult` enforces it — a fixture that got this wrong would put
 * every test on the schema-failure path instead of the one it means to exercise.
 */
export function scoreAnswer(ids: readonly number[]): unknown {
  return {
    scores: ids.map((id) => ({
      id,
      metrics: METRIC_NAMES.map((name, metricIndex) => {
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
export type ClusterPlan = 'pairs' | 'all-solo';

/**
 * A well-formed uniqueness answer covering exactly the ids it was shown.
 *
 * `all-solo` is the `DECISIONS.md` S11 case: every cluster holds one product, so
 * `01 §5.3`'s gate closes and the Floor legitimately never convenes.
 */
export function uniquenessAnswer(ids: readonly number[], plan: ClusterPlan = 'pairs'): unknown {
  const sorted = [...ids].sort((a, b) => a - b);
  const groups = new Map<string, number[]>();

  for (const [index, id] of sorted.entries()) {
    const key = plan === 'all-solo' ? `solo-${id}` : `pair-${Math.floor(index / 2)}`;
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
  const text = request.system[request.system.length - 1]?.text ?? '';
  const blocks = [...text.matchAll(/\[set ([^\]]+)\]([\s\S]*?)(?=\n\[set |$)/g)];

  return {
    choices: blocks.map((block) => {
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
    }),
  };
}

/**
 * The answer the incremental PLACEMENT call gives — `brief §1.5`'s two legal
 * shapes and nothing else.
 *
 * `JOIN_EXISTING` names a cluster the seeded category really has, so the product
 * lands in a set of three and the Floor re-votes on that one set. `OPEN_NEW`
 * gives a label instead, so the product opens a cluster of its own, no set's
 * membership moves, and the Floor never convenes — `DECISIONS.md` S11's terminal,
 * SUCCESSFUL status, not a partial run.
 */
export const JOIN_EXISTING = {
  cluster_id: 'pair-0',
  uniqueness_score: 35,
  reason: 'several tools already do this',
};

export const OPEN_NEW = {
  new_cluster_label: 'Meeting action lists',
  uniqueness_score: 88,
  reason: 'no close analogue',
};

/** How the fixture panel should behave. Every field defaults to "answers correctly". */
export interface ScriptOptions {
  clusterPlan?: ClusterPlan;
  /** The placement answer. Defaults to joining `pair-0`. */
  assignAnswer?: unknown;
  /** Make the placement call fail, with this error. */
  assignError?: () => Error;
  /** Make the clustering pass fail, with this error. */
  uniquenessError?: () => Error;
  /** Make every persona call fail, with this error. */
  personaError?: () => Error;
  /** Make every scoring call fail, with this error. */
  scoreError?: () => Error;
  usage?: FixtureResponse['usage'];
}

/**
 * A fixture panel that answers whatever it was shown.
 *
 * Throws for a configured failure, which is what a real adapter does — a throw in
 * the resolver surfaces through `dispatch`'s catch exactly as a rejected
 * `complete()` would.
 */
export function makeScript(options: ScriptOptions = {}): (request: ModelRequest) => FixtureResponse {
  const usage = options.usage ?? { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 };

  return (request: ModelRequest): FixtureResponse => {
    switch (request.toolName) {
      case SCORE_TOOL_NAME: {
        if (options.scoreError !== undefined) throw options.scoreError();
        return { output: scoreAnswer(idsShown(request)), usage, model: 'claude-haiku-4-5' };
      }
      case UNIQ_TOOL_NAME: {
        if (options.uniquenessError !== undefined) throw options.uniquenessError();
        return {
          output: uniquenessAnswer(idsShown(request), options.clusterPlan ?? 'pairs'),
          usage,
          model: 'claude-sonnet-5',
        };
      }
      case CHOICE_TOOL_NAME: {
        if (options.personaError !== undefined) throw options.personaError();
        return { output: choiceAnswer(request), usage, model: 'claude-sonnet-5' };
      }
      case ASSIGN_TOOL_NAME: {
        if (options.assignError !== undefined) throw options.assignError();
        return { output: options.assignAnswer ?? JOIN_EXISTING, usage, model: 'claude-sonnet-5' };
      }
      default:
        throw new Error(`fixture: no answer for tool ${request.toolName}`);
    }
  };
}
