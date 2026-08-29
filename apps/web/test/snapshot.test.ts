/**
 * Board snapshots — `brief` Part 3 and `02 §4`.
 *
 * > "Boards are **CDN snapshots**, regenerated on placement. Reads never touch a
 * > model."
 *
 * Three properties, and each has a specific failure it prevents:
 *
 * 1. **A read costs nothing.** The board is served from a file a placement
 *    already wrote. If a read could reach a model, the one cost that scales with
 *    traffic rather than with sales would be the free board, which is the line
 *    `brief §2.6` says can run away.
 * 2. **Only a placement regenerates it.** Not a page view, not a status poll.
 * 3. **Old snapshots stay addressable.** `brief` Part 3, on changing the panel:
 *    "keep old snapshots permanently addressable at dated URLs so issued verdict
 *    cards still resolve". So a publish writes an immutable dated document
 *    alongside the mutable board path, and never overwrites a dated one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BOARD_CACHE_CONTROL,
  DATED_SNAPSHOT_CACHE_CONTROL,
  FileSnapshotSink,
  SNAPSHOT_VERSION,
} from '@/lib/pipeline/snapshot';
import { readRunStatus } from '@/lib/pipeline/status';

import { makeHarness, run } from './helpers/run.js';

describe('what a placement publishes', () => {
  it('writes the board path and a permanent dated one', async () => {
    const harness = makeHarness();
    await run(harness);

    expect(harness.snapshots.published).toEqual([
      {
        board: 'boards/health-fitness-wellness',
        dated: 'dated/health-fitness-wellness/cat-v1/20260301T120000000Z',
      },
    ]);
  });

  it('stamps the snapshot with the count and the moment brief Part 5 requires', async () => {
    const harness = makeHarness();
    await run(harness);

    const snapshot = await harness.snapshots.read('health-fitness-wellness');
    expect(snapshot?.snapshot_version).toBe(SNAPSHOT_VERSION);
    expect(snapshot?.product_count).toBe(8);
    expect(snapshot?.generated_at).toBe('2026-03-01T12:00:00.000Z');
    expect(snapshot?.category_version).toBe('cat-v1');
    // The payload is `ranking.json` verbatim (`02 §4`), not a second projection
    // of it — nothing here recomputes a composite that `packages/engine/src/rank/`
    // already computed.
    expect(snapshot?.ranking.ranking).toHaveLength(8);
    expect(snapshot?.ranking.category).toBe('Health, Fitness & Wellness');
  });

  it('keeps the previous dated snapshot when the category version moves', async () => {
    const first = makeHarness();
    await run(first);

    const second = makeHarness({
      store: first.store,
      snapshots: first.snapshots,
      categoryVersion: 'cat-v2',
    });
    await run(second);

    // Two dated documents, one board path. A verdict card issued against
    // `cat-v1` still resolves.
    expect(first.snapshots.keys).toContain('dated/health-fitness-wellness/cat-v1/20260301T120000000Z');
    expect(first.snapshots.keys).toContain('dated/health-fitness-wellness/cat-v2/20260301T120000000Z');
    expect(first.snapshots.keys.filter((key) => key.startsWith('boards/'))).toEqual([
      'boards/health-fitness-wellness',
    ]);
  });

  it('publishes exactly once per delivered run and never on a read', async () => {
    const harness = makeHarness();
    await run(harness);
    expect(harness.snapshots.published).toHaveLength(1);

    const callsAfterRun = harness.meter.total;
    for (let i = 0; i < 5; i += 1) {
      await harness.snapshots.read('health-fitness-wellness');
      await readRunStatus({
        store: harness.store,
        versions: harness.versions,
        snapshots: harness.snapshots,
      });
    }

    // `02 §4`: reads never touch a model. Ten reads, zero calls, and no second
    // publish — a placement is the only event that regenerates a board.
    expect(harness.meter.total).toBe(callsAfterRun);
    expect(harness.snapshots.published).toHaveLength(1);
  });
});

describe('the cache headers', () => {
  it('lets the CDN hold a board but never a browser', () => {
    // `brief §1.2` reshuffles every rank on every placement, so a locally cached
    // board shows positions that no longer exist.
    expect(BOARD_CACHE_CONTROL).toContain('max-age=0');
    expect(BOARD_CACHE_CONTROL).toContain('s-maxage=');
    expect(BOARD_CACHE_CONTROL).toContain('stale-while-revalidate=');
  });

  it('caches a dated snapshot forever, because it cannot change', () => {
    expect(DATED_SNAPSHOT_CACHE_CONTROL).toContain('immutable');
  });
});

describe('the filesystem sink', () => {
  it('round-trips a published board', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pit-snapshots-'));
    try {
      const harness = makeHarness({ snapshots: undefined });
      const sink = new FileSnapshotSink(root);
      harness.deps.snapshots = sink;
      await run(harness);

      const snapshot = await sink.read('health-fitness-wellness');
      expect(snapshot?.product_count).toBe(8);
      expect(await sink.read('no-such-category')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
