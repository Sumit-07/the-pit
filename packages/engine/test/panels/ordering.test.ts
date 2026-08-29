import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE } from '../../src/config/constants.js';
import { chunkItems } from '../../src/rank/index.js';
import { orderedChunks, panelOrder } from '../../src/panels/index.js';
import type { PanelOrdering } from '../../src/panels/index.js';
import { product } from '../helpers/samples.js';

/**
 * `Product.id` is assigned after sorting by the source sheet's `Rank`
 * (`src/ingest/load-category.ts`), so id order IS the incoming leaderboard. These
 * tests pin the two properties that fix depends on.
 */

const ORDERING: PanelOrdering = { category: 'Health, Fitness & Wellness', categoryVersion: 'v7' };

/** A category of `n` products, ids 0..n-1 — i.e. incoming rank order. */
function category(n: number): ReturnType<typeof product>[] {
  return Array.from({ length: n }, (_, id) => product(id, `Product ${id}`, `Description ${id}`));
}

const ids = (items: readonly { id: number }[]): number[] => items.map((item) => item.id);

/** Whether a build output is missing or older than its source. */
function isStale(source: string, built: string): boolean {
  if (!existsSync(built)) return true;
  return statSync(built).mtimeMs < statSync(source).mtimeMs;
}

describe('panelOrder — decorrelates render order from incoming rank', () => {
  it('does not render in id order', () => {
    const ordered = panelOrder(category(44), ORDERING);
    expect(ids(ordered)).not.toEqual([...Array(44).keys()]);
  });

  it('is a permutation: every product exactly once, none invented', () => {
    const ordered = panelOrder(category(44), ORDERING);
    expect(ordered).toHaveLength(44);
    expect([...ids(ordered)].sort((a, b) => a - b)).toEqual([...Array(44).keys()]);
  });

  it('never reassigns an id — the join key is untouched', () => {
    const source = category(20);
    const ordered = panelOrder(source, ORDERING);
    for (const item of ordered) {
      expect(source[item.id]).toEqual(item);
    }
  });

  it('leaves no monotone relationship with orig_rank', () => {
    // Kendall-tau-ish: count adjacent pairs still in ascending id order. Under the
    // identity permutation this is every pair; a shuffle should be near half.
    const ordered = ids(panelOrder(category(44), ORDERING));
    const ascending = ordered.filter((id, index) => index > 0 && id > ordered[index - 1]!).length;
    expect(ascending).toBeGreaterThan(8);
    expect(ascending).toBeLessThan(35);
  });
});

describe('panelOrder — stable', () => {
  it('returns the identical order on every call', () => {
    const first = ids(panelOrder(category(44), ORDERING));
    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(ids(panelOrder(category(44), ORDERING))).toEqual(first);
    }
  });

  it('does not depend on the order the caller’s array happened to be in', () => {
    const forwards = category(44);
    const backwards = [...forwards].reverse();
    expect(ids(panelOrder(backwards, ORDERING))).toEqual(ids(panelOrder(forwards, ORDERING)));
  });

  it('seeds on the category slug, so re-casing the name changes nothing', () => {
    const recased = { ...ORDERING, category: 'health,   FITNESS & wellness' };
    expect(ids(panelOrder(category(44), recased))).toEqual(ids(panelOrder(category(44), ORDERING)));
  });

  it('gives different categories different orders at the same version', () => {
    const other = { ...ORDERING, category: 'Developer Tools' };
    expect(ids(panelOrder(category(44), other))).not.toEqual(ids(panelOrder(category(44), ORDERING)));
  });

  it('redraws when the category version is bumped', () => {
    const bumped = { ...ORDERING, categoryVersion: 'v8' };
    expect(ids(panelOrder(category(44), bumped))).not.toEqual(ids(panelOrder(category(44), ORDERING)));
  });

  it('reproduces a permutation recorded from another process', () => {
    // A golden: computed once and asserted forever after. This is what "the same
    // in every process, on every machine" means operationally — if the PRNG, the
    // seed derivation or the canonical pre-sort ever drifts, this fails.
    expect(ids(panelOrder(category(12), { category: 'Developer Tools', categoryVersion: 'v1' }))).toEqual([
      5, 0, 1, 8, 4, 11, 6, 2, 10, 9, 3, 7,
    ]);
  });

  it('is reproduced by a separate Node process running the built package', () => {
    // The golden above proves stability across runs of this suite. This proves it
    // across an independent process with its own module registry and its own PRNG
    // state — but it can only read the BUILT package, so it skips rather than
    // fails when `dist/` is absent or older than the source it would be testing.
    // The literal above is the assertion that always runs; this one adds the
    // second process when there is a build to run it against.
    if (!existsSync('dist/index.js') || isStale('src/panels/ordering.ts', 'dist/panels/ordering.js')) return;

    const script = `
      const { panelOrder } = await import('./dist/index.js');
      const items = Array.from({ length: 12 }, (_, id) => ({ id }));
      process.stdout.write(JSON.stringify(panelOrder(items, { category: 'Developer Tools', categoryVersion: 'v1' }).map((i) => i.id)));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([5, 0, 1, 8, 4, 11, 6, 2, 10, 9, 3, 7]);
  });

  it('refuses an ordering that would silently mis-seed', () => {
    expect(() => panelOrder(category(4), { ...ORDERING, categoryVersion: '' })).toThrow(RangeError);
    expect(() => panelOrder(category(4), { ...ORDERING, category: '---' })).toThrow(RangeError);
  });
});

describe('orderedChunks — the rank-contiguous chunk defect', () => {
  const HEALTH_AND_FITNESS = 44;

  it('splits 44 into 22/22, exactly as balancedChunks does', () => {
    const chunks = orderedChunks(category(HEALTH_AND_FITNESS), ORDERING);
    expect(chunks.map((chunk) => chunk.length)).toEqual([22, 22]);
  });

  it('does NOT produce rank-contiguous chunks', () => {
    // The defect: in id order, chunk 1 is ranks 1-22 and chunk 2 is ranks 23-44,
    // so comparative scoring calibrates each half against a different field and
    // `computeComposite` then z-normalizes two populations as one.
    const naive = chunkItems(category(HEALTH_AND_FITNESS), CHUNK_SIZE);
    expect(ids(naive[0]!)).toEqual([...Array(22).keys()]);

    const chunks = orderedChunks(category(HEALTH_AND_FITNESS), ORDERING);
    for (const chunk of chunks) {
      const chunkIds = ids(chunk);
      expect(Math.max(...chunkIds) - Math.min(...chunkIds)).toBeGreaterThan(chunk.length);
      // Both chunks must straddle the incoming leaderboard's midpoint.
      expect(chunkIds.some((id) => id < HEALTH_AND_FITNESS / 2)).toBe(true);
      expect(chunkIds.some((id) => id >= HEALTH_AND_FITNESS / 2)).toBe(true);
    }
  });

  it('gives every chunk a comparable mean incoming rank', () => {
    const chunks = orderedChunks(category(HEALTH_AND_FITNESS), ORDERING);
    const means = chunks.map((chunk) => ids(chunk).reduce((sum, id) => sum + id, 0) / chunk.length);
    const naiveMeans = chunkItems(category(HEALTH_AND_FITNESS), CHUNK_SIZE).map(
      (chunk) => ids(chunk).reduce((sum, id) => sum + id, 0) / chunk.length,
    );

    // The naive split separates the halves by the full 22 ranks; the ordered one
    // must land both chunks near the category mean of 21.5.
    expect(Math.abs(naiveMeans[0]! - naiveMeans[1]!)).toBe(22);
    expect(Math.abs(means[0]! - means[1]!)).toBeLessThan(8);
  });

  it('drops nothing and duplicates nothing', () => {
    const chunks = orderedChunks(category(48), ORDERING);
    expect(chunks.flatMap(ids).sort((a, b) => a - b)).toEqual([...Array(48).keys()]);
  });

  it('is stable, so the six jurors of a run share one prompt prefix', () => {
    const first = orderedChunks(category(48), ORDERING).map(ids);
    expect(orderedChunks(category(48), ORDERING).map(ids)).toEqual(first);
  });
});
