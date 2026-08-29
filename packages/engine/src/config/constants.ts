/**
 * Every frozen constant for the ranking engine.
 *
 * Global Constraint 4 (`docs/plans/phase-1-engine.md`): never invent a number.
 * Every constant lives here and is imported; no magic numbers at use sites.
 *
 * Each entry cites its source. Where `01-skill-reference.md` was superseded,
 * the superseding source is cited instead.
 */

// --- Blending: `core = MERIT_W * z(merit) + DEMAND_W * z(demand)` --------------

/** Weight on z(merit) in `core`. Source: `01 §7.1` (rank_final.py:9). */
export const MERIT_W = 0.65;

/** Weight on z(demand) in `core`. Source: `01 §7.1` (rank_final.py:10). */
export const DEMAND_W = 0.35;

// --- Uniqueness tilt: `rank_key = core + UNIQ_LAMBDA * (U - UNIQ_NEUTRAL) / 50` -

/** Max +/- uniqueness nudge on `core`. Source: `01 §7.1` (rank_final.py:11). */
export const UNIQ_LAMBDA = 0.075;

/** Uniqueness assumed when none was returned (no tilt). Source: `01 §7.1` (rank_final.py:12). */
export const UNIQ_NEUTRAL = 50.0;

// --- Demand reduction: `demand_raw = BREADTH_W * breadth + INTENSITY_W * intensity` -

/** Weight on breadth in `demand_raw`. Source: `01 §7.1` (rank_final.py:14). */
export const BREADTH_W = 0.4;

/** Weight on intensity in `demand_raw`. Source: `01 §7.1` (rank_final.py:15). */
export const INTENSITY_W = 0.6;

/** A persona's first pick counts one whole vote. Source: `01 §7.1` (rank_final.py:172). */
export const FIRST_PICK_W = 1.0;

/** A runner-up vote counts half a first pick. Source: `01 §7.1` (rank_final.py:180). */
export const SECOND_PICK_W = 0.5;

/** Clamp default for a missing persona `strength`. Source: `01 §7.1` (rank_final.py:173). */
export const STRENGTH_DEFAULT = 50;

/**
 * How many of a product's strengths `intensity` averages: the TOP 2.
 * Source: `01 §6.2` — `intensity = mean(top-2 of strengths[pid]) / 100`.
 *
 * A weight that shapes demand, in the same class as `BREADTH_W`/`INTENSITY_W`:
 * raising it to 3 would re-weight intensity toward breadth-of-advocates, so it
 * belongs in the audited table rather than at its use site.
 */
export const TOP_STRENGTHS = 2;

/** Clamp default for a missing raw 0-100 juror score. Source: `01 §6` (`_clamp(x, 0, 100, default=50)`). */
export const SCORE_CLAMP_DEFAULT = 50;

// --- Ingest -------------------------------------------------------------------

/** Below this many usable products a category is refused. Source: `01 §7.1` (run_category.mjs:396). */
export const MIN_PRODUCTS = 8;

/** Product description truncation length, in characters. Source: `01 §7.1`; kept per `DECISIONS.md S5`. */
export const SANITIZE_LIMIT = 300;

/** Taglines sampled for a jury/persona generation prompt. Source: `01 §7.1` (generate_*.py, k=15). */
export const TAGLINE_SAMPLE = 15;

/**
 * Label truncation length, in characters. Source: `01 §8`, which gives it in the
 * same sentence as `SANITIZE_LIMIT`: "truncates (product text 300; labels 60;
 * anchors 160; etc.)".
 *
 * Applied to cluster labels and cluster ids — model-produced text derived from
 * untrusted product copy, which is fed back into the customer-demand prompt.
 */
export const LABEL_LIMIT = 60;

// --- Panels -------------------------------------------------------------------

/** Max products per scoring call; a juror makes `ceil(n / CHUNK_SIZE)` calls. Source: `01 §7.2` (cfg.chunkSize). */
export const CHUNK_SIZE = 40;

/** Jurors on the merit panel. "The Six". Source: `DECISIONS.md S1` — supersedes `01 §4`'s 5. */
export const JUROR_COUNT = 6;

/** Already-scored peers embedded in an incremental scoring prompt as calibration. Source: `brief §1.1`. */
export const CALIBRATION_SAMPLE = 15;

/** Minimum metrics in a rubric (`validate_jury`). Source: `01 §4` Step 2. */
export const METRICS_MIN = 3;

/** Maximum metrics in a rubric (`validate_jury`). Source: `01 §4` Step 2. */
export const METRICS_MAX = 6;

/** Minimum personas the validator accepts (`validate_personas`). Source: `01 §4` Step 3. */
export const PERSONAS_MIN = 4;

/** Maximum personas the validator accepts (`validate_personas`). Source: `01 §4` Step 3. */
export const PERSONAS_MAX = 8;

/** Personas the generation prompt asks for. Source: `01 §4` Step 3. */
export const PERSONAS_TARGET = 6;

// --- Model tiers --------------------------------------------------------------
// Logical tier names, not API model ids. `src/model/model-ids.ts` resolves these
// through a map so the ids stay configurable (`docs/plans/phase-1-engine.md` Task 5).

/** Model tier for the merit jurors. Source: `01 §7.2` (cfg.model). */
export const MODEL_JUROR = 'haiku';

/** Model tier for the uniqueness/clustering pass. Source: `01 §7.2` (cfg.clusterModel). */
export const MODEL_CLUSTER = 'sonnet';

/** Model tier for the customer-demand personas. Source: `01 §7.2` (cfg.personaModel). */
export const MODEL_PERSONA = 'sonnet';

// --- Model ids ----------------------------------------------------------------
// The Messages API ids the tier aliases above resolve to. Added by Task 5.
//
// These are values the API validates, not numbers that shape a rank, but they
// live here for the same reason every other constant does (Global Constraint 4):
// a wrong id at a use site is a silent 404 on a paid run, and the audit test
// below is the only place the ids are read by a human.
//
// NEVER append a date suffix: the ids below are complete as written. Source:
// `docs/plans/phase-1-engine.md` Task 5 brief, checked against the current
// Anthropic model table (Claude Haiku 4.5, Claude Sonnet 5).

/** API id for the `MODEL_JUROR` tier. */
export const MODEL_ID_HAIKU = 'claude-haiku-4-5';

/** API id for the `MODEL_CLUSTER` / `MODEL_PERSONA` tier. */
export const MODEL_ID_SONNET = 'claude-sonnet-5';

/**
 * The model id a locally-seeded run reports. Added by Task 9.
 *
 * NOT an API id and deliberately not one: `01 §1` and `§9` rule 1 run this skill
 * with no Anthropic API key, jurors as local Claude Code subagents, and
 * `HandoffClient` cannot know which model actually answered a request a person
 * dispatched by hand. It is chosen to be absent from `MODEL_PRICES` on purpose,
 * so every locally-seeded call lands in `PhaseCost.unpriced_models` and the
 * report's `costBasis` reads `unmeasured` — "UNMEASURED, not $0.00" — instead of
 * booking a confident zero (`src/report/cost.ts`).
 */
export const MODEL_ID_LOCAL_SUBAGENT = 'local-claude-code-subagent';

// --- Output budgets -----------------------------------------------------------
// `max_tokens` is required on every Messages API call and truncates the response
// mid-JSON when it is hit, which surfaces as a malformed panel result rather than
// as an error. Each budget below is derived from the worst case that panel can
// legitimately produce, then rounded up. They are ceilings, not targets: a call
// that returns less is billed for less.

/**
 * One juror, one chunk. Worst case is `CHUNK_SIZE` products x `METRICS_MAX`
 * metrics, each metric carrying a handful of deductions whose reasons run to the
 * `01 §5.1` limit of 20 words (~30 tokens plus ~15 of JSON framing). At ~110
 * tokens per scored metric that is ~700 tokens per product and ~28k for a full
 * 40-product chunk; 32000 leaves headroom for a wordier juror.
 */
export const MAX_TOKENS_SCORE = 32000;

/**
 * The single clustering call. It emits one row per product (score, cluster id and
 * a <=20-word reason, ~60 tokens) plus one row per cluster (label and member ids),
 * over a whole category rather than a chunk.
 */
export const MAX_TOKENS_UNIQUENESS = 8000;

/**
 * One persona over every similar-app set. There are at most `n / 2` sets with
 * >= 2 members (`01 §5.3`), each answered with two ids, a strength and a
 * <=20-word reason.
 */
export const MAX_TOKENS_CHOICE = 4000;

/**
 * The new product's cluster assignment on the incremental path — one existing
 * `cluster_id` or one new label, plus a scarcity score and a <=20-word reason.
 * A single small row, so the budget only has to cover one uniqueness-shaped
 * answer with room for a long label.
 */
export const MAX_TOKENS_ASSIGN = 2000;

// --- Engine identity ----------------------------------------------------------

/**
 * The engine build that produced a stored run, stamped into `results.json.meta`.
 *
 * A run is an integrity record (`brief` Part 7: "backups of the score log — it's
 * the integrity record if anyone disputes a ranking"), and a record that cannot
 * say which code produced it is a weaker one. Must equal `version` in
 * `packages/engine/package.json`; `test/constants.test.ts` asserts that, because
 * two hand-maintained version strings drift.
 */
export const ENGINE_VERSION = '0.1.0';

// --- Cost model ---------------------------------------------------------------
// `01 §7.3` gives the cost model as a CALL COUNT and never prices a token, so
// these rates are the missing half of Task 7's ledger. They are US dollars per
// MILLION tokens, from the current Anthropic pricing table (checked 2026-08-29
// against the `claude-api` skill's model table).
//
// Cache rates are the published multipliers on the model's own input rate:
// a 5-minute cache WRITE costs 1.25x input, a cache READ costs 0.1x input. They
// are written out as absolute rates rather than as multipliers so a reader of
// the ledger can check a dollar figure against this table without doing the
// multiplication in their head, and `test/run/ledger.test.ts` re-derives them
// from the multipliers so the two can never drift apart.

/** Cache WRITE premium as a multiple of the input rate. Source: Anthropic prompt-caching pricing. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Cache READ discount as a multiple of the input rate. Source: Anthropic prompt-caching pricing. */
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * The date the price table below was last checked against the published
 * Anthropic rates, in ISO form.
 *
 * Prices are the one input to this engine that is not derivable from a document
 * in this repository, and nothing in the codebase notices when they go stale: a
 * repriced model silently turns every dollar figure into fiction while every test
 * still passes. Task 8's report prints this date beside every dollar figure, so
 * staleness is visible on the face of the report rather than buried here.
 */
export const PRICE_TABLE_DATE = '2026-08-29';

/** USD per million input tokens, `claude-haiku-4-5`. */
export const PRICE_HAIKU_INPUT = 1.0;

/** USD per million output tokens, `claude-haiku-4-5`. */
export const PRICE_HAIKU_OUTPUT = 5.0;

/** USD per million input tokens, `claude-sonnet-5`. */
export const PRICE_SONNET_INPUT = 2.0;

/** USD per million output tokens, `claude-sonnet-5`. */
export const PRICE_SONNET_OUTPUT = 10.0;

/** Tokens per dollar-denominated price unit: the rates above are per million tokens. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

// --- Dry-run estimation -------------------------------------------------------
// `01 §4` Step 4 requires the dry run to print a projected call count AND a token
// estimate while spending nothing, which means estimating without a tokenizer.
// Every number below is an ESTIMATE and the projection labels itself as one; none
// of them is ever used to compute a rank or to bill anybody.

/**
 * Characters per token, the standard English-prose approximation. Applied to the
 * fully rendered prompt text of the requests a run WOULD send, so the input side
 * of the estimate is measured off real bytes rather than guessed.
 */
export const EST_CHARS_PER_TOKEN = 4;

/**
 * Estimated output tokens for one product-metric cell of a scoring answer: a
 * score, a handful of deductions, and their <=20-word reasons with JSON framing.
 * Source: the worst-case derivation already written above for `MAX_TOKENS_SCORE`
 * ("~110 tokens per scored metric"), reused so the ceiling and the estimate
 * cannot disagree.
 */
export const EST_OUTPUT_TOKENS_PER_SCORED_METRIC = 110;

/**
 * Estimated output tokens for one row of a uniqueness answer: a scarcity score,
 * a cluster id and a <=20-word reason. Source: the `MAX_TOKENS_UNIQUENESS`
 * derivation above ("~60 tokens").
 */
export const EST_OUTPUT_TOKENS_PER_UNIQUENESS_ROW = 60;

/**
 * Estimated output tokens for one persona choice: a cluster id, two product ids,
 * a strength and a <=20-word reason. Same shape and therefore the same size as a
 * uniqueness row; see the `MAX_TOKENS_CHOICE` derivation above.
 */
export const EST_OUTPUT_TOKENS_PER_CHOICE = 60;

// --- The Phase 1 report -------------------------------------------------------
// Task 8's thresholds and schedule inputs. None of these touches a rank: they
// decide what the report FLAGS and what it compares a projection against. They
// live here rather than at their use sites for the same reason every other
// constant does — a threshold nobody can find is a threshold nobody can audit —
// and each cites the document that fixed it.

/**
 * `discrimination` below this reads "merit alone is fragile" on the report.
 * Source: `01 §6.5` — "low ⇒ products score alike ⇒ merit alone is fragile; the
 * board flags `< 0.5`".
 */
export const DISCRIMINATION_FLOOR = 0.5;

/**
 * A cross-juror composite correlation above this flags a pair as
 * indistinguishable. Source: `docs/plans/phase-1-engine.md` Task 8 — "Flag any
 * pair above 0.9 — that is the 'panel too correlated, redesign mandates' signal."
 */
export const JUROR_CORRELATION_CEILING = 0.9;

/**
 * A juror deducting fewer than this fraction of the panel's MEDIAN total points
 * is flagged dead weight. Source: `docs/plans/phase-1-engine.md` Task 8 — "Flag
 * any juror whose rate is under half the panel median as dead weight."
 */
export const DEAD_WEIGHT_MEDIAN_FRACTION = 0.5;

/**
 * Products re-scored in a nightly recalibration pass. Source: `brief` Part 3 —
 * "**Top 20 per category nightly**, full board weekly."
 */
export const RECAL_NIGHTLY_TOP_N = 20;

/**
 * Categories in the source workbook. Measured, not assumed: Task 2 swept
 * `loadCategory` over the whole export and found 28 categories, 0 refused
 * (`.superpowers/sdd/phase-1-engine/task-2-report.md`). `PHASE-0.md` records the
 * same figure as a data-level conflict with the brief.
 */
export const CATEGORY_COUNT = 28;

/**
 * Categories the brief's recalibration budget was stated over. Source: `brief`
 * Part 3 — "it's ~$17-25/month total across 15 categories."
 *
 * Kept separate from `CATEGORY_COUNT` on purpose. The budget line and the data
 * disagree, and a report that silently used one number for both would hide
 * exactly the discrepancy `DECISIONS.md`'s open "Cost re-baseline" item exists to
 * settle.
 */
export const RECAL_BUDGET_CATEGORIES = 15;

/** Low end of the monthly recalibration inference budget, USD. Source: `brief` Part 7. */
export const RECAL_BUDGET_MIN_USD = 17;

/** High end of the monthly recalibration inference budget, USD. Source: `brief` Part 7. */
export const RECAL_BUDGET_MAX_USD = 25;

// The calendar, so the monthly schedule is arithmetic over named quantities
// rather than a rounded "30 nights and 4 weeks". A month is 365/12 = 30.4167
// days, i.e. 4.3452 weeks; rounding those down understates a monthly cost by
// ~1.4% and ~8% respectively, in the direction that flatters the budget.

/** Days in a common year. */
export const DAYS_PER_YEAR = 365;

/** Months in a year. */
export const MONTHS_PER_YEAR = 12;

/** Days in a week. */
export const DAYS_PER_WEEK = 7;

/**
 * Products scored both ways in the fix-1.1 A/B check, and re-scored for the
 * test-retest baseline. Source: `the-pit-agent-prompts.md` Phase 1 — "A/B check:
 * score 5 products BOTH ways" — and `docs/plans/phase-1-engine.md` Task 8.
 */
export const AB_SAMPLE = 5;
