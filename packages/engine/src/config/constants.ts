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
