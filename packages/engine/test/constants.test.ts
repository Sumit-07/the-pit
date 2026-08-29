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
  // Added by Task 7. The incremental path places one new product against the
  // fixed cluster roster (`brief §1.5`), which is a single small answer.
  MAX_TOKENS_ASSIGN: 2000,
  // Added by Task 7. `01 §7.3` models cost as a CALL COUNT and never prices a
  // token, so the ledger needs a price table. USD per million tokens, from the
  // current Anthropic table; the cache rates are the published multipliers on
  // each model's own input rate and `test/run/ledger.test.ts` re-derives them.
  CACHE_WRITE_MULTIPLIER: 1.25,
  CACHE_READ_MULTIPLIER: 0.1,
  PRICE_HAIKU_INPUT: 1.0,
  PRICE_HAIKU_OUTPUT: 5.0,
  PRICE_SONNET_INPUT: 2.0,
  PRICE_SONNET_OUTPUT: 10.0,
  TOKENS_PER_PRICE_UNIT: 1_000_000,
  // Added by Task 7. `01 §4` Step 4's dry run must print a token estimate while
  // spending nothing, i.e. without a tokenizer. Every one of these is an
  // ESTIMATE, labelled as one in the projection, and none is ever used to compute
  // a rank or to bill anybody. The output figures reuse the per-row derivations
  // already written against the MAX_TOKENS_* constants above, so the ceiling and
  // the estimate cannot disagree.
  EST_CHARS_PER_TOKEN: 4,
  EST_OUTPUT_TOKENS_PER_SCORED_METRIC: 110,
  EST_OUTPUT_TOKENS_PER_UNIQUENESS_ROW: 60,
  EST_OUTPUT_TOKENS_PER_CHOICE: 60,
  // Added by Task 7. Stamped into `results.json.meta` so a stored run says which
  // build produced it (`brief` Part 7: the score log is the integrity record).
  ENGINE_VERSION: '0.1.0',
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

  it('keeps ENGINE_VERSION equal to the package version', async () => {
    // Two hand-maintained version strings drift. A stored run that names the
    // wrong build is a worse integrity record than one that names none.
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(constants.ENGINE_VERSION).toBe(pkg.version);
  });

  it('prices sonnet above haiku on both input and output', () => {
    expect(constants.PRICE_SONNET_INPUT).toBeGreaterThan(constants.PRICE_HAIKU_INPUT);
    expect(constants.PRICE_SONNET_OUTPUT).toBeGreaterThan(constants.PRICE_HAIKU_OUTPUT);
  });
});
