/**
 * GOLDEN FIXTURES — blending and ordering, `01 §6.3` / `01 §6.4`, with the
 * `DECISIONS.md` S3 correction.
 *
 * Every expected number was computed BY HAND and the arithmetic is written out
 * above each block. Nothing here was produced by running the implementation.
 */

import { describe, expect, it } from 'vitest';

import { blend, finalOrder, meritOrder, ranksFrom } from '../../src/rank/blend.js';

const PRECISION = 9;
const IDS = [0, 1, 2, 3];

/*
 * SHARED MERIT AXIS for the S3 fixtures.
 *
 *   composite = [2, 1, -1, -2]
 *   mean   = 0
 *   sumsq  = 4 + 1 + 1 + 4 = 10
 *   var    = 10/4 = 2.5                    (population: divide by N)
 *   popstd = sqrt(2.5) = 1.5811388301
 *   z_merit = [ 2, 1, -1, -2] / 1.5811388301
 *           = [1.2649110641, 0.6324555320, -0.6324555320, -1.2649110641]
 *
 * SHARED DEMAND AXIS: three products carry demand_raw [0.8, 0.5, 0.2].
 *   mean   = 1.5/3 = 0.5
 *   devs   = [0.3, 0, -0.3]
 *   sumsq  = 0.09 + 0 + 0.09 = 0.18
 *   var    = 0.18/3 = 0.06
 *   popstd = sqrt(0.06) = 0.2449489743
 *   z_demand = [0.3, 0, -0.3] / 0.2449489743
 *            = [1.2247448714, 0, -1.2247448714]
 *
 * The demand population is the products that HAVE a demand entry, and only
 * those. That is what makes `01 §6.3`'s own claim -- that a missing demand
 * signal "neither gains nor loses on the demand axis" -- true: 0 is then exactly
 * the mean of the distribution. Padding the population with pseudo-zeros for
 * unscored products would drag its mean down and turn every real 0 into a
 * penalty.
 */
const COMPOSITE = new Map([
  [0, 2],
  [1, 1],
  [2, -1],
  [3, -2],
]);
const Z_MERIT = [1.2649110641, 0.6324555320, -0.6324555320, -1.2649110641];
const NO_UNIQUENESS = new Map<number, number>();

describe('blend — z_merit and z_demand, `01 §6.3`', () => {
  it('standardizes the composite across every product', () => {
    const rows = blend({
      productIds: IDS,
      composite: COMPOSITE,
      demandRaw: new Map(),
      uniqueness: NO_UNIQUENESS,
    });
    rows.forEach((row, index) => expect(row.z_merit).toBeCloseTo(Z_MERIT[index] as number, PRECISION));
  });

  it('standardizes demand over the products that have a demand entry', () => {
    const rows = blend({
      productIds: IDS,
      composite: COMPOSITE,
      demandRaw: new Map([
        [0, 0.8],
        [1, 0.5],
        [2, 0.2],
      ]),
      uniqueness: NO_UNIQUENESS,
    });
    expect(rows[0]?.z_demand).toBeCloseTo(1.2247448714, PRECISION);
    expect(rows[1]?.z_demand).toBeCloseTo(0, PRECISION);
    expect(rows[2]?.z_demand).toBeCloseTo(-1.2247448714, PRECISION);
    expect(rows[3]?.z_demand).toBeUndefined();
  });
});

describe('blend — GOLDEN: a WEAK solo product LOSES under DECISIONS.md S3', () => {
  /*
   * Products 0, 1, 2 sit in a real cluster and carry demand_raw [0.8, 0.5, 0.2].
   * Product 3 -- the weakest on merit -- is alone in its cluster, so `01 §5.3`
   * never convened the panel on it and it has NO demand entry.
   *
   *   core[0] = 0.65*1.2649110641 + 0.35*1.2247448714
   *           = 0.8221921917 + 0.4286607050 =  1.2508528966
   *   core[1] = 0.65*0.6324555320 + 0.35*0
   *           = 0.4110960958      + 0        =  0.4110960958
   *   core[2] = 0.65*(-0.6324555320) + 0.35*(-1.2247448714)
   *           = -0.4110960958 - 0.4286607050 = -0.8397568008
   *   core[3] = z_merit[3]  (S3: merit alone at weight 1.0)
   *           =                               -1.2649110641
   *
   * Under the SUPERSEDED `01 §6.3` rule, product 3 would have taken
   *   0.65*(-1.2649110641) + 0.35*0 = -0.8221921916
   * which is ABOVE core[2] = -0.8397568008. The old rule would have lifted the
   * weakest product on the board over a rival with a real demand signal, purely
   * because nobody could be asked about it. That is the bug S3 fixes.
   */
  const rows = blend({
    productIds: IDS,
    composite: COMPOSITE,
    demandRaw: new Map([
      [0, 0.8],
      [1, 0.5],
      [2, 0.2],
    ]),
    uniqueness: NO_UNIQUENESS,
  });

  it('blends 0.65/0.35 for the products that have a demand entry', () => {
    expect(rows[0]?.core).toBeCloseTo(1.2508528966, PRECISION);
    expect(rows[1]?.core).toBeCloseTo(0.4110960958, PRECISION);
    expect(rows[2]?.core).toBeCloseTo(-0.8397568008, PRECISION);
  });

  it('ranks the solo product on merit alone at full weight', () => {
    expect(rows[3]?.core).toBeCloseTo(-1.2649110641, PRECISION);
    expect(rows[3]?.core).toBeCloseTo(rows[3]?.z_merit as number, PRECISION);
  });

  it('does NOT apply the superseded `0.65*z_merit + 0.35*0` rule', () => {
    expect(rows[3]?.core).not.toBeCloseTo(-0.8221921916, 6);
  });

  it('pushes the weak solo product DOWN, below the rival it would have beaten', () => {
    expect(rows[3]?.core).toBeLessThan(rows[2]?.core as number);
    // The old rule would have put it above:
    expect(0.65 * (rows[3]?.z_merit as number)).toBeGreaterThan(rows[2]?.core as number);
    expect(finalOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('labels the demand_status of every product', () => {
    expect(rows.map((row) => row.demand_status)).toEqual([
      'scored',
      'scored',
      'scored',
      'solo_cluster',
    ]);
    expect(rows[3]?.demand).toBeUndefined();
  });
});

describe('blend — GOLDEN: a STRONG solo product GAINS by exactly the same amount', () => {
  /*
   * The mirror of the case above: the SAME merit axis, but now product 0 -- the
   * strongest -- is the solo one, and products 1, 2, 3 carry demand_raw
   * [0.8, 0.5, 0.2] (so the same z_demand values, in the same order).
   *
   *   core[0] = z_merit[0]                     =  1.2649110641   (S3)
   *   core[1] = 0.65*0.6324555320 + 0.35*1.2247448714
   *           = 0.4110960958 + 0.4286607050    =  0.8397568008
   *   core[2] = 0.65*(-0.6324555320) + 0.35*0  = -0.4110960958
   *   core[3] = 0.65*(-1.2649110641) + 0.35*(-1.2247448714)
   *           = -0.8221921917 - 0.4286607050   = -1.2508528966
   *
   * Under the superseded rule product 0 would have taken 0.8221921916, BELOW
   * core[1] = 0.8397568008, and would have been knocked off the top of the board.
   *
   * Read the two fixtures together: renormalizing moved product 3 down by
   * 0.35*|z_merit| in the first, and product 0 up by 0.35*|z_merit| here. It is
   * an amplifier, not a bonus -- so writing an idiosyncratic description to
   * escape a cluster cannot improve expected rank (Global Constraint 3).
   */
  const rows = blend({
    productIds: IDS,
    composite: COMPOSITE,
    demandRaw: new Map([
      [1, 0.8],
      [2, 0.5],
      [3, 0.2],
    ]),
    uniqueness: NO_UNIQUENESS,
  });

  it('lifts the strong solo product to its full merit', () => {
    expect(rows[0]?.core).toBeCloseTo(1.2649110641, PRECISION);
    expect(rows[1]?.core).toBeCloseTo(0.8397568008, PRECISION);
    expect(rows[2]?.core).toBeCloseTo(-0.4110960958, PRECISION);
    expect(rows[3]?.core).toBeCloseTo(-1.2508528966, PRECISION);
  });

  it('keeps it on top, where the superseded rule would have demoted it', () => {
    expect(finalOrder(rows)).toEqual([0, 1, 2, 3]);
    expect(0.65 * (rows[0]?.z_merit as number)).toBeLessThan(rows[1]?.core as number);
  });

  it('moves a solo product by |0.35 * z_merit| in whichever direction its merit points', () => {
    // Weak solo (previous fixture) lost 0.35*|z_merit|; strong solo gains it.
    const gain = (rows[0]?.core as number) - 0.65 * (rows[0]?.z_merit as number);
    expect(gain).toBeCloseTo(0.35 * (rows[0]?.z_merit as number), PRECISION);
    expect(gain).toBeGreaterThan(0);
  });
});

describe('blend — every product solo: the board is pure merit', () => {
  it('falls back to merit alone when no demand signal exists at all', () => {
    const rows = blend({
      productIds: IDS,
      composite: COMPOSITE,
      demandRaw: new Map(),
      uniqueness: NO_UNIQUENESS,
    });
    rows.forEach((row, index) => {
      expect(row.core).toBeCloseTo(Z_MERIT[index] as number, PRECISION);
      expect(row.demand_status).toBe('solo_cluster');
    });
  });
});

/*
 * UNIQUENESS TILT AXIS — `01 §6.3`, `DECISIONS.md` S2.
 *
 *   rank_key = core + 0.075 * (U - 50) / 50
 *            = core + 0.075 at U = 100
 *            = core          at U = 50
 *            = core - 0.075 at U = 0
 *
 * The full swing between one product at U=0 and another at U=100 is 0.15; the
 * swing between one at U=0 and one at neutral U=50 is 0.075.
 *
 * TIGHT board (gap inside the 0.075 window):
 *   composite = [1, 0.95, -0.95, -1]
 *   mean   = 0
 *   sumsq  = 1 + 0.9025 + 0.9025 + 1 = 3.805
 *   var    = 3.805/4 = 0.95125
 *   popstd = sqrt(0.95125) = 0.9753204602
 *   core (all solo, so core = z_merit)
 *          = [1.0253040317, 0.9740388301, -0.9740388301, -1.0253040317]
 *   gap(0,1) = 0.05/0.9753204602 = 0.0512652016   <- inside 0.075
 *
 * WIDE board (gap outside the 0.075 window but inside 0.15):
 *   composite = [1, 0.9, -0.9, -1]
 *   sumsq  = 1 + 0.81 + 0.81 + 1 = 3.62; var = 0.905
 *   popstd = sqrt(0.905) = 0.9513148795
 *   core   = [1.0511766625, 0.9460589962, -0.9460589962, -1.0511766625]
 *   gap(0,1) = 0.1/0.9513148795 = 0.1051176662     <- outside 0.075, inside 0.15
 */
const TIGHT = new Map([
  [0, 1],
  [1, 0.95],
  [2, -0.95],
  [3, -1],
]);
const WIDE = new Map([
  [0, 1],
  [1, 0.9],
  [2, -0.9],
  [3, -1],
]);

function tilt(composite: Map<number, number>, uniqueness: Map<number, number>) {
  return blend({ productIds: IDS, composite, demandRaw: new Map(), uniqueness });
}

describe('blend — GOLDEN: the uniqueness tilt at U = 0, 50 and 100', () => {
  it('applies no tilt at U = 50 and the full +/- 0.075 at the ends', () => {
    const rows = tilt(
      TIGHT,
      new Map([
        [0, 0],
        [1, 50],
        [2, 100],
        [3, 50],
      ]),
    );
    // rank_key = core + tilt
    expect(rows[0]?.rank_key).toBeCloseTo(1.0253040317 - 0.075, PRECISION); // 0.9503040317
    expect(rows[1]?.rank_key).toBeCloseTo(0.9740388301, PRECISION); // U=50, no tilt
    expect(rows[2]?.rank_key).toBeCloseTo(-0.9740388301 + 0.075, PRECISION); // -0.8990388301
    expect(rows[3]?.rank_key).toBeCloseTo(-1.0253040317, PRECISION);
  });

  it('assumes UNIQ_NEUTRAL = 50 and applies no tilt when uniqueness is missing', () => {
    const rows = tilt(TIGHT, new Map());
    rows.forEach((row) => {
      expect(row.uniqueness).toBe(50);
      expect(row.rank_key).toBeCloseTo(row.core, PRECISION);
    });
  });

  it('changes order where core is inside the window', () => {
    /*
     * TIGHT board, gap(0,1) = 0.0512652016 < 0.075.
     * Product 0 at U=0 (tilt -0.075), product 1 at neutral U=50 (tilt 0):
     *   rank_key[0] = 1.0253040317 - 0.075 = 0.9503040317
     *   rank_key[1] = 0.9740388301
     *   0.9503040317 < 0.9740388301 -> product 1 overtakes product 0.
     */
    const rows = tilt(
      TIGHT,
      new Map([
        [0, 0],
        [1, 50],
        [2, 50],
        [3, 50],
      ]),
    );
    expect(rows[0]?.rank_key).toBeCloseTo(0.9503040317, PRECISION);
    expect(rows[1]?.rank_key).toBeCloseTo(0.9740388301, PRECISION);
    expect(finalOrder(rows)).toEqual([1, 0, 2, 3]);
    // and the merit order is untouched -- merit is independent of uniqueness
    expect(meritOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('does NOT change order where core is outside the window', () => {
    /*
     * WIDE board, gap(0,1) = 0.1051176662 > 0.075. Same U=0 vs U=50 tilt:
     *   rank_key[0] = 1.0511766625 - 0.075 = 0.9761766625
     *   rank_key[1] = 0.9460589962
     *   0.9761766625 > 0.9460589962 -> no flip. A real merit gap survives.
     */
    const rows = tilt(
      WIDE,
      new Map([
        [0, 0],
        [1, 50],
        [2, 50],
        [3, 50],
      ]),
    );
    expect(rows[0]?.rank_key).toBeCloseTo(0.9761766625, PRECISION);
    expect(rows[1]?.rank_key).toBeCloseTo(0.9460589962, PRECISION);
    expect(finalOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('changes order on the WIDE board only when the full 0.15 swing is in play', () => {
    /*
     * Same WIDE board, but now product 0 at U=0 and product 1 at U=100:
     *   rank_key[0] = 1.0511766625 - 0.075 = 0.9761766625
     *   rank_key[1] = 0.9460589962 + 0.075 = 1.0210589962
     *   -> product 1 overtakes. 0.1051176662 < 0.15, so this is still bounded.
     */
    const rows = tilt(
      WIDE,
      new Map([
        [0, 0],
        [1, 100],
        [2, 50],
        [3, 50],
      ]),
    );
    expect(rows[0]?.rank_key).toBeCloseTo(0.9761766625, PRECISION);
    expect(rows[1]?.rank_key).toBeCloseTo(1.0210589962, PRECISION);
    expect(finalOrder(rows)).toEqual([1, 0, 2, 3]);
  });

  it('never overrides a real merit gap: 0.15 cannot cross a gap of 2.1', () => {
    /*
     * WIDE board, product 0 at U=0 and product 3 at U=100 -- the maximum
     * possible tilt against the top product and for the bottom one.
     *   rank_key[0] =  1.0511766625 - 0.075 =  0.9761766625
     *   rank_key[3] = -1.0511766625 + 0.075 = -0.9761766625
     * The core gap between them is 2.1023533250; the tilt can move 0.15 of it.
     * The tilt is ~7.5% of one population std by construction (`DECISIONS.md`
     * S2), so it is worth a few places at most, never a reordering of the board.
     * Nothing moves here: the order is still 0, 1, 2, 3.
     */
    const rows = tilt(
      WIDE,
      new Map([
        [0, 0],
        [1, 50],
        [2, 50],
        [3, 100],
      ]),
    );
    expect(rows[0]?.rank_key).toBeCloseTo(0.9761766625, PRECISION);
    expect(rows[3]?.rank_key).toBeCloseTo(-0.9761766625, PRECISION);
    expect(finalOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('flips BOTH close neighbour pairs on a tight board, and nothing else', () => {
    /*
     * TIGHT board, U = [0, 50, 50, 100]. Two independent inside-window flips:
     *   rank_key[0] =  1.0253040317 - 0.075 =  0.9503040317  <  rank_key[1] =  0.9740388301
     *   rank_key[3] = -1.0253040317 + 0.075 = -0.9503040317  >  rank_key[2] = -0.9740388301
     * -> order 1, 0, 3, 2. The top pair and the bottom pair each swap; nothing
     * crosses the middle, where the gap is ~1.95.
     */
    const rows = tilt(
      TIGHT,
      new Map([
        [0, 0],
        [1, 50],
        [2, 50],
        [3, 100],
      ]),
    );
    expect(rows[0]?.rank_key).toBeCloseTo(0.9503040317, PRECISION);
    expect(rows[3]?.rank_key).toBeCloseTo(-0.9503040317, PRECISION);
    expect(finalOrder(rows)).toEqual([1, 0, 3, 2]);
  });

  it('clamps an out-of-range uniqueness score onto the 0-100 scale', () => {
    // `01 §6` `_clamp(x, 0, 100, default=50)`: U=140 cannot buy more than +0.075.
    const rows = tilt(
      TIGHT,
      new Map([
        [0, 140],
        [1, -20],
        [2, 50],
        [3, 50],
      ]),
    );
    expect(rows[0]?.uniqueness).toBe(100);
    expect(rows[0]?.rank_key).toBeCloseTo(1.0253040317 + 0.075, PRECISION);
    expect(rows[1]?.uniqueness).toBe(0);
    expect(rows[1]?.rank_key).toBeCloseTo(0.9740388301 - 0.075, PRECISION);
  });
});

describe('finalOrder / meritOrder — `01 §6.4`', () => {
  const rows = blend({
    productIds: IDS,
    composite: COMPOSITE,
    demandRaw: new Map(),
    uniqueness: NO_UNIQUENESS,
  });

  it('sorts the final order by (-rank_key, -core, -composite, id)', () => {
    expect(finalOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('sorts the merit order by (-composite, id)', () => {
    expect(meritOrder(rows)).toEqual([0, 1, 2, 3]);
  });

  it('breaks a total tie by ascending id, so a run is reproducible', () => {
    const tied = blend({
      productIds: [7, 3, 5],
      composite: new Map([
        [7, 1],
        [3, 1],
        [5, 1],
      ]),
      demandRaw: new Map(),
      uniqueness: new Map(),
    });
    // All composites equal -> popstd 0 -> every z_merit 0 -> every core and
    // rank_key 0. The only remaining key is the id.
    expect(finalOrder(tied)).toEqual([3, 5, 7]);
    expect(meritOrder(tied)).toEqual([3, 5, 7]);
  });

  it('numbers ranks from 1', () => {
    expect([...ranksFrom([5, 2, 9])]).toEqual([
      [5, 1],
      [2, 2],
      [9, 3],
    ]);
  });
});
