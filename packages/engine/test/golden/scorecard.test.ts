/**
 * GOLDEN FIXTURE — the scorecard, `01 §6.6`, and its agreement with the merit
 * composite of `01 §6.1`.
 *
 * `01 §6`'s preamble says the ranking math is shared "so the board and the
 * health stats always agree", and that `_clamp(x, 0, 100, default=50)` guards
 * every raw score. This file is the test of that: the published scorecard and
 * the composite that produced the rank must be two views of ONE table.
 *
 * `the-pit-build-brief.md` Part 7 calls the score log the integrity record if
 * anyone disputes a ranking. A scorecard averaged over only the jurors that
 * answered, against a composite that substituted 50 for the ones that did not,
 * would be a record a customer cannot re-derive their rank from.
 *
 * Every expected number was computed BY HAND, with the arithmetic in comments.
 */

import { describe, expect, it } from 'vitest';

import { computeComposite } from '../../src/rank/composite.js';
import { juryHealth } from '../../src/rank/health.js';
import { buildScorecards } from '../../src/rank/scorecard.js';
import type { JurorWeights, ScoreLogEntry } from '../../src/types.js';

const PRECISION = 9;
const IDS = [0, 1, 2];
const JURY: JurorWeights[] = [
  { role: 'harsh', weights: { M: 1.0 } },
  { role: 'lenient', weights: { M: 1.0 } },
];

/*
 * Two jurors, one metric M, three products. `lenient` returns no M for product 2.
 *
 * This should never happen -- `01 §5.1` has every juror score every product, so a
 * missing cell is a malformed response that `brief §2.3` says to retry rather
 * than deliver, and Task 7 enforces that upstream. The fixture exists to pin
 * what the arithmetic does if one ever slips through.
 *
 * THE CLAMPED TABLE (`_clamp(x, 0, 100, default=50)`)
 *   harsh   [ 90, 60, 30]
 *   lenient [100, 80, 50]   <- product 2 substituted
 *
 * COMPOSITE, `01 §6.1`
 *   harsh:   mean 180/3 = 60; devs [30, 0, -30]; sumsq 1800; var 600
 *            popstd = sqrt(600) = 24.4948974278
 *            z = [1.2247448714, 0, -1.2247448714]
 *   lenient: mean 230/3 = 76.6666666667
 *            devs [23.3333333333, 3.3333333333, -26.6666666667]
 *            sumsq = 544.4444444444 + 11.1111111111 + 711.1111111111
 *                  = 1266.6666666667;  var = 422.2222222222
 *            popstd = 20.5480466766
 *            z = [1.1355499479, 0.1622214211, -1.2977713690]
 *   composite = (z_harsh + z_lenient) / 2 jurors
 *             = [1.1801474097, 0.0811107106, -1.2612581202]
 *
 * SCORECARD -- the SAME table, read down the other axis
 *   p0: {90, 100} -> mean 95, devs +/-5,  popstd  5
 *   p1: {60,  80} -> mean 70, devs +/-10, popstd 10
 *   p2: {30,  50} -> mean 40, devs +/-10, popstd 10   <- 50 is the substitution
 *
 *   Averaging only the juror that answered would print score 30 / spread 0 for
 *   product 2, on a board whose composite used 50. That is the bug.
 *
 * AVG_METRIC_SPREAD = mean(5, 10, 10) = 25/3 = 8.3333333333
 */
const SCORE_LOG: ScoreLogEntry[] = [
  {
    juror_role: 'harsh',
    prompt_version: 'v1',
    scores: [
      { id: 0, metrics: [{ name: 'M', score: 90, deductions: [{ points: 10, reason: 'thin' }] }] },
      { id: 1, metrics: [{ name: 'M', score: 60, deductions: [{ points: 40, reason: 'shallow' }] }] },
      { id: 2, metrics: [{ name: 'M', score: 30, deductions: [{ points: 70, reason: 'broken' }] }] },
    ],
  },
  {
    juror_role: 'lenient',
    prompt_version: 'v1',
    scores: [
      { id: 0, metrics: [{ name: 'M', score: 100, deductions: [] }] },
      { id: 1, metrics: [{ name: 'M', score: 80, deductions: [{ points: 20, reason: 'pricey' }] }] },
      { id: 2, metrics: [] }, // returned the row, omitted the metric
    ],
  },
];

const scorecards = buildScorecards(SCORE_LOG, ['M'], IDS);
const composite = computeComposite(SCORE_LOG, JURY, IDS);

describe('buildScorecards — GOLDEN: substituted cells are in the published table', () => {
  it('averages every juror, substituting SCORE_CLAMP_DEFAULT for the silent one', () => {
    expect(scorecards.get(0)?.[0]?.score).toBe(95);
    expect(scorecards.get(1)?.[0]?.score).toBe(70);
    expect(scorecards.get(2)?.[0]?.score).toBe(40);
  });

  it('does NOT average only the jurors that answered', () => {
    // The old behaviour: mean of {30} = 30, popstd of {30} = 0.
    expect(scorecards.get(2)?.[0]?.score).not.toBe(30);
    expect(scorecards.get(2)?.[0]?.spread).not.toBe(0);
  });

  it('spreads over every juror too', () => {
    expect(scorecards.get(0)?.[0]?.spread).toBe(5);
    expect(scorecards.get(1)?.[0]?.spread).toBe(10);
    expect(scorecards.get(2)?.[0]?.spread).toBe(10);
  });

  it('names the roles whose cells were substituted, so nothing is published silently', () => {
    expect(scorecards.get(0)?.[0]?.substituted_roles).toEqual([]);
    expect(scorecards.get(1)?.[0]?.substituted_roles).toEqual([]);
    expect(scorecards.get(2)?.[0]?.substituted_roles).toEqual(['lenient']);
    for (const id of IDS) expect(scorecards.get(id)?.[0]?.juror_count).toBe(2);
  });

  it('flags a returned-but-unusable score as substituted too', () => {
    // `clampScore` falls back for anything non-finite, so `substituted_roles`
    // keys on the same condition rather than on the row merely existing.
    const garbage: ScoreLogEntry[] = [
      { juror_role: 'harsh', prompt_version: 'v1', scores: SCORE_LOG[0]?.scores ?? [] },
      {
        juror_role: 'lenient',
        prompt_version: 'v1',
        scores: [
          { id: 0, metrics: [{ name: 'M', score: 100, deductions: [] }] },
          { id: 1, metrics: [{ name: 'M', score: 80, deductions: [] }] },
          { id: 2, metrics: [{ name: 'M', score: Number.NaN, deductions: [] }] },
        ],
      },
    ];
    const cards = buildScorecards(garbage, ['M'], IDS);
    expect(cards.get(2)?.[0]?.substituted_roles).toEqual(['lenient']);
    expect(cards.get(2)?.[0]?.score).toBe(40);
  });

  it('still tags every deduction with the juror that took it', () => {
    expect(scorecards.get(1)?.[0]?.deductions).toEqual([
      { points: 40, reason: 'shallow', role: 'harsh' },
      { points: 20, reason: 'pricey', role: 'lenient' },
    ]);
  });

  it('emits no rows when the score log has no jurors to substitute for', () => {
    expect(buildScorecards([], ['M'], IDS).get(0)).toEqual([]);
  });
});

describe('the published scorecard re-derives the composite that produced the rank', () => {
  it('agrees with the composite on the anchor values', () => {
    expect(composite.get(0)).toBeCloseTo(1.1801474097, PRECISION);
    expect(composite.get(1)).toBeCloseTo(0.0811107106, PRECISION);
    expect(composite.get(2)).toBeCloseTo(-1.2612581202, PRECISION);
  });

  it('regenerates each juror’s clamped input from (score, spread) alone', () => {
    /*
     * With two jurors, the published `score` and `spread` are the mean and the
     * half-range, so {score - spread, score + spread} IS the clamped table:
     *   p0 -> {90, 100}   p1 -> {60, 80}   p2 -> {30, 50}
     * Feeding exactly that back through `computeComposite` must reproduce the
     * board. This is the dispute path: a customer holding the verdict page can
     * re-derive the rank without the raw log.
     */
    const rebuilt: ScoreLogEntry[] = JURY.map((juror, jurorIndex) => ({
      juror_role: juror.role,
      prompt_version: 'v1',
      scores: IDS.map((id) => {
        const entry = scorecards.get(id)?.[0];
        const score = (entry?.score ?? 0) + (jurorIndex === 0 ? -1 : 1) * (entry?.spread ?? 0);
        return { id, metrics: [{ name: 'M', score, deductions: [] }] };
      }),
    }));
    const rebuiltComposite = computeComposite(rebuilt, JURY, IDS);
    for (const id of IDS) {
      expect(rebuiltComposite.get(id)).toBeCloseTo(composite.get(id) as number, PRECISION);
    }
  });

  it('averages the same spreads into avg_metric_spread', () => {
    // mean(5, 10, 10) = 25/3 = 8.3333333333 -- the substituted cell contributes
    // its real disagreement, not a dropped row.
    const health = juryHealth({
      scorecards,
      composites: IDS.map((id) => composite.get(id) ?? 0),
      demandRaw: [],
      tiebreakCount: 0,
    });
    expect(health.avg_metric_spread).toBeCloseTo(8.3333333333, PRECISION);
  });
});
