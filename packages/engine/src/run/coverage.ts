/**
 * Did the merit panel actually cover the category?
 *
 * `brief §2.3`: "Partial success is a failure. If the Six scored but the Floor
 * call failed, the composite is missing 35% of its weight ... Never deliver a
 * degraded verdict." The same reasoning applies one level down, inside the Score
 * phase: if five of the Six answered, every composite is computed over five
 * mandates instead of six, and `01 §6.1` divides by the juror count, so the
 * missing juror is not merely absent — it silently reweights everybody else.
 *
 * Task 3 already built the disclosure this needs. `buildScorecards` substitutes
 * `SCORE_CLAMP_DEFAULT` for a cell no juror returned, exactly as the composite
 * does, and names the responsible role in `ScorecardEntry.substituted_roles` so
 * the board can say "this juror did not answer" instead of printing a fabricated
 * 50 as an opinion. This module runs that same function over the assembled score
 * log and reads the substitutions back out — so the orchestrator's completeness
 * check and the board's disclosure can never disagree about what is missing.
 *
 * ## The padding, and why it is not a lie
 *
 * A juror whose calls all failed contributes no `ScoreLogEntry` at all, so
 * `mergeScoreLog` never sees it and `substituted_roles` never names it —
 * `juror_count` would simply read 5, and the omission would be invisible in
 * exactly the field meant to disclose omissions. The audit therefore pads the log
 * with an EMPTY entry per missing role before building the scorecards, which
 * makes that juror's every cell a named substitution.
 *
 * The padded log exists only inside this function. It is never persisted, never
 * ranked over, and never delivered: a non-empty `missing_roles` fails the phase,
 * and a failed phase produces no `Ranking` at all (`RunOutcome`). What the
 * padding buys is a diagnostic that names the silent juror.
 */

import { buildScorecards } from '../rank/scorecard.js';
import type { JurorWeights, ScoreLogEntry } from '../types.js';
import type { ScoreCoverage, SubstitutedCell } from './types.js';

export interface CoverageInput {
  scoreLog: readonly ScoreLogEntry[];
  /** The INSTALLED panel — the authority on who was supposed to answer. */
  jury: readonly JurorWeights[];
  /** Rubric metric names, in rubric order. */
  metricNames: readonly string[];
  productIds: readonly number[];
  /** Stamped onto a padded entry; never read, since a padded juror has no scores. */
  promptVersion: string;
}

/**
 * Audit a score log against the panel that was supposed to produce it.
 *
 * `complete` is true only when every installed juror answered and no
 * (product, metric) cell needed substituting. Anything less is `brief §2.3`'s
 * partial success, which the Score phase turns into an `incomplete_panel`
 * failure.
 */
export function auditScoreCoverage(input: CoverageInput): ScoreCoverage {
  const expectedRoles = input.jury.map((juror) => juror.role);
  const answered = new Set(input.scoreLog.map((entry) => entry.juror_role));
  const missingRoles = expectedRoles.filter((role) => !answered.has(role));

  // See the header: padding is what makes a wholly-absent juror appear in
  // `substituted_roles` rather than silently shrinking `juror_count`.
  const padded: ScoreLogEntry[] = [
    ...input.scoreLog,
    ...missingRoles.map((role) => ({ juror_role: role, prompt_version: input.promptVersion, scores: [] })),
  ];

  const scorecards = buildScorecards(padded, input.metricNames, input.productIds);

  const substituted: SubstitutedCell[] = [];
  for (const id of input.productIds) {
    for (const entry of scorecards.get(id) ?? []) {
      if (entry.substituted_roles.length > 0) {
        substituted.push({ product_id: id, metric: entry.metric, roles: [...entry.substituted_roles] });
      }
    }
  }

  return {
    complete: missingRoles.length === 0 && substituted.length === 0,
    missing_roles: missingRoles,
    substituted,
    jurors_answered: answered.size,
    jurors_expected: expectedRoles.length,
  };
}

/**
 * The human-readable reason a coverage audit failed a phase.
 *
 * Names the silent jurors first and the affected cells second, and caps the cell
 * list: one absent juror on a 44-product category produces 264 substituted cells,
 * and a failure message that prints all of them buries the one fact that matters.
 */
export function describeCoverage(coverage: ScoreCoverage, sampleSize = 5): string[] {
  const causes: string[] = [];

  for (const role of coverage.missing_roles) {
    causes.push(`juror ${JSON.stringify(role)} returned no scores at all`);
  }

  const sample = coverage.substituted.slice(0, sampleSize);
  for (const cell of sample) {
    causes.push(
      `product ${cell.product_id}, metric ${JSON.stringify(cell.metric)}: no score from ${cell.roles
        .map((role) => JSON.stringify(role))
        .join(', ')}`,
    );
  }
  if (coverage.substituted.length > sample.length) {
    causes.push(`... and ${coverage.substituted.length - sample.length} further substituted cell(s)`);
  }

  return causes;
}
