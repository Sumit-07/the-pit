/**
 * The four rubric anchor levels, in one place.
 *
 * `01 §4` Step 2 requires every metric to carry all four of `"100" "80" "50"
 * "20"`, each non-empty, and `01 §5.1` requires the scoring prompt to show all
 * four. Three separate places therefore need the same list: `validateJury` (which
 * rejects a rubric missing one), `buildJuryPrompt` (which tells the generating
 * model to produce them), and `buildScoreRequest` (which renders them).
 *
 * They read it from here so the set cannot drift between the gate that admits a
 * rubric and the prompt that uses it — a validator accepting three anchors while
 * the score prompt renders four would put `undefined` in front of a juror.
 *
 * Highest first, which is also the order a rubric reads naturally.
 */

import type { MetricAnchors } from '../types.js';

/** The anchor keys, ordered high to low. Typed as the keys of `MetricAnchors`. */
export const ANCHOR_LEVELS: readonly (keyof MetricAnchors)[] = ['100', '80', '50', '20'];
