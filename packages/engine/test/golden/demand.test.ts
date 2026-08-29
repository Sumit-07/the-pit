/**
 * GOLDEN FIXTURES — demand reduction, `01 §6.2`.
 *
 * Every expected number was computed BY HAND from `01 §6.2`, as exact fractions
 * wherever the decimal repeats, and the arithmetic is written out above each
 * assertion. Nothing here was produced by running the implementation.
 */

import { describe, expect, it } from 'vitest';

import { validateChoiceResult } from '../../src/panels/schemas.js';
import { clusterMembers, reduceDemand } from '../../src/rank/demand.js';
import type { DemandLogEntry, UniquenessResult } from '../../src/types.js';

const PRECISION = 9;

/** Three products in one cluster; the shape `01 §5.3` convenes the panel on. */
const UNIQUENESS: UniquenessResult = {
  clusters: [{ cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1, 2] }],
  products: [
    { id: 0, uniqueness_score: 40, cluster_id: 'c1', reason: 'crowded' },
    { id: 1, uniqueness_score: 50, cluster_id: 'c1', reason: 'familiar' },
    { id: 2, uniqueness_score: 60, cluster_id: 'c1', reason: 'a twist' },
  ],
};

/**
 * Six personas, one `none`, one `second_pick`.
 *
 *   P1 -> first 0, strength 90
 *   P2 -> first 0, second 1, strength 80
 *   P3 -> first 1, strength 70
 *   P4 -> first 2, strength 60
 *   P5 -> first 0, strength 100
 *   P6 -> none
 */
const DEMAND_LOG: DemandLogEntry[] = [
  { persona: 'P1', choices: [{ cluster_id: 'c1', first_pick: 0, strength: 90, reason: 'fits me' }] },
  {
    persona: 'P2',
    choices: [{ cluster_id: 'c1', first_pick: 0, second_pick: 1, strength: 80, reason: 'close call' }],
  },
  { persona: 'P3', choices: [{ cluster_id: 'c1', first_pick: 1, strength: 70, reason: 'cheaper' }] },
  { persona: 'P4', choices: [{ cluster_id: 'c1', first_pick: 2, strength: 60, reason: 'niche fit' }] },
  { persona: 'P5', choices: [{ cluster_id: 'c1', first_pick: 0, strength: 100, reason: 'no contest' }] },
  { persona: 'P6', choices: [{ cluster_id: 'c1', none: true, reason: 'none of these' }] },
];

describe('reduceDemand — GOLDEN: 3-member cluster, 6 personas, one none, one second pick', () => {
  /*
   * VOTES (FIRST_PICK_W = 1.0, SECOND_PICK_W = 0.5)
   *   product 0: P1 1.0 + P2 1.0 + P5 1.0                     = 3.0
   *   product 1: P3 1.0 + P2's runner-up 0.5                  = 1.5
   *   product 2: P4 1.0                                       = 1.0
   *   total_votes = 3.0 + 1.5 + 1.0 = 5.5
   *
   * CAPTURE = |picked_personas| / P
   *   picked_personas = {P1, P2, P3, P4, P5} = 5   (P6 answered `none`, so it
   *                                                 returned a choice but picked
   *                                                 nobody)
   *   P = len(demandLog) = 6                        (personas that returned choices)
   *   capture = 5/6 = 0.8333333333
   *
   * SHARE = votes / total_votes
   *   p0: 3.0/5.5 = 6/11  = 0.5454545455
   *   p1: 1.5/5.5 = 3/11  = 0.2727272727
   *   p2: 1.0/5.5 = 2/11  = 0.1818181818
   *
   * BREADTH = share * capture
   *   p0: (6/11)*(5/6)  = 5/11  = 0.4545454545
   *   p1: (3/11)*(5/6)  = 5/22  = 0.2272727273
   *   p2: (2/11)*(5/6)  = 5/33  = 0.1515151515
   *
   * INTENSITY = mean(top-2 strengths) / 100
   *   Only a FIRST pick appends a strength (`01 §6.2`), so P2's runner-up vote
   *   for product 1 lends product 1 no conviction -- only half a vote.
   *   p0: strengths [90, 80, 100] -> top 2 = [100, 90] -> mean 95  -> 0.95
   *   p1: strengths [70]          -> top 2 = [70]      -> mean 70  -> 0.70
   *   p2: strengths [60]          -> top 2 = [60]      -> mean 60  -> 0.60
   *
   * DEMAND_RAW = BREADTH_W*breadth + INTENSITY_W*intensity = 0.4*b + 0.6*i
   *   p0: 0.4*(5/11) + 0.6*0.95 = 2/11 + 0.57
   *       = 200/1100 + 627/1100 = 827/1100 = 2481/3300 = 0.7518181818
   *   p1: 0.4*(5/22) + 0.6*0.70 = 1/11 + 0.42
   *       = 100/1100 + 462/1100 = 562/1100 = 1686/3300 = 0.5109090909
   *   p2: 0.4*(5/33) + 0.6*0.60 = 2/33 + 0.36
   *       = 200/3300 + 1188/3300 = 1388/3300 = 0.4206060606
   */
  const { demandRaw, detail } = reduceDemand(DEMAND_LOG, UNIQUENESS);

  it('gives every cluster member a demand entry', () => {
    expect([...demandRaw.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('computes demand_raw', () => {
    expect(demandRaw.get(0)).toBeCloseTo(0.7518181818, PRECISION);
    expect(demandRaw.get(1)).toBeCloseTo(0.5109090909, PRECISION);
    expect(demandRaw.get(2)).toBeCloseTo(0.4206060606, PRECISION);
  });

  it('computes share', () => {
    expect(detail.get(0)?.share).toBeCloseTo(0.5454545455, PRECISION);
    expect(detail.get(1)?.share).toBeCloseTo(0.2727272727, PRECISION);
    expect(detail.get(2)?.share).toBeCloseTo(0.1818181818, PRECISION);
  });

  it('computes capture identically for every member of the cluster', () => {
    for (const id of [0, 1, 2]) expect(detail.get(id)?.capture).toBeCloseTo(0.8333333333, PRECISION);
  });

  it('computes breadth', () => {
    expect(detail.get(0)?.breadth).toBeCloseTo(0.4545454545, PRECISION);
    expect(detail.get(1)?.breadth).toBeCloseTo(0.2272727273, PRECISION);
    expect(detail.get(2)?.breadth).toBeCloseTo(0.1515151515, PRECISION);
  });

  it('computes intensity as the mean of the TOP 2 strengths, not of all of them', () => {
    // p0's three strengths are [90, 80, 100]. mean of all three = 90 -> 0.90.
    // mean of the top two = 95 -> 0.95. The fixture distinguishes the two.
    expect(detail.get(0)?.intensity).toBeCloseTo(0.95, PRECISION);
    expect(detail.get(0)?.intensity).not.toBeCloseTo(0.9, 3);
    expect(detail.get(1)?.intensity).toBeCloseTo(0.7, PRECISION);
    expect(detail.get(2)?.intensity).toBeCloseTo(0.6, PRECISION);
  });

  it('echoes demand_raw into detail.demand', () => {
    for (const id of [0, 1, 2]) {
      expect(detail.get(id)?.demand).toBeCloseTo(demandRaw.get(id) as number, PRECISION);
    }
  });

  it('records every persona pick with its side, strength and reason', () => {
    expect(detail.get(0)?.picks).toEqual([
      { persona: 'P1', pick: 'first', strength: 90, reason: 'fits me' },
      { persona: 'P2', pick: 'first', strength: 80, reason: 'close call' },
      { persona: 'P5', pick: 'first', strength: 100, reason: 'no contest' },
    ]);
    // Product 1's runner-up entry carries no strength: `01 §6.2` records a
    // persona's conviction against its first pick only.
    expect(detail.get(1)?.picks).toEqual([
      { persona: 'P2', pick: 'second', reason: 'close call' },
      { persona: 'P3', pick: 'first', strength: 70, reason: 'cheaper' },
    ]);
    expect(detail.get(2)?.picks).toEqual([
      { persona: 'P4', pick: 'first', strength: 60, reason: 'niche fit' },
    ]);
  });

  it('is intensity-leaning: p1 beats p2 on votes AND on strength', () => {
    // Sanity check on the direction of the blend, not a new number.
    expect(demandRaw.get(1)).toBeGreaterThan(demandRaw.get(2) as number);
  });
});

describe('reduceDemand — the `none` persona counts in P but not in capture', () => {
  it('drops capture when a persona declines the whole set', () => {
    /*
     * Same cluster, same picks, but P6 is REMOVED from the log instead of
     * answering `none`. Then P = 5 and picked_personas = 5, so capture = 5/5 = 1
     * instead of 5/6.
     *   p0 breadth = (6/11)*1 = 0.5454545455
     *   p0 demand  = 0.4*0.5454545455 + 0.6*0.95 = 0.2181818182 + 0.57
     *              = 0.7881818182
     * A persona that looks at a set and wants none of it therefore COSTS the set
     * capture, which is the whole point of allowing the answer.
     */
    const withoutP6 = DEMAND_LOG.slice(0, 5);
    const { demandRaw, detail } = reduceDemand(withoutP6, UNIQUENESS);
    expect(detail.get(0)?.capture).toBeCloseTo(1, PRECISION);
    expect(detail.get(0)?.breadth).toBeCloseTo(0.5454545455, PRECISION);
    expect(demandRaw.get(0)).toBeCloseTo(0.7881818182, PRECISION);
  });

  it('gives a cluster every persona declined a real demand entry of 0', () => {
    /*
     * Every persona answers `none`. The panel DID convene and found nobody
     * wanted anything: total_votes = 0 -> share 0 -> breadth 0; no strengths ->
     * intensity 0; demand_raw = 0.4*0 + 0.6*0 = 0.
     *
     * That is a real signal and must NOT be confused with the absence of one --
     * these products stay on the 0.65/0.35 blend, unlike a solo cluster.
     */
    const allNone: DemandLogEntry[] = [
      { persona: 'P1', choices: [{ cluster_id: 'c1', none: true, reason: 'no' }] },
      { persona: 'P2', choices: [{ cluster_id: 'c1', none: true, reason: 'no' }] },
    ];
    const { demandRaw, detail } = reduceDemand(allNone, UNIQUENESS);
    for (const id of [0, 1, 2]) {
      expect(demandRaw.get(id)).toBe(0);
      expect(detail.get(id)?.capture).toBe(0);
      expect(detail.get(id)?.share).toBe(0);
      expect(detail.get(id)?.intensity).toBe(0);
    }
  });
});

describe('reduceDemand — clusters the panel never convened on', () => {
  const withSolo: UniquenessResult = {
    clusters: [
      { cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1, 2] },
      { cluster_id: 'c2', label: 'One of a kind', member_ids: [3] },
    ],
    products: [
      ...UNIQUENESS.products,
      { id: 3, uniqueness_score: 95, cluster_id: 'c2', reason: 'no analog' },
    ],
  };

  it('leaves a solo cluster with NO demand entry, not a zero', () => {
    // `01 §5.3` only convenes the panel on clusters with >= 2 members, so no
    // persona ever returned a choice for c2. `DECISIONS.md` S3 keys the
    // merit-only renormalization on this absence, so `has(3)` must be false --
    // a demand_raw of 0 would be a different, and wrong, answer.
    const { demandRaw, detail } = reduceDemand(DEMAND_LOG, withSolo);
    expect(demandRaw.has(3)).toBe(false);
    expect(detail.has(3)).toBe(false);
    expect(demandRaw.has(0)).toBe(true);
  });

  it('returns empty maps when there is no demand log', () => {
    expect(reduceDemand([], UNIQUENESS).demandRaw.size).toBe(0);
    expect(reduceDemand(null, UNIQUENESS).demandRaw.size).toBe(0);
    expect(reduceDemand(undefined, UNIQUENESS).detail.size).toBe(0);
  });

  it('returns empty maps when there are no clusters', () => {
    expect(reduceDemand(DEMAND_LOG, null).demandRaw.size).toBe(0);
    expect(reduceDemand(DEMAND_LOG, { clusters: [], products: [] }).demandRaw.size).toBe(0);
  });
});

describe('reduceDemand — malformed and out-of-set answers', () => {
  it('ignores a pick that is not a member of the cluster', () => {
    // `01 §6.2` counts a vote only "for a valid pick ... and a member".
    const stray: DemandLogEntry[] = [
      { persona: 'P1', choices: [{ cluster_id: 'c1', first_pick: 99, strength: 100, reason: 'ghost' }] },
      { persona: 'P2', choices: [{ cluster_id: 'c1', first_pick: 0, strength: 80, reason: 'real' }] },
    ];
    const { demandRaw, detail } = reduceDemand(stray, UNIQUENESS);
    expect(demandRaw.has(99)).toBe(false);
    // Only P2 picked, out of P = 2 -> capture 0.5; p0 takes every vote -> share 1
    // breadth = 1*0.5 = 0.5; intensity = 80/100 = 0.8
    // demand = 0.4*0.5 + 0.6*0.8 = 0.2 + 0.48 = 0.68
    expect(detail.get(0)?.capture).toBeCloseTo(0.5, PRECISION);
    expect(demandRaw.get(0)).toBeCloseTo(0.68, PRECISION);
  });

  it('defaults a missing strength to STRENGTH_DEFAULT = 50', () => {
    // one persona, one pick, no strength: share 1, capture 1/1 = 1
    // breadth = 1; intensity = 50/100 = 0.5
    // demand = 0.4*1 + 0.6*0.5 = 0.4 + 0.3 = 0.7
    const noStrength: DemandLogEntry[] = [
      { persona: 'P1', choices: [{ cluster_id: 'c1', first_pick: 0, reason: 'unsure' }] },
    ];
    const { demandRaw } = reduceDemand(noStrength, UNIQUENESS);
    expect(demandRaw.get(0)).toBeCloseTo(0.7, PRECISION);
  });

  it('does not let one persona vote 1.5 times for one product', () => {
    // A `second_pick` equal to the `first_pick` is a malformed runner-up, not a
    // stronger endorsement. Votes must stay 1.0, so share stays 1.0.
    const selfSecond: DemandLogEntry[] = [
      {
        persona: 'P1',
        choices: [{ cluster_id: 'c1', first_pick: 0, second_pick: 0, strength: 100, reason: 'both' }],
      },
    ];
    const { detail } = reduceDemand(selfSecond, UNIQUENESS);
    expect(detail.get(0)?.share).toBe(1);
    expect(detail.get(0)?.picks).toHaveLength(1);
  });
});

describe('clusterMembers — `01 §6.2` membership resolution', () => {
  it('prefers products[].cluster_id', () => {
    expect([...clusterMembers(UNIQUENESS)]).toEqual([['c1', [0, 1, 2]]]);
  });

  it('falls back to clusters[].member_ids when no product carries a cluster_id', () => {
    // The retrofit path of `01 §4` Step 5: a run clustered before the
    // per-product field existed.
    const retrofit: UniquenessResult = {
      clusters: [{ cluster_id: 'c1', label: 'L', member_ids: [4, 5] }],
      products: [],
    };
    expect([...clusterMembers(retrofit)]).toEqual([['c1', [4, 5]]]);
  });

  it('falls back PER PRODUCT on a mixed result, not all-or-nothing', () => {
    /*
     * A plausible shape from model-generated output: `cluster_id` set on some
     * rows and the rest listed only in `member_ids`.
     *
     * Resolving this as a whole-map switch -- take products[] because it placed
     * something, ignore member_ids entirely -- would silently drop products 1
     * and 2 out of c1. They would get no demand_raw entry, so `blend` would rank
     * them merit-only and label them `solo_cluster` when the Floor HAD convened
     * on their cluster; product 0's `cluster.size` would read 1 instead of 3;
     * and the `ranking.clusters` roster would be wrong. All without an error.
     */
    const mixed: UniquenessResult = {
      clusters: [
        { cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1, 2] },
        { cluster_id: 'c2', label: 'One of a kind', member_ids: [3] },
      ],
      products: [
        { id: 0, uniqueness_score: 40, cluster_id: 'c1', reason: 'crowded' },
        // products 1 and 2 carry no cluster_id; only member_ids places them
        { id: 1, uniqueness_score: 50, cluster_id: '', reason: 'familiar' },
        { id: 3, uniqueness_score: 95, cluster_id: 'c2', reason: 'no analog' },
      ],
    };
    expect([...clusterMembers(mixed)]).toEqual([
      ['c1', [0, 1, 2]],
      ['c2', [3]],
    ]);
  });

  it('keeps a product in the cluster its own row names when the two sources disagree', () => {
    // The per-product field wins: it is what the uniqueness pass wrote for that
    // row, and a product belongs to exactly one cluster.
    const conflicting: UniquenessResult = {
      clusters: [
        { cluster_id: 'c1', label: 'A', member_ids: [0, 1] },
        { cluster_id: 'c2', label: 'B', member_ids: [0] },
      ],
      products: [{ id: 0, uniqueness_score: 50, cluster_id: 'c2', reason: 'r' }],
    };
    expect([...clusterMembers(conflicting)]).toEqual([
      ['c2', [0]],
      ['c1', [1]],
    ]);
  });

  it('does not double-count a product repeated inside one member_ids list', () => {
    const duped: UniquenessResult = {
      clusters: [{ cluster_id: 'c1', label: 'L', member_ids: [4, 4, 5] }],
      products: [],
    };
    expect([...clusterMembers(duped)]).toEqual([['c1', [4, 5]]]);
  });

  it('has no membership at all without a uniqueness pass', () => {
    expect(clusterMembers(null).size).toBe(0);
  });
});

describe('reduceDemand — a mixed uniqueness result still scores the whole cluster', () => {
  it('gives every member a demand entry, however its membership was expressed', () => {
    /*
     * The same 6-persona demand log as the golden fixture, but products 1 and 2
     * are placed only by `member_ids`. Every demand_raw value must be identical
     * to the fully-specified case -- 0.7518181818 / 0.5109090909 / 0.4206060606 --
     * and nobody may fall out to `solo_cluster`.
     */
    const mixed: UniquenessResult = {
      clusters: [{ cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1, 2] }],
      products: [{ id: 0, uniqueness_score: 40, cluster_id: 'c1', reason: 'crowded' }],
    };
    const { demandRaw } = reduceDemand(DEMAND_LOG, mixed);
    expect(demandRaw.get(0)).toBeCloseTo(0.7518181818, PRECISION);
    expect(demandRaw.get(1)).toBeCloseTo(0.5109090909, PRECISION);
    expect(demandRaw.get(2)).toBeCloseTo(0.4206060606, PRECISION);
  });
});

describe('reduceDemand — the guard `validateChoiceResult` holds, expressed as arithmetic', () => {
  /*
   * `validateChoiceResult` refuses a persona that answers one `cluster_id`
   * twice. Nothing pinned that guard against what it protects, so this fixture
   * runs the malformed answer THROUGH `reduceDemand` to show the damage, and
   * then asserts the validator refuses the identical payload — which is why the
   * arithmetic below can never be reached from a model.
   *
   * Two personas, one cluster {0, 1}. P1 answers c1 TWICE (first_pick 0,
   * strength 100 both times); P2 answers once (first_pick 1, strength 50).
   *
   * DOUBLE-COUNTED (what reduceDemand computes if the answer got through)
   *   votes    p0 = 1.0 + 1.0 = 2.0   p1 = 1.0        total = 3.0
   *   capture  {P1, P2} / 2 = 1
   *   share    p0 = 2/3               p1 = 1/3
   *   breadth  p0 = 2/3               p1 = 1/3
   *   intensity p0: strengths [100, 100] -> top 2 mean 100 -> 1.0
   *             p1: strengths [50]       -> 0.5
   *   demand   p0 = 0.4*(2/3) + 0.6*1.0 = 4/15 + 3/5 = 13/15 = 0.8666666667
   *            p1 = 0.4*(1/3) + 0.6*0.5 = 2/15 + 3/10 = 13/30 = 0.4333333333
   *
   * HONEST (P1 answering once, the only shape the validator admits)
   *   votes    p0 = 1.0               p1 = 1.0        total = 2.0
   *   capture  1;  share 1/2 each;  breadth 1/2 each
   *   intensity p0: [100] -> 1.0      p1: [50] -> 0.5
   *   demand   p0 = 0.4*0.5 + 0.6*1.0 = 0.2 + 0.6 = 0.8
   *            p1 = 0.4*0.5 + 0.6*0.5 = 0.2 + 0.3 = 0.5
   *
   * One duplicated line therefore adds 1/15 to the winner and takes 1/15 off
   * the runner-up: it buys a product a second vote and a second helping of
   * conviction from ONE buyer, which is the whole thing a forced choice is for.
   */
  const PAIR: UniquenessResult = {
    clusters: [{ cluster_id: 'c1', label: 'Note takers', member_ids: [0, 1] }],
    products: [
      { id: 0, uniqueness_score: 40, cluster_id: 'c1', reason: 'crowded' },
      { id: 1, uniqueness_score: 50, cluster_id: 'c1', reason: 'familiar' },
    ],
  };

  const DOUBLE_ANSWER = {
    choices: [
      { cluster_id: 'c1', first_pick: 0, strength: 100, reason: 'the one I would buy' },
      { cluster_id: 'c1', first_pick: 0, strength: 100, reason: 'still the one I would buy' },
    ],
  };

  const doubled: DemandLogEntry[] = [
    { persona: 'P1', choices: DOUBLE_ANSWER.choices },
    { persona: 'P2', choices: [{ cluster_id: 'c1', first_pick: 1, strength: 50, reason: 'cheaper' }] },
  ];

  const honest: DemandLogEntry[] = [
    { persona: 'P1', choices: [{ cluster_id: 'c1', first_pick: 0, strength: 100, reason: 'the one I would buy' }] },
    { persona: 'P2', choices: [{ cluster_id: 'c1', first_pick: 1, strength: 50, reason: 'cheaper' }] },
  ];

  it('would let one persona vote twice and lend conviction twice', () => {
    const { demandRaw, detail } = reduceDemand(doubled, PAIR);

    expect(demandRaw.get(0)).toBeCloseTo(0.8666666667, PRECISION);
    expect(demandRaw.get(1)).toBeCloseTo(0.4333333333, PRECISION);
    // Both halves of the double count, named separately: two votes out of three
    // from one buyer, and a two-value top-2 mean built from one answer.
    expect(detail.get(0)?.share).toBeCloseTo(2 / 3, PRECISION);
    expect(detail.get(0)?.intensity).toBeCloseTo(1.0, PRECISION);
    expect(detail.get(0)?.picks).toHaveLength(2);
    expect(detail.get(0)?.picks.every((pick) => pick.persona === 'P1')).toBe(true);
  });

  it('differs from the honest answer by exactly one buyer’s worth of demand', () => {
    const { demandRaw } = reduceDemand(honest, PAIR);

    expect(demandRaw.get(0)).toBeCloseTo(0.8, PRECISION);
    expect(demandRaw.get(1)).toBeCloseTo(0.5, PRECISION);
    // 13/15 - 4/5 = 1/15, and 13/30 - 1/2 = -1/15. The duplicate moves the pair
    // apart by 2/15 of a `demand_raw` unit on a two-product cluster.
    expect(0.8666666667 - 0.8).toBeCloseTo(1 / 15, 8);
    expect(0.4333333333 - 0.5).toBeCloseTo(-1 / 15, 8);
  });

  it('is unreachable: the validator refuses the exact payload above', () => {
    // `reduceDemand` has no defence of its own — it trusts the demand log — so
    // this is the only thing standing between a repeated answer and the
    // arithmetic in the two cases above.
    const sets = new Map<string, readonly number[]>([['c1', [0, 1]]]);
    expect(() => validateChoiceResult(DOUBLE_ANSWER, sets)).toThrow(/answered more than once/);
    // The honest one passes, so the rejection above is about the repeat and
    // nothing else in the payload.
    expect(validateChoiceResult({ choices: [DOUBLE_ANSWER.choices[0]] }, sets)).toHaveLength(1);
  });
});
