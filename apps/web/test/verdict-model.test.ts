/**
 * Reading a frozen verdict back.
 *
 * Every expectation here is hand-derived from the two committed boards
 * (`DECISIONS.md` S4) or from the brief, never read off the implementation:
 *
 *   cuts    = 100 - mean(metric score)          (`board/model.ts`'s definition)
 *   sharpest = the single largest deduction anywhere on the scorecard
 *
 * Sequo's five metric scores are 87.5, 86.667, 57.5, 35 and 81.667, so its mean
 * is 69.667 and it took 30.333 in cuts. Its heaviest single deduction is 80,
 * taken by The Platform Owner on Durability. Both are arithmetic over
 * `cjr/runs/developer-tools/ranking.json`, which is committed and does not move.
 */

import { describe, expect, it } from 'vitest';

import { parseVerdict, pitchLabel, VerdictPayloadError } from '@/lib/verdict/model';

import { handBuiltVerdict, ISSUED_AT, seededVerdictNamed, seededVerdicts } from './helpers/verdict.js';

describe('a verdict the Floor judged', () => {
  it('carries the cuts total, the rank, and the stamp that qualifies it', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));

    // 100 - (87.5 + 86.666... + 57.5 + 35 + 81.666...) / 5
    expect(verdict.cuts).toBeCloseTo(30.3333333, 6);
    expect(verdict.rank).toBe(7);
    // `brief` Part 5: a rank never travels without these two.
    expect(verdict.productCount).toBe(48);
    expect(verdict.issuedAt).toBe(ISSUED_AT.toISOString());
    expect(verdict.category).toBe('Developer Tools');
    expect(verdict.categoryType).toBe('b2b');
  });

  it('names the juror behind the sharpest cut', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));

    expect(verdict.sharpest).toEqual({
      points: 80,
      reason: 'Convenience layer over project-memory features coding-agent vendors are already adding natively.',
      role: 'The Platform Owner',
      metric: 'Durability',
    });
  });

  it('opens the ledger on the metric that cost the most', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));

    expect(verdict.metrics.map((metric) => metric.metric)).toEqual([
      'Durability',
      'Trust Surface',
      'Capability Substance',
      'Workflow Fit',
      'Problem Sharpness',
    ]);
    // Heaviest deduction first inside each metric too.
    for (const metric of verdict.metrics) {
      const points = metric.deductions.map((deduction) => deduction.points);
      expect([...points].sort((a, b) => b - a)).toEqual(points);
    }
  });

  it('attaches a juror to every deduction, on every metric', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));

    const deductions = verdict.metrics.flatMap((metric) => metric.deductions);
    expect(deductions.length).toBeGreaterThan(20);
    for (const deduction of deductions) {
      expect(deduction.role).not.toBe('');
      expect(deduction.reason).not.toBe('');
      expect(deduction.metric).not.toBe('');
    }
  });

  it('counts who picked it first and who made it runner-up, against the roster that could have', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));

    expect(verdict.floor.kind).toBe('convened');
    if (verdict.floor.kind !== 'convened') throw new Error('unreachable');
    expect(verdict.floor.firstPicks).toBe(5);
    expect(verdict.floor.secondPicks).toBe(0);
    // `cjr/runs/developer-tools/ranking.json`'s top-level `personas` has 6
    // entries — the whole panel that answered this run, `01 §6.2`'s `P`. 5 of
    // them named Sequo first, so the card reads "5 of 6", not a bare "5".
    expect(verdict.floor.rosterSize).toBe(6);
    expect(verdict.demand).toBeCloseTo(0.6377777, 6);
    expect(verdict.cluster.size).toBe(2);
  });

  it('carries the same roster size for a product most of the panel declined', async () => {
    // `cjr/runs/health-fitness-wellness/ranking.json`: Fuel Log's own picks are 2
    // (both first-choice), against the same 6-persona panel — the mockup's own
    // worked example, "2 of 6". The other 4 personas answered about this run too;
    // they just did not pick Fuel Log. That is what a roster denominator is for.
    const verdict = parseVerdict(await seededVerdictNamed('health-fitness-wellness', 'Fuel Log'));

    expect(verdict.floor.kind).toBe('convened');
    if (verdict.floor.kind !== 'convened') throw new Error('unreachable');
    expect(verdict.floor.firstPicks).toBe(2);
    expect(verdict.floor.secondPicks).toBe(0);
    expect(verdict.floor.rosterSize).toBe(6);
  });
});

describe('a verdict the Floor never convened for', () => {
  it('is a stated fact with a cluster size behind it, not a missing field', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon'));

    expect(verdict.floor).toEqual({ kind: 'solo', clusterSize: 1 });
    // `DECISIONS.md` S3: no demand term at all, rather than a substituted zero.
    expect(verdict.demand).toBeUndefined();
    expect(verdict.cuts).toBeCloseTo(25.8333333, 6);
    expect(verdict.rank).toBe(2);
  });

  it('does not need a roster size at all — there is no numerator to divide', () => {
    // A solo-cluster row never reads `demand_roster_size`, so a payload missing
    // it entirely (an older frozen row, or simply no scored product on the
    // board) still parses. If this ever started requiring the field, a solo
    // verdict would render "0 of M" the moment the field were absent or zero —
    // exactly the misreading `DECISIONS.md` S3 exists to prevent.
    const row = handBuiltVerdict({ demandStatus: 'solo_cluster' });
    delete (row.payload as Record<string, unknown>)['demand_roster_size'];

    const verdict = parseVerdict(row);
    expect(verdict.floor).toEqual({ kind: 'solo', clusterSize: 1 });
  });

  it('is the common case on both seeded boards', async () => {
    // The counts `brief` and `DECISIONS.md` S3 quote. If a future re-rank moved
    // them, the page's "this is the common case" copy would need re-reading.
    const dev = (await seededVerdicts('developer-tools')).map(parseVerdict);
    const health = (await seededVerdicts('health-fitness-wellness')).map(parseVerdict);

    expect(dev).toHaveLength(48);
    expect(dev.filter((verdict) => verdict.floor.kind === 'solo')).toHaveLength(32);
    expect(health).toHaveLength(44);
    expect(health.filter((verdict) => verdict.floor.kind === 'solo')).toHaveLength(26);
  });
});

describe('the pitch ordinal', () => {
  it('counts pitches the way brief 2.4 shows them', () => {
    const cases: [number, string][] = [
      [1, '1st pitch'],
      [2, '2nd pitch'],
      [3, '3rd pitch'],
      [4, '4th pitch'],
      [11, '11th pitch'],
      [12, '12th pitch'],
      [13, '13th pitch'],
      [21, '21st pitch'],
      [22, '22nd pitch'],
      [23, '23rd pitch'],
      [101, '101st pitch'],
      [111, '111th pitch'],
    ];
    for (const [n, label] of cases) expect(pitchLabel(n)).toBe(label);
  });

  it('is absent on an unclaimed seeded listing, which nobody has pitched', async () => {
    const verdict = parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'));
    expect(verdict.attemptNumber).toBeNull();
    expect(verdict.pitchLabel).toBeNull();
  });

  it('is present on a paid one', () => {
    const verdict = parseVerdict(handBuiltVerdict({ attemptNumber: 3 }));
    expect(verdict.pitchLabel).toBe('3rd pitch');
  });
});

describe('a payload that is not a verdict', () => {
  it('refuses a deduction with no juror behind it', () => {
    const row = handBuiltVerdict({
      scorecard: [
        {
          metric: 'Trust Surface',
          score: 60,
          spread: 10,
          juror_count: 6,
          substituted_roles: [],
          deductions: [{ points: 50, reason: 'No stated data handling.' }],
        },
      ],
    });

    expect(() => parseVerdict(row)).toThrow(VerdictPayloadError);
    expect(() => parseVerdict(row)).toThrow(/deductions\[0\]\.role/);
  });

  it('refuses a row whose column and payload disagree about the product count', () => {
    // Two frozen records of one fact, contradicting each other. The row is the
    // record a dispute is argued from (`brief` Part 7); an ambiguous one is not
    // silently resolved in the customer's page.
    const row = handBuiltVerdict({ productCount: 48, payloadProductCount: 12 });

    expect(() => parseVerdict(row)).toThrow(/product_count disagrees: column says 48, payload says 12/);
  });

  it('refuses a demand_status it does not recognise', () => {
    const row = handBuiltVerdict();
    (row.payload as { verdict: Record<string, unknown> }).verdict['demand_status'] = 'pending';

    expect(() => parseVerdict(row)).toThrow(/neither scored nor solo_cluster/);
  });

  it('refuses an empty scorecard rather than rendering a blank card', () => {
    expect(() => parseVerdict(handBuiltVerdict({ scorecard: [] }))).toThrow(/scorecard is empty/);
  });

  it('refuses a scored floor with no roster size to divide by', () => {
    // Older frozen rows predate `demand_roster_size` (`packages/db/src/seed/
    // build.ts`). A page that rendered "5 of undefined" would be worse than one
    // that refuses to render at all.
    const row = handBuiltVerdict({ demandStatus: 'scored' });
    delete (row.payload as Record<string, unknown>)['demand_roster_size'];

    expect(() => parseVerdict(row)).toThrow(/demand_roster_size is not a finite number/);
  });

  it('refuses a roster size that could not have convened', () => {
    const row = handBuiltVerdict({ demandStatus: 'scored', rosterSize: 0 });

    expect(() => parseVerdict(row)).toThrow(/demand_roster_size 0 is not a roster that could have convened/);
  });
});
