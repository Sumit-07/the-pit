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

import { FileBoardSource, isBoardSlug, resolveWorkdir } from '@/lib/boards/source';

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
    expect(document_?.ranking.ranking[0]?.name).toBe('Ashgrove');
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
