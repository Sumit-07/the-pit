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
 *
 * ## What a fresh checkout has, and what it does not
 *
 * `products.json`, `ranking.json` and both approved panels are committed, so the
 * `rank` step, the pinned ids and the panels are read the same way everywhere.
 * The three MODEL phases are not: `cjr/runs/<slug>/phases/` is git-ignored, and the
 * score, uniqueness and customer envelopes are the only record of them. A fresh
 * checkout therefore has a board with no phases behind it, which the status page
 * honestly reports as one completed step rather than four.
 *
 * The assertions that need those envelopes say so with `skipIf`. A fixture copy
 * was considered and rejected: at full fidelity it is ~1.08 MB of artifacts this
 * repository already has, and a trimmed copy would be a board whose z-scores and
 * health were computed over a population it no longer contains — a run that never
 * happened, asserted against as though it had. `test/status.test.ts` already
 * proves every step-state and vote-cache rule against built fixtures; what these
 * two add is that the real files on disk deserialize into them, which is a claim
 * only the real files can make.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FileCategorySource } from '@/lib/pipeline/catalog';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { loadRunStatus, type RunnerBindings } from '@/lib/pipeline/service';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { FilePipelineStore } from '@/lib/pipeline/store';
import { readVoteCache } from '@/lib/pipeline/vote-cache';

import { PROMPT_VERSION } from './helpers/panel.js';

/** `cjr/` at the repository root, resolved from this file rather than from the cwd. */
const WORKDIR = fileURLToPath(new URL('../../../cjr', import.meta.url));

/** The seeded categories are committed, but a checkout could be missing them. */
const seeded = existsSync(WORKDIR);

/**
 * Whether the run's persisted phase envelopes are beside its board. See the
 * module header: `phases/` is git-ignored, so this is true on the machine that
 * produced the run and false in a fresh checkout.
 */
const hasPhases = existsSync(join(WORKDIR, 'runs', 'developer-tools', 'phases', 'score.json'));

function bindings(): RunnerBindings {
  return {
    categories: new FileCategorySource(WORKDIR),
    store: (category: string) => new FilePipelineStore(category, WORKDIR),
    claims: new MemoryPlacementClaims(),
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

  it('reads the committed board back as a ranked, undelivered run', async () => {
    const lookup = await loadRunStatus('developer-tools', bindings());
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error('unreachable');

    const byStep = new Map(lookup.status.steps.map((step) => [step.step, step]));
    // `ranking.json` is committed, so `rank` reads as done in every checkout.
    expect(byStep.get('rank')?.state).toBe('done');
    // No snapshot has ever been published for this category — the Phase 1 seed
    // ran the engine's CLI, not this pipeline. So `deliver` is honestly pending.
    expect(byStep.get('deliver')?.state).toBe('pending');
    // Four with the phase envelopes on disk; one — `rank` alone — without them,
    // which is the honest answer rather than a board credited with model work
    // whose record is gone.
    expect(lookup.status.completed).toBe(hasPhases ? 4 : 1);
  });

  it.skipIf(!hasPhases)('reconstructs a finished run as delivered work, from the artifacts alone', async () => {
    const lookup = await loadRunStatus('developer-tools', bindings());
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error('unreachable');

    const byStep = new Map(lookup.status.steps.map((step) => [step.step, step]));
    expect(byStep.get('score')?.state).toBe('done');
    expect(byStep.get('cluster')?.state).toBe('done');
    expect(byStep.get('persona')?.state).toBe('done');
  });

  it.skipIf(!hasPhases)('counts every banked juror vote', async () => {
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
    // Without `phases/` on disk the cache is empty for the duller reason that
    // there is nothing to read; the version gate itself is asserted against built
    // fixtures in `test/status.test.ts`, which runs everywhere.
    expect(cache.size).toBe(0);
  });

  it('reports a slug nobody has seeded as not found rather than as an empty run', async () => {
    expect((await loadRunStatus('no-such-category', bindings())).found).toBe(false);
  });
});
