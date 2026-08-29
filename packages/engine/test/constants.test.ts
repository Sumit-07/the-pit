import { describe, expect, it } from 'vitest';

import * as constants from '../src/config/constants.js';

/**
 * The frozen constants table from `docs/plans/phase-1-engine.md`, transcribed by
 * hand. These numbers are the product: a typo here silently changes every rank,
 * so they are asserted against literals rather than against the module.
 */
const FROZEN = {
  MERIT_W: 0.65,
  DEMAND_W: 0.35,
  UNIQ_LAMBDA: 0.075,
  UNIQ_NEUTRAL: 50.0,
  BREADTH_W: 0.4,
  INTENSITY_W: 0.6,
  FIRST_PICK_W: 1.0,
  SECOND_PICK_W: 0.5,
  STRENGTH_DEFAULT: 50,
  // Added by Task 3, cited to `01 §6.2` ("mean of the top-2 strengths"). Not in
  // the plan's frozen table because the plan transcribed `01 §7.1`, which lists
  // only the constants that file declared; the top-2 rule is stated inline in
  // §6.2 instead. It is a demand weight in the same class as BREADTH_W and
  // INTENSITY_W, so it is audited here with them.
  TOP_STRENGTHS: 2,
  SCORE_CLAMP_DEFAULT: 50,
  MIN_PRODUCTS: 8,
  SANITIZE_LIMIT: 300,
  TAGLINE_SAMPLE: 15,
  // Added by Task 5 review round 1. `01 §8` lists it in the same sentence as
  // SANITIZE_LIMIT ("product text 300; labels 60"); it was briefly in the prompt
  // layer, which forced the schema layer to import from the prompt layer to reach
  // it. It is a sanitization limit and belongs beside its sibling.
  LABEL_LIMIT: 60,
  CHUNK_SIZE: 40,
  JUROR_COUNT: 6,
  CALIBRATION_SAMPLE: 15,
  METRICS_MIN: 3,
  METRICS_MAX: 6,
  PERSONAS_MIN: 4,
  PERSONAS_MAX: 8,
  PERSONAS_TARGET: 6,
  MODEL_JUROR: 'haiku',
  MODEL_CLUSTER: 'sonnet',
  MODEL_PERSONA: 'sonnet',
  // Added by Task 5. The plan's frozen table names the tier aliases but not the
  // API ids they resolve to, and Task 5's brief pins the ids: `"haiku"` ->
  // `claude-haiku-4-5`, `"sonnet"` -> `claude-sonnet-5`, never date-suffixed.
  // Asserted here because a wrong id is a silent failure on a paid run.
  MODEL_ID_HAIKU: 'claude-haiku-4-5',
  MODEL_ID_SONNET: 'claude-sonnet-5',
  // Added by Task 5. `max_tokens` is required on every Messages API call and a
  // lowballed value truncates a panel response mid-JSON, which arrives as a
  // malformed result rather than an error. Derivations are in `constants.ts`.
  MAX_TOKENS_SCORE: 32000,
  MAX_TOKENS_UNIQUENESS: 8000,
  MAX_TOKENS_CHOICE: 4000,
} as const;

describe('frozen constants', () => {
  it.each(Object.entries(FROZEN))('%s is %o', (name, value) => {
    expect(constants[name as keyof typeof FROZEN]).toBe(value);
  });

  it('exports exactly the frozen table and nothing else', () => {
    expect(Object.keys(constants).sort()).toEqual(Object.keys(FROZEN).sort());
  });

  it('holds the weight pairs that must sum to 1', () => {
    expect(constants.MERIT_W + constants.DEMAND_W).toBe(1);
    expect(constants.BREADTH_W + constants.INTENSITY_W).toBe(1);
  });

  it('is intensity-leaning by design', () => {
    expect(constants.INTENSITY_W).toBeGreaterThan(constants.BREADTH_W);
  });

  it('bounds the uniqueness tilt well below one population std', () => {
    expect(constants.UNIQ_LAMBDA).toBeLessThan(0.1);
  });
});
