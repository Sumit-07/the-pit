import { describe, expect, it } from 'vitest';

import {
  CHOICE_SCHEMA,
  SCORE_SCHEMA,
  SchemaValidationError,
  UNIQ_SCHEMA,
  validateChoiceResult,
  validateScoreResult,
  validateUniquenessResult,
} from '../../src/panels/index.js';

const METRIC_NAMES = ['Craft', 'Utility'];

function scoreRow(id: number, craft: number, utility: number): unknown {
  return {
    id,
    metrics: [
      { name: 'Craft', score: craft, deductions: craft === 100 ? [] : [{ points: 100 - craft, reason: 'rough edges' }] },
      { name: 'Utility', score: utility, deductions: utility === 100 ? [] : [{ points: 100 - utility, reason: 'narrow' }] },
    ],
  };
}

describe('tool definitions', () => {
  it.each([
    ['SCORE_SCHEMA', SCORE_SCHEMA],
    ['UNIQ_SCHEMA', UNIQ_SCHEMA],
    ['CHOICE_SCHEMA', CHOICE_SCHEMA],
  ])('%s closes every object and declares its required fields', (_name, tool) => {
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object') objects.push(record);
      Object.values(record).forEach(walk);
    };
    walk(tool.input_schema);

    expect(objects.length).toBeGreaterThan(0);
    for (const object of objects) {
      expect(object['additionalProperties']).toBe(false);
      expect(Array.isArray(object['required'])).toBe(true);
    }
  });

  it.each([
    ['SCORE_SCHEMA', SCORE_SCHEMA],
    ['UNIQ_SCHEMA', UNIQ_SCHEMA],
    ['CHOICE_SCHEMA', CHOICE_SCHEMA],
  ])('%s uses no unsupported numeric constraints', (_name, tool) => {
    // `minimum` / `maximum` are outside the supported JSON Schema subset for
    // structured output; ranges are stated in descriptions and enforced by the
    // validators instead.
    const serialised = JSON.stringify(tool.input_schema);
    expect(serialised).not.toContain('"minimum"');
    expect(serialised).not.toContain('"maximum"');
  });
});

describe('validateScoreResult', () => {
  const expected = { productIds: [0, 1], metricNames: METRIC_NAMES };

  it('accepts a well-formed response and keeps the optional note', () => {
    const output = { scores: [{ ...(scoreRow(0, 80, 100) as object), note: 'strong' }, scoreRow(1, 100, 60)] };

    const rows = validateScoreResult(output, expected);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.note).toBe('strong');
    expect(rows[1]?.note).toBeUndefined();
  });

  it('accepts a perfect metric as 100 with an empty deductions list (01 §5.1)', () => {
    const rows = validateScoreResult({ scores: [scoreRow(0, 100, 100), scoreRow(1, 100, 100)] }, expected);
    expect(rows[0]?.metrics[0]).toEqual({ name: 'Craft', score: 100, deductions: [] });
  });

  it('rejects deductions that do not sum to exactly (100 - score)', () => {
    const output = {
      scores: [
        { id: 0, metrics: [{ name: 'Craft', score: 80, deductions: [{ points: 15, reason: 'x' }] }, { name: 'Utility', score: 100, deductions: [] }] },
        scoreRow(1, 100, 100),
      ],
    };

    expect(() => validateScoreResult(output, expected)).toThrow(/sum to exactly 20/);
  });

  it('rejects a score of 100 that still carries a deduction', () => {
    const output = {
      scores: [
        { id: 0, metrics: [{ name: 'Craft', score: 100, deductions: [{ points: 5, reason: 'x' }] }, { name: 'Utility', score: 100, deductions: [] }] },
        scoreRow(1, 100, 100),
      ],
    };

    expect(() => validateScoreResult(output, expected)).toThrow(SchemaValidationError);
  });

  it('rejects a calibration peer’s id — reference peers are never re-scored (brief §1.1)', () => {
    const output = { scores: [scoreRow(0, 80, 80), scoreRow(1, 80, 80), scoreRow(42, 90, 90)] };

    expect(() => validateScoreResult(output, expected)).toThrow(/Calibration peers are reference only/);
  });

  it('rejects a product scored twice, and a product not scored at all', () => {
    expect(() => validateScoreResult({ scores: [scoreRow(0, 80, 80), scoreRow(0, 70, 70)] }, expected)).toThrow(/more than once/);
    expect(() => validateScoreResult({ scores: [scoreRow(0, 80, 80)] }, expected)).toThrow(/no scores returned for product id\(s\) 1/);
  });

  it('rejects a missing metric rather than letting a substituted 50 be published', () => {
    const output = {
      scores: [{ id: 0, metrics: [{ name: 'Craft', score: 80, deductions: [{ points: 20, reason: 'x' }] }] }, scoreRow(1, 100, 100)],
    };

    expect(() => validateScoreResult(output, expected)).toThrow(/no score returned for metric\(s\) "Utility"/);
  });

  it('rejects a metric name that is not in the rubric, and an out-of-range score', () => {
    const wrongMetric = { scores: [{ id: 0, metrics: [{ name: 'Vibes', score: 100, deductions: [] }] }, scoreRow(1, 100, 100)] };
    expect(() => validateScoreResult(wrongMetric, expected)).toThrow(/not a metric in this rubric/);

    const outOfRange = {
      scores: [
        { id: 0, metrics: [{ name: 'Craft', score: 120, deductions: [] }, { name: 'Utility', score: 100, deductions: [] }] },
        scoreRow(1, 100, 100),
      ],
    };
    expect(() => validateScoreResult(outOfRange, expected)).toThrow(/expected 0-100/);
  });

  it('rejects a response that is not the schema’s shape at all', () => {
    expect(() => validateScoreResult(null, expected)).toThrow(SchemaValidationError);
    expect(() => validateScoreResult({ scores: 'none' }, expected)).toThrow(SchemaValidationError);
  });
});

describe('validateUniquenessResult', () => {
  const ids = [0, 1, 2];
  const good = {
    clusters: [
      { cluster_id: 'c1', label: 'meeting notes', member_ids: [0, 1] },
      { cluster_id: 'c2', label: 'database tooling', member_ids: [2] },
    ],
    products: [
      { id: 0, uniqueness_score: 30, cluster_id: 'c1', reason: 'many close peers' },
      { id: 1, uniqueness_score: 25, cluster_id: 'c1', reason: 'crowded space' },
      { id: 2, uniqueness_score: 70, cluster_id: 'c2', reason: 'few analogues' },
    ],
  };

  it('accepts a well-formed response', () => {
    const result = validateUniquenessResult(good, ids);
    expect(result.clusters).toHaveLength(2);
    expect(result.products.map((product) => product.uniqueness_score)).toEqual([30, 25, 70]);
  });

  it('rejects a product whose cluster_id disagrees with the cluster listing it', () => {
    const contradictory = { ...good, products: [{ ...good.products[0], cluster_id: 'c2' }, ...good.products.slice(1)] };
    expect(() => validateUniquenessResult(contradictory, ids)).toThrow(/is listed as a member of/);
  });

  it('rejects a product in two clusters, and a product in none', () => {
    const twice = {
      ...good,
      clusters: [good.clusters[0], { cluster_id: 'c2', label: 'x', member_ids: [0, 2] }],
    };
    expect(() => validateUniquenessResult(twice, ids)).toThrow(/already a member of/);

    const orphan = { ...good, clusters: [{ cluster_id: 'c1', label: 'x', member_ids: [0, 1] }] };
    expect(() => validateUniquenessResult(orphan, ids)).toThrow(SchemaValidationError);
  });

  it('rejects an over-long cluster_id — it would not survive being shown back to a persona', () => {
    const long = 'c'.repeat(61);
    const output = {
      clusters: [{ cluster_id: long, label: 'x', member_ids: [0, 1, 2] }],
      products: good.products.map((product) => ({ ...product, cluster_id: long })),
    };
    expect(() => validateUniquenessResult(output, ids)).toThrow(/60 characters or fewer/);
  });

  it('rejects a cluster_id no cluster declared', () => {
    const dangling = {
      clusters: [{ cluster_id: 'c1', label: 'x', member_ids: [0, 1, 2] }],
      products: good.products.map((product) => ({ ...product, cluster_id: 'ghost' })),
    };
    expect(() => validateUniquenessResult(dangling, ids)).toThrow(/not one of the declared clusters/);
  });

  it('rejects an unknown product id and a missing one', () => {
    const stranger = { ...good, products: [...good.products, { id: 9, uniqueness_score: 50, cluster_id: 'c1', reason: 'x' }] };
    expect(() => validateUniquenessResult(stranger, ids)).toThrow(/was not in the set/);

    expect(() => validateUniquenessResult(good, [0, 1, 2, 3])).toThrow(/no entry for product id\(s\) 3/);
  });
});

describe('validateChoiceResult', () => {
  const sets = new Map([
    ['c1', [0, 1]],
    ['c2', [2, 3]],
  ]);

  it('accepts a forced choice with a runner-up and a strength', () => {
    const output = {
      choices: [
        { cluster_id: 'c1', first_pick: 1, second_pick: 0, strength: 80, reason: 'fits my week' },
        { cluster_id: 'c2', first_pick: 2, reason: 'cheapest that works' },
      ],
    };

    const choices = validateChoiceResult(output, sets);
    expect(choices[0]).toEqual({ cluster_id: 'c1', reason: 'fits my week', first_pick: 1, second_pick: 0, strength: 80 });
    // A missing strength is legitimate — STRENGTH_DEFAULT exists for it (01 §7.1).
    expect(choices[1]?.strength).toBeUndefined();
  });

  it('accepts none:true with a reason and nothing else', () => {
    const output = {
      choices: [
        { cluster_id: 'c1', none: true, reason: 'none of these are worth the setup' },
        { cluster_id: 'c2', first_pick: 3, reason: 'good enough' },
      ],
    };

    expect(validateChoiceResult(output, sets)[0]).toEqual({
      cluster_id: 'c1',
      reason: 'none of these are worth the setup',
      none: true,
    });
  });

  it('rejects none:true carrying a pick', () => {
    const output = { choices: [{ cluster_id: 'c1', none: true, first_pick: 0, reason: 'x' }, { cluster_id: 'c2', first_pick: 2, reason: 'y' }] };
    expect(() => validateChoiceResult(output, sets)).toThrow(/must be omitted/);
  });

  it('rejects a choice with neither a pick nor none', () => {
    const output = { choices: [{ cluster_id: 'c1', reason: 'x' }, { cluster_id: 'c2', first_pick: 2, reason: 'y' }] };
    expect(() => validateChoiceResult(output, sets)).toThrow(/must set none to true/);
  });

  it('rejects a pick from another set — a choice is forced within one set', () => {
    const output = { choices: [{ cluster_id: 'c1', first_pick: 3, reason: 'x' }, { cluster_id: 'c2', first_pick: 2, reason: 'y' }] };
    expect(() => validateChoiceResult(output, sets)).toThrow(/is not a member of set "c1"/);
  });

  it('rejects a second_pick equal to the first', () => {
    const output = { choices: [{ cluster_id: 'c1', first_pick: 0, second_pick: 0, reason: 'x' }, { cluster_id: 'c2', first_pick: 2, reason: 'y' }] };
    expect(() => validateChoiceResult(output, sets)).toThrow(/same product as first_pick/);
  });

  it('rejects an unseen set, a repeated set, and an unanswered set', () => {
    expect(() =>
      validateChoiceResult({ choices: [{ cluster_id: 'c9', first_pick: 0, reason: 'x' }] }, sets),
    ).toThrow(/was not one of the sets shown/);

    expect(() =>
      validateChoiceResult(
        { choices: [{ cluster_id: 'c1', first_pick: 0, reason: 'x' }, { cluster_id: 'c1', first_pick: 1, reason: 'y' }] },
        sets,
      ),
    ).toThrow(/answered more than once/);

    expect(() => validateChoiceResult({ choices: [{ cluster_id: 'c1', first_pick: 0, reason: 'x' }] }, sets)).toThrow(
      /no choice returned for set\(s\) "c2"/,
    );
  });

  it('rejects an out-of-range strength', () => {
    const output = { choices: [{ cluster_id: 'c1', first_pick: 0, strength: 140, reason: 'x' }, { cluster_id: 'c2', first_pick: 2, reason: 'y' }] };
    expect(() => validateChoiceResult(output, sets)).toThrow(/expected 0-100/);
  });
});
