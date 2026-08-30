/**
 * The read path: a board comes from a JSON file, and from nothing else.
 *
 * `brief` Part 3 and `02 §4` both say a board read never touches a model, and by
 * extension never touches the database the model's output was written to. These
 * tests exercise the behaviour of that; `boards-read-path.test.ts` proves the
 * structural half by walking the import graph.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileBoardSource, isBoardSlug, resolveWorkdir, SnapshotBoardSource } from '@/lib/boards/source';
import { BucketSnapshotSink } from '@/lib/pipeline/bucket';
import { defaultBindings } from '@/lib/pipeline/service';
import { defaultSnapshotSink } from '@/lib/pipeline/sink';
import { FileSnapshotSink, MemorySnapshotSink, type BoardSnapshot } from '@/lib/pipeline/snapshot';

import { sampleRanking, SAMPLE_CAVEAT, writePublishedSnapshot, writeSeededWorkdir } from './helpers/boards';

const scratch: string[] = [];

async function seeded(slug = 'developer-tools'): Promise<string> {
  const workdir = await writeSeededWorkdir({ slug });
  scratch.push(workdir);
  return workdir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['PIT_WORKDIR'];
  delete process.env['PIT_SNAPSHOT_ROOT'];
});

describe('reading a seeded run', () => {
  it('reads ranking.json and takes its provenance from results.json', async () => {
    const workdir = await seeded();
    const document_ = await new FileBoardSource({ workdir }).read('developer-tools');

    expect(document_?.origin).toBe('seeded-run');
    expect(document_?.category).toBe('Developer Tools');
    expect(document_?.productCount).toBe(3);
    expect(document_?.engineVersion).toBe('0.1.0-test');
    expect(document_?.categoryVersion).toBe('v2');
    expect(document_?.caveat).toBe(SAMPLE_CAVEAT);

    // Every row of a seeded run is anonymous, and the document it hands back has
    // already had the identities taken out of it — `DECISIONS.md`'s resolution of
    // S4-source. So the first row wears a designation, not the name the workbook
    // carried, and the real name is not in the document at all.
    expect(document_?.anonymousIds).toEqual(document_?.ranking.ranking.map((row) => row.id));
    expect(document_?.ranking.ranking[0]?.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
    expect(JSON.stringify(document_?.ranking)).not.toContain('Ashgrove');
  });

  it('stamps the board with the ranking file mtime, not with "now"', async () => {
    const workdir = await seeded();
    const document_ = await new FileBoardSource({ workdir }).read('developer-tools');
    // A board whose stamp said "now" on every read would claim a rebuild that
    // never happened. The mtime is a real event; assert it is not drifting.
    const again = await new FileBoardSource({ workdir }).read('developer-tools');
    expect(document_?.generatedAt).toBe(again?.generatedAt);
  });

  it('falls back to the ranking prompt_version when results.json is unreadable', async () => {
    const workdir = await seeded();
    await writeFile(join(workdir, 'runs', 'developer-tools', 'results.json'), '{ not json', 'utf8');

    const document_ = await new FileBoardSource({ workdir }).read('developer-tools');
    expect(document_?.categoryVersion).toBe('v2');
    expect(document_?.engineVersion).toBeUndefined();
    // The footer says the provenance is unknown rather than rendering a clean one.
    expect(document_?.caveat).toBeUndefined();
  });
});

describe('a published snapshot wins', () => {
  it('prefers the document a placement wrote over the seeded run beside it', async () => {
    const workdir = await seeded();
    await writePublishedSnapshot(workdir, {
      slug: 'developer-tools',
      category: 'Developer Tools',
      generated_at: '2026-09-01T02:00:00.000Z',
      product_count: 3,
      ranking: sampleRanking({ prompt_version: 'v3' }),
    });

    const document_ = await new FileBoardSource({ workdir }).read('developer-tools');
    expect(document_?.origin).toBe('snapshot');
    expect(document_?.generatedAt).toBe('2026-09-01T02:00:00.000Z');
    expect(document_?.categoryVersion).toBe('v9');
    expect(document_?.engineVersion).toBe('0.1.0-published');
    expect(document_?.ranking.prompt_version).toBe('v3');
  });
});

describe('a placement is what the public board shows', () => {
  /**
   * A board snapshot, exactly as the pipeline's `deliver` step builds one.
   *
   * Hand-built rather than run through `buildSnapshot`, because that function
   * needs `ENGINE_VERSION` and lives on the write side; what is under test is the
   * READ, and it must not be given the write side's help to pass.
   */
  function published(overrides: { productCount: number; generatedAt: string; version: string }): BoardSnapshot {
    return {
      snapshot_version: 1,
      slug: 'developer-tools',
      category: 'Developer Tools',
      generated_at: overrides.generatedAt,
      product_count: overrides.productCount,
      engine_version: '0.1.0-published',
      category_version: overrides.version,
      ranking: sampleRanking(),
    };
  }

  it('reads the board a placement published, NOT the file that was there before it', async () => {
    // The gap, in one test. The read path used to `readFile` a directory while a
    // placement published through `SnapshotSink` — in production, to a bucket. So
    // a customer paid, placed, and `/boards/<slug>` went on serving the document
    // from before their submission. Nothing threw; there were simply two
    // documents in two different places, and the page read the wrong one.
    //
    // The sink here is in memory and the directory on disk holds an OLDER
    // published board. A source that still reads the file reports 3 and
    // `2026-08-01`; a source that reads through the sink reports 4 and
    // `2026-09-02`. Only one of those is the board somebody paid for.
    const workdir = await seeded();
    await writePublishedSnapshot(workdir, {
      slug: 'developer-tools',
      category: 'Developer Tools',
      generated_at: '2026-08-01T00:00:00.000Z',
      product_count: 3,
      ranking: sampleRanking(),
    });

    const snapshots = new MemorySnapshotSink();
    await snapshots.publish(published({ productCount: 4, generatedAt: '2026-09-02T09:00:00.000Z', version: 'v10' }));

    const source = new SnapshotBoardSource({ snapshots, workdir });
    const document_ = await source.read('developer-tools');

    expect(document_?.origin).toBe('snapshot');
    expect(document_?.productCount).toBe(4);
    expect(document_?.generatedAt).toBe('2026-09-02T09:00:00.000Z');
    expect(document_?.categoryVersion).toBe('v10');
  });

  it('moves again on the NEXT placement, because it holds no copy of its own', async () => {
    // `brief §1.2`: every placement moves every z-score, so the board a reader
    // gets has to be the last one published and not the first one cached in a
    // field. Two publishes, two different answers from one source object.
    const workdir = await seeded();
    const snapshots = new MemorySnapshotSink();
    const source = new SnapshotBoardSource({ snapshots, workdir });

    await snapshots.publish(published({ productCount: 4, generatedAt: '2026-09-02T09:00:00.000Z', version: 'v10' }));
    expect((await source.read('developer-tools'))?.productCount).toBe(4);

    await snapshots.publish(published({ productCount: 5, generatedAt: '2026-09-03T09:00:00.000Z', version: 'v11' }));
    const after = await source.read('developer-tools');
    expect(after?.productCount).toBe(5);
    expect(after?.categoryVersion).toBe('v11');
  });

  it('falls back to the seeded run for a category nothing has been published for', async () => {
    // The contrast that makes the two above mean something: an unpublished
    // category is the ordinary state of every board on this branch, and it still
    // renders from `cjr/runs/<slug>/ranking.json`.
    const workdir = await seeded();
    const document_ = await new SnapshotBoardSource({ snapshots: new MemorySnapshotSink(), workdir }).read(
      'developer-tools',
    );
    expect(document_?.origin).toBe('seeded-run');
    expect(document_?.productCount).toBe(3);
  });

  it('lists a slug the sink knows about and a slug only the workdir knows about', async () => {
    // A bucket cannot enumerate (`BucketSnapshotSink.list`), so the roster is the
    // seeded workdir's in production; a directory sink can, so a board published
    // for a category with no run directory still appears locally. Both halves,
    // deduplicated and sorted.
    const workdir = await seeded();
    const snapshots = new MemorySnapshotSink();
    await snapshots.publish({ ...published({ productCount: 4, generatedAt: '2026-09-02T09:00:00.000Z', version: 'v10' }), slug: 'ai-writing' });
    await snapshots.publish(published({ productCount: 4, generatedAt: '2026-09-02T09:00:00.000Z', version: 'v10' }));

    expect(await new SnapshotBoardSource({ snapshots, workdir }).list()).toEqual(['ai-writing', 'developer-tools']);
  });

  it('is the same sink the pipeline publishes through, resolved from one factory', () => {
    // `defaultBoardSource()` and `service.ts`'s bindings both call
    // `defaultSnapshotSink(env)`. Asserted on the instance rather than on the
    // source text, because the property that matters is "the same place", and in
    // filesystem mode that place is one directory.
    const env = { PIT_SNAPSHOT_ROOT: '/tmp/pit-boards-test' };
    expect(defaultSnapshotSink(env)).toBeInstanceOf(FileSnapshotSink);
    expect(defaultBindings(env).snapshots).toBeInstanceOf(FileSnapshotSink);

    // And in production it is the bucket on BOTH sides — which is the state in
    // which the old read path was silently wrong.
    const production = {
      VERCEL: '1',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example.com/pit',
      PIT_SNAPSHOT_BUCKET_URL: 'https://bucket.example.com/pit',
    };
    expect(defaultSnapshotSink(production)).toBeInstanceOf(BucketSnapshotSink);
    expect(defaultBindings(production).snapshots).toBeInstanceOf(BucketSnapshotSink);
  });
});

describe('what it refuses to crash on', () => {
  it('omits a run with no ranking.json — a category mid-seed is not an error', async () => {
    const workdir = await seeded();
    await mkdir(join(workdir, 'runs', 'half-seeded'), { recursive: true });
    await writeFile(join(workdir, 'runs', 'half-seeded', 'products.json'), '{"products":[]}', 'utf8');

    const source = new FileBoardSource({ workdir });
    expect(await source.list()).toEqual(['developer-tools']);
    expect(await source.read('half-seeded')).toBeUndefined();
  });

  it('omits a malformed ranking rather than rendering half a board', async () => {
    const workdir = await seeded();
    await writeFile(join(workdir, 'runs', 'developer-tools', 'ranking.json'), '{"category":"x"}', 'utf8');

    const source = new FileBoardSource({ workdir });
    expect(await source.list()).toEqual([]);
    expect(await source.read('developer-tools')).toBeUndefined();
  });

  it('returns an empty list for a workdir with no runs at all', async () => {
    const workdir = await seeded();
    await rm(join(workdir, 'runs'), { recursive: true, force: true });
    expect(await new FileBoardSource({ workdir }).list()).toEqual([]);
  });
});

describe('a slug is a path segment', () => {
  it('accepts the seeded slugs and rejects anything that could escape a directory', () => {
    expect(isBoardSlug('developer-tools')).toBe(true);
    expect(isBoardSlug('health-fitness-wellness')).toBe(true);
    expect(isBoardSlug('../../etc/passwd')).toBe(false);
    expect(isBoardSlug('Developer_Tools')).toBe(false);
    expect(isBoardSlug('a/b')).toBe(false);
    expect(isBoardSlug('')).toBe(false);
  });

  it('never reads a path built from a rejected slug', async () => {
    const workdir = await seeded();
    expect(await new FileBoardSource({ workdir }).read('../../etc/passwd')).toBeUndefined();
  });
});

describe('locating the workdir', () => {
  it('honours PIT_WORKDIR when a deployment sets one', () => {
    process.env['PIT_WORKDIR'] = '/mnt/pit-data';
    expect(resolveWorkdir()).toBe('/mnt/pit-data');
  });

  it('walks up to the repo root so a prerender from apps/web finds cjr/', () => {
    // `next build` prerenders with cwd = apps/web. A relative 'cjr' would resolve
    // to apps/web/cjr, and the build would succeed with an empty homepage.
    const found = resolveWorkdir(process.cwd());
    expect(found.endsWith('/cjr')).toBe(true);
    expect(found).not.toContain('apps/web');
  });
});

describe('the seeded categories on this branch', () => {
  it('reads both real boards from cjr/runs, with their real shapes', async () => {
    const source = new FileBoardSource({ workdir: resolveWorkdir(process.cwd()) });
    const slugs = await source.list();
    expect(slugs).toContain('developer-tools');
    expect(slugs).toContain('health-fitness-wellness');

    const dev = await source.read('developer-tools');
    expect(dev?.ranking.ranking).toHaveLength(48);
    expect(dev?.ranking.ranking.filter((row) => row.demand_status === 'solo_cluster')).toHaveLength(32);

    const health = await source.read('health-fitness-wellness');
    expect(health?.ranking.ranking).toHaveLength(44);
    expect(health?.ranking.ranking.filter((row) => row.demand_status === 'solo_cluster')).toHaveLength(26);
  });
});
