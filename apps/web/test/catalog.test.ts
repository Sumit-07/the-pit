/**
 * The pipeline against the real seeded categories on disk.
 *
 * Everything else in this suite runs on fixtures, which proves the pipeline's
 * shape but not that it can read anything real. These tests point
 * `FileCategorySource`, `FilePipelineStore` and `readRunStatus` at
 * `cjr/runs/developer-tools` — a category seeded in Phase 1 and committed to the
 * branch — and check that the status surfaces reconstruct it correctly from the
 * artifacts the engine actually wrote.
 *
 * Still offline: no network, no database, no API key, and no model client
 * anywhere in the path. `02 §4` — reads never touch a model.
 *
 * Hand-derived from `cjr/runs/developer-tools/`: 48 products, 6 jurors, so the
 * vote cache holds 6 x 48 = 288 rows. The stored phases are stamped
 * `category_version: "v2"` and the installed jury's `prompt_version` is `"v2"`,
 * which is the default `FileCategorySource` supplies — so the phases resume.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FileCategorySource } from '@/lib/pipeline/catalog';
import { loadRunStatus, type RunnerBindings } from '@/lib/pipeline/service';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { FilePipelineStore } from '@/lib/pipeline/store';
import { readVoteCache } from '@/lib/pipeline/vote-cache';

import { PROMPT_VERSION } from './helpers/panel.js';

/** `cjr/` at the repository root, resolved from this file rather than from the cwd. */
const WORKDIR = fileURLToPath(new URL('../../../cjr', import.meta.url));

/** The seeded categories are committed, but a checkout could be missing them. */
const seeded = existsSync(WORKDIR);

function bindings(): RunnerBindings {
  return {
    categories: new FileCategorySource(WORKDIR),
    store: (category: string) => new FilePipelineStore(category, WORKDIR),
    snapshots: new MemorySnapshotSink(),
  };
}

describe.skipIf(!seeded)('a seeded category on disk', () => {
  it('loads its approved panels and its pinned product ids', async () => {
    const input = await new FileCategorySource(WORKDIR).load('developer-tools');
    expect(input?.category).toBe('Developer Tools');
    expect(input?.products).toHaveLength(48);
    // `Product.id` is read from `products.json`, never re-derived: re-deriving it
    // from a sheet that gained a row renumbers every product, and ids are how
    // every stored score and vote attaches to one.
    expect(input?.products[0]?.id).toBe(0);
    expect(input?.jury.jurors).toHaveLength(6);
    expect(input?.config.categoryVersion).toBe('v2');
  });

  it('reconstructs a finished run as delivered work, from the artifacts alone', async () => {
    const lookup = await loadRunStatus('developer-tools', bindings());
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error('unreachable');

    const byStep = new Map(lookup.status.steps.map((step) => [step.step, step]));
    expect(byStep.get('score')?.state).toBe('done');
    expect(byStep.get('cluster')?.state).toBe('done');
    expect(byStep.get('persona')?.state).toBe('done');
    expect(byStep.get('rank')?.state).toBe('done');
    // No snapshot has ever been published for this category — the Phase 1 seed
    // ran the engine's CLI, not this pipeline. So `deliver` is honestly pending.
    expect(byStep.get('deliver')?.state).toBe('pending');
    expect(lookup.status.completed).toBe(4);
  });

  it('counts every banked juror vote', async () => {
    const lookup = await loadRunStatus('developer-tools', bindings());
    if (!lookup.found) throw new Error('unreachable');
    // 6 jurors x 48 products.
    expect(lookup.status.votes_cached).toBe(288);
  });

  it('banks nothing once the rubric moves', async () => {
    const store = new FilePipelineStore('Developer Tools', WORKDIR);
    const cache = await readVoteCache(store, {
      category_version: 'v2',
      prompt_version: PROMPT_VERSION,
      persona_version: 'v1',
      engine_version: '0.1.0',
    });
    // `PROMPT_VERSION` is this suite's fixture version, not the seeded `v2`. A
    // stored phase under a version that has moved is a stale answer, not a saving.
    expect(cache.size).toBe(0);
  });

  it('reports a slug nobody has seeded as not found rather than as an empty run', async () => {
    expect((await loadRunStatus('no-such-category', bindings())).found).toBe(false);
  });
});
