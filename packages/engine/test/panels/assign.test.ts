import { describe, expect, it } from 'vitest';

import { LABEL_LIMIT, MAX_TOKENS_ASSIGN, MODEL_CLUSTER } from '../../src/config/constants.js';
import {
  ASSIGN_TOOL_NAME,
  buildAssignRequest,
  validateAssignResult,
} from '../../src/panels/prompts/assign.js';
import { SchemaValidationError } from '../../src/panels/schemas.js';
import type { Cluster } from '../../src/types.js';
import { makeProducts } from '../helpers/run-fixtures.js';

/**
 * The incremental placement call. Its whole reason to exist is `brief §1.5`:
 * clusters are append-only, because demand votes are keyed to `cluster_id` and
 * re-clustering would invalidate every one of them.
 */

const PRODUCTS = makeProducts(4);
const CLUSTERS: Cluster[] = [
  { cluster_id: 'notes', label: 'Note takers', member_ids: [0, 1] },
  { cluster_id: 'timers', label: 'Focus timers', member_ids: [2, 3] },
];
const EXISTING = new Set(CLUSTERS.map((cluster) => cluster.cluster_id));

const NEW_PRODUCT = {
  id: 9,
  name: 'Margin',
  description: 'Turns meeting notes into a shared action list without anyone typing one.',
  url: 'https://example.com/9',
  normalized_url: 'example.com/9',
  orig_rank: 10,
};

describe('buildAssignRequest', () => {
  const request = buildAssignRequest({ product: NEW_PRODUCT, clusters: CLUSTERS, products: PRODUCTS });

  it('runs on the clustering tier with the clustering budget', () => {
    expect(request.model).toBe(MODEL_CLUSTER);
    expect(request.maxTokens).toBe(MAX_TOKENS_ASSIGN);
    expect(request.toolName).toBe(ASSIGN_TOOL_NAME);
  });

  it('shows every existing cluster id, so the model can only choose among them', () => {
    const roster = request.system[1]?.text ?? '';
    expect(roster).toContain('[cluster_id notes]');
    expect(roster).toContain('[cluster_id timers]');
    expect(roster).toContain('Note takers');
  });

  it('wraps the new product as DATA, never as instructions', () => {
    const block = request.system[2]?.text ?? '';
    expect(block).toContain('<<<');
    expect(block).toContain('>>>');
    expect(block).toContain('[id 9]');
    expect(block).toContain('Margin');
  });

  it('puts the cache breakpoint after the roster, not after the product', () => {
    // The roster is what repeats across submissions against one category
    // snapshot; the product is different every time. A breakpoint at the end
    // would cache a prefix that never recurs.
    expect(request.cacheBreakpoint).toBe(1);
    expect(request.system).toHaveLength(3);
  });

  it('tells the model the existing clusters are fixed', () => {
    expect(request.system[0]?.text).toContain('The existing clusters are FIXED');
  });

  it('handles an empty roster without pretending there are clusters', () => {
    const empty = buildAssignRequest({ product: NEW_PRODUCT, clusters: [], products: PRODUCTS });
    expect(empty.system[1]?.text).toContain('There are none yet');
  });
});

describe('validateAssignResult', () => {
  it('accepts joining an existing cluster', () => {
    expect(
      validateAssignResult({ cluster_id: 'notes', uniqueness_score: 40, reason: 'several note tools do this' }, EXISTING),
    ).toEqual({ cluster_id: 'notes', uniqueness_score: 40, reason: 'several note tools do this' });
  });

  it('accepts opening a new cluster', () => {
    const result = validateAssignResult(
      { new_cluster_label: 'Meeting action lists', uniqueness_score: 85, reason: 'no close analogue' },
      EXISTING,
    );
    expect(result.new_cluster_label).toBe('Meeting action lists');
    expect(result.cluster_id).toBeUndefined();
  });

  it('REFUSES a cluster_id that is not on the roster', () => {
    // The failure that would break append-only: an invented id carries demand
    // votes that were never cast.
    expect(() =>
      validateAssignResult({ cluster_id: 'invented', uniqueness_score: 40, reason: 'x' }, EXISTING),
    ).toThrow(SchemaValidationError);
    expect(() =>
      validateAssignResult({ cluster_id: 'invented', uniqueness_score: 40, reason: 'x' }, EXISTING),
    ).toThrow(/append-only/);
  });

  it('refuses both a cluster_id and a new label', () => {
    expect(() =>
      validateAssignResult(
        { cluster_id: 'notes', new_cluster_label: 'Something else', uniqueness_score: 40, reason: 'x' },
        EXISTING,
      ),
    ).toThrow(/never both/);
  });

  it('refuses neither', () => {
    expect(() => validateAssignResult({ uniqueness_score: 40, reason: 'x' }, EXISTING)).toThrow(
      /must be placed somewhere/,
    );
  });

  it('refuses a scarcity score outside 0-100 or not a whole number', () => {
    for (const score of [-1, 101, 40.5, '40', null]) {
      expect(() =>
        validateAssignResult({ cluster_id: 'notes', uniqueness_score: score, reason: 'x' }, EXISTING),
      ).toThrow(SchemaValidationError);
    }
  });

  it('refuses an empty reason', () => {
    expect(() => validateAssignResult({ cluster_id: 'notes', uniqueness_score: 40, reason: '   ' }, EXISTING)).toThrow(
      SchemaValidationError,
    );
  });

  it('truncates a new label to 01 §8’s label limit', () => {
    const result = validateAssignResult(
      { new_cluster_label: 'x'.repeat(LABEL_LIMIT + 40), uniqueness_score: 70, reason: 'novel' },
      EXISTING,
    );
    expect(result.new_cluster_label).toHaveLength(LABEL_LIMIT);
  });

  it('refuses a non-object response', () => {
    for (const bad of [null, 'text', 42, [1, 2]]) {
      expect(() => validateAssignResult(bad, EXISTING)).toThrow(SchemaValidationError);
    }
  });
});
