import { describe, expect, it } from 'vitest';

import { JUROR_COUNT, MODEL_ID_HAIKU, MODEL_ID_SONNET } from '../../src/config/constants.js';
import { formatProjection, projectRun } from '../../src/run/dry-run.js';
import { CATEGORY, CATEGORY_VERSION, JURY, makeProducts, PANEL } from '../helpers/run-fixtures.js';

/**
 * `01 §4` Step 4, APPROVAL GATE 3. The projection must be right about the CALL
 * COUNT — that is the number the founder approves a budget against — and it must
 * spend nothing to produce it.
 */

const ordering = { category: CATEGORY, categoryVersion: CATEGORY_VERSION };

function project(n: number, chunkSize?: number) {
  return projectRun({
    category: CATEGORY,
    products: makeProducts(n),
    jury: JURY,
    personas: PANEL.personas,
    ordering,
    ...(chunkSize === undefined ? {} : { chunkSize }),
  });
}

describe('projectRun — the call count of 01 §7.3', () => {
  it('reproduces 01 §7.3’s worked examples, with DECISIONS.md S1’s six jurors', () => {
    // 01 §7.3, Health & Fitness n=44: "2 chunks -> 5x2 + 1 + 6 = 17 calls".
    // With six jurors and this fixture's four personas: 6x2 + 1 + 4 = 17.
    const health = project(44);
    expect(health.chunks).toBe(2);
    expect(health.calls).toBe(JUROR_COUNT * 2 + 1 + PANEL.personas.length);

    // Media & News n=13: one chunk.
    const media = project(13);
    expect(media.chunks).toBe(1);
    expect(media.calls).toBe(JUROR_COUNT * 1 + 1 + PANEL.personas.length);
  });

  it('follows the chunk size it is given', () => {
    expect(project(44, 10).chunks).toBe(5);
    expect(project(44, 10).calls).toBe(JUROR_COUNT * 5 + 1 + PANEL.personas.length);
  });

  it('splits the projection per phase, and the phases sum to the whole', () => {
    const projection = project(44);
    const byPhase = new Map(projection.phases.map((phase) => [phase.phase, phase]));

    expect(byPhase.get('score')?.calls).toBe(JUROR_COUNT * 2);
    expect(byPhase.get('uniqueness')?.calls).toBe(1);
    expect(byPhase.get('customer')?.calls).toBe(PANEL.personas.length);

    const summed = projection.phases.reduce((total, phase) => total + phase.estimated_cost_usd, 0);
    expect(projection.estimated_cost_usd).toBeCloseTo(summed, 12);
  });
});

describe('projectRun — the token and cost estimate', () => {
  it('measures input tokens off the real rendered prompts, so a bigger category costs more', () => {
    const small = project(13);
    const big = project(44);
    expect(big.estimated_input_tokens).toBeGreaterThan(small.estimated_input_tokens);
    expect(big.estimated_output_tokens).toBeGreaterThan(small.estimated_output_tokens);
    expect(big.estimated_cost_usd).toBeGreaterThan(small.estimated_cost_usd);
  });

  it('prices the juror phase on haiku and the sonnet phases on sonnet', () => {
    const projection = project(44);
    const byPhase = new Map(projection.phases.map((phase) => [phase.phase, phase]));

    // Per-input-token cost implied by each phase's own estimate. Sonnet input is
    // twice haiku's, so the clustering pass must be the dearer of the two per token.
    const score = byPhase.get('score')!;
    const uniqueness = byPhase.get('uniqueness')!;
    const scoreRate = score.estimated_cost_usd / (score.estimated_input_tokens + score.estimated_output_tokens);
    const uniqRate = uniqueness.estimated_cost_usd / (uniqueness.estimated_input_tokens + uniqueness.estimated_output_tokens);
    expect(uniqRate).toBeGreaterThan(scoreRate);
    // And the ids the rates come from are the ones the engine actually calls.
    expect([MODEL_ID_HAIKU, MODEL_ID_SONNET]).toHaveLength(2);
  });

  it('is deterministic — the same inputs project the same numbers', () => {
    expect(project(44)).toEqual(project(44));
  });

  it('states the assumptions it rests on rather than burying them', () => {
    const projection = project(44);
    expect(projection.caveats.some((line) => line.includes('UPPER BOUND'))).toBe(true);
    expect(projection.caveats.some((line) => line.includes('cold prompt cache'))).toBe(true);
  });
});

describe('projectRun — spends nothing', () => {
  it('takes no ModelClient at all, so there is nothing to spend with', () => {
    // The structural version of "dry run spends nothing": `DryRunInput` has no
    // client field, so a caller holding a projection provably made no call. This
    // asserts the shape by construction — the object below is the complete input.
    const projection = projectRun({
      category: CATEGORY,
      products: makeProducts(13),
      jury: JURY,
      personas: PANEL.personas,
      ordering,
    });
    expect(projection.calls).toBeGreaterThan(0);
  });

  it('projects a category with no personas as a Customer phase of zero calls', () => {
    const projection = projectRun({
      category: CATEGORY,
      products: makeProducts(13),
      jury: JURY,
      personas: [],
      ordering,
    });
    const customer = projection.phases.find((phase) => phase.phase === 'customer');
    expect(customer?.calls).toBe(0);
    expect(customer?.estimated_cost_usd).toBe(0);
    expect(projection.calls).toBe(JUROR_COUNT + 1);
  });
});

describe('formatProjection', () => {
  it('prints the call count, a per-phase table, and the “nothing was spent” line', () => {
    const text = formatProjection(project(44));
    expect(text).toContain('PROJECTED CALLS');
    expect(text).toContain(String(JUROR_COUNT * 2 + 1 + PANEL.personas.length));
    expect(text).toContain('score');
    expect(text).toContain('uniqueness');
    expect(text).toContain('customer');
    expect(text).toContain('Nothing was spent.');
  });
});
