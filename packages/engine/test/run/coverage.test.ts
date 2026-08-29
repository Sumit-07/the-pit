import { describe, expect, it } from 'vitest';

import { SCORE_CLAMP_DEFAULT } from '../../src/config/constants.js';
import { buildScorecards } from '../../src/rank/scorecard.js';
import { auditScoreCoverage, describeCoverage } from '../../src/run/coverage.js';
import type { ScoreLogEntry } from '../../src/types.js';
import { JURORS, METRIC_NAMES } from '../helpers/run-fixtures.js';

/**
 * `brief §2.3`'s partial-success check, one level below the phase.
 *
 * The audit is deliberately built on `buildScorecards`, the same function the
 * board publishes through, so "the orchestrator says the panel is complete" and
 * "the verdict page shows no substitutions" can never disagree.
 */

const PRODUCT_IDS = [0, 1, 2];

function entry(role: string, ids: readonly number[] = PRODUCT_IDS, metrics = METRIC_NAMES): ScoreLogEntry {
  return {
    juror_role: role,
    prompt_version: 'jury-v1',
    scores: ids.map((id) => ({
      id,
      metrics: metrics.map((name) => ({ name, score: 70, deductions: [{ points: 30, reason: 'thin' }] })),
    })),
  };
}

const audit = (scoreLog: readonly ScoreLogEntry[]) =>
  auditScoreCoverage({
    scoreLog,
    jury: JURORS,
    metricNames: METRIC_NAMES,
    productIds: PRODUCT_IDS,
    promptVersion: 'jury-v1',
  });

describe('auditScoreCoverage', () => {
  it('passes a complete panel', () => {
    const coverage = audit(JURORS.map((juror) => entry(juror.role)));

    expect(coverage.complete).toBe(true);
    expect(coverage.missing_roles).toEqual([]);
    expect(coverage.substituted).toEqual([]);
    expect(coverage.jurors_answered).toBe(JURORS.length);
    expect(coverage.jurors_expected).toBe(JURORS.length);
  });

  it('names a juror that is entirely absent from the score log', () => {
    // Without the padding this juror would be INVISIBLE: `mergeScoreLog` never
    // sees it, so `substituted_roles` would be empty and `juror_count` would just
    // read 5 — the omission hidden in the very field meant to disclose omissions.
    const coverage = audit(JURORS.slice(0, 5).map((juror) => entry(juror.role)));

    expect(coverage.complete).toBe(false);
    expect(coverage.missing_roles).toEqual([JURORS[5]!.role]);
    expect(coverage.substituted).toHaveLength(PRODUCT_IDS.length * METRIC_NAMES.length);
    expect(coverage.substituted.every((cell) => cell.roles.length === 1)).toBe(true);
    expect(coverage.substituted[0]?.roles).toEqual([JURORS[5]!.role]);
  });

  it('names a juror that answered but skipped one metric', () => {
    const partial = [
      ...JURORS.slice(0, 5).map((juror) => entry(juror.role)),
      entry(JURORS[5]!.role, PRODUCT_IDS, METRIC_NAMES.slice(0, 2)),
    ];
    const coverage = audit(partial);

    expect(coverage.complete).toBe(false);
    // The juror IS in the log, so it is not "missing" — only its cells are.
    expect(coverage.missing_roles).toEqual([]);
    expect(coverage.substituted).toHaveLength(PRODUCT_IDS.length);
    expect(coverage.substituted.every((cell) => cell.metric === METRIC_NAMES[2])).toBe(true);
  });

  it('names a juror that skipped one product', () => {
    const partial = [
      ...JURORS.slice(0, 5).map((juror) => entry(juror.role)),
      entry(JURORS[5]!.role, [0, 1]),
    ];
    const coverage = audit(partial);

    expect(coverage.complete).toBe(false);
    expect(coverage.substituted.every((cell) => cell.product_id === 2)).toBe(true);
    expect(coverage.substituted).toHaveLength(METRIC_NAMES.length);
  });

  it('agrees with the scorecard the board would publish', () => {
    // The point of building the audit on `buildScorecards`: the substituted cells
    // it reports are literally the cells whose published `score` is a fabricated
    // SCORE_CLAMP_DEFAULT contribution.
    const scoreLog = JURORS.slice(0, 5).map((juror) => entry(juror.role));
    const coverage = audit(scoreLog);
    const scorecards = buildScorecards(scoreLog, METRIC_NAMES, PRODUCT_IDS);

    // The board sees five jurors and no substitution; the audit sees six expected
    // and names the sixth. That difference is exactly what the padding exposes.
    expect(scorecards.get(0)?.[0]?.juror_count).toBe(5);
    expect(scorecards.get(0)?.[0]?.substituted_roles).toEqual([]);
    expect(coverage.missing_roles).toEqual([JURORS[5]!.role]);
    expect(SCORE_CLAMP_DEFAULT).toBe(50);
  });

  it('treats an empty score log as a wholly missing panel', () => {
    const coverage = audit([]);
    expect(coverage.complete).toBe(false);
    expect(coverage.missing_roles).toHaveLength(JURORS.length);
    expect(coverage.jurors_answered).toBe(0);
  });
});

describe('describeCoverage', () => {
  it('leads with the silent jurors', () => {
    const causes = describeCoverage(audit(JURORS.slice(0, 5).map((juror) => entry(juror.role))));
    expect(causes[0]).toContain('returned no scores at all');
    expect(causes[0]).toContain(JURORS[5]!.role);
  });

  it('caps the cell list rather than printing hundreds of lines', () => {
    const coverage = auditScoreCoverage({
      scoreLog: [],
      jury: JURORS,
      metricNames: METRIC_NAMES,
      productIds: [...Array(44).keys()],
      promptVersion: 'jury-v1',
    });
    const causes = describeCoverage(coverage, 5);

    expect(causes).toHaveLength(JURORS.length + 5 + 1);
    expect(causes.at(-1)).toMatch(/and \d+ further substituted cell/);
  });

  it('says nothing about a complete panel', () => {
    expect(describeCoverage(audit(JURORS.map((juror) => entry(juror.role))))).toEqual([]);
  });
});
