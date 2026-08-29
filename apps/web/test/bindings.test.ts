/**
 * Which store and which sink a deployment gets — and what happens when it cannot
 * have either.
 *
 * The bug this file guards is not a crash. It is a deployment that looks healthy,
 * takes a submission, buys the Score phase on one Vercel instance, lands the
 * Persona step on another, finds an empty filesystem, decides the phase never ran
 * and buys it again — charging a customer twice for one attempt while still
 * reporting the retry as free (`brief §2.3`).
 *
 * A test that only checked "postgres is chosen in production" would pass on a
 * build that silently fell back to disk when `DATABASE_URL` was missing, which is
 * the exact shape of the bug. So the assertions below are about the REFUSALS: an
 * ephemeral filesystem in production is an error, a missing database is an error,
 * a missing bucket is an error, and every one of them is raised before a request
 * is served rather than in the middle of a paid run.
 */

import { describe, expect, it, vi } from 'vitest';

import { BucketSnapshotSink } from '@/lib/pipeline/bucket';
import { PgPipelineStore } from '@/lib/pipeline/pg-store';
import {
  assertBindingsConfigured,
  bindingProblems,
  defaultBindings,
  PipelineBindingError,
  requiresDurableStorage,
  storageMode,
} from '@/lib/pipeline/service';
import { FileSnapshotSink } from '@/lib/pipeline/snapshot';
import { FilePipelineStore } from '@/lib/pipeline/store';

const VERSIONS = {
  category_version: 'cat-v1',
  prompt_version: 'jury-v1',
  persona_version: 'personas-v1',
  engine_version: 'engine-1',
};

/** A configured production environment. */
const PRODUCTION = {
  VERCEL: '1',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pw@db.example.com/pit?sslmode=require',
  PIT_SNAPSHOT_BUCKET_URL: 'https://bucket.example.com/pit',
  PIT_SNAPSHOT_BUCKET_TOKEN: 'secret',
  PIT_SNAPSHOT_PURGE_URL: 'https://cdn.example.com/purge',
} as const;

/** A developer's laptop: nothing set. */
const LOCAL = { NODE_ENV: 'development' } as const;

describe('the mode is chosen by the environment, not by a default', () => {
  it('binds the filesystem locally and Postgres on Vercel', () => {
    expect(storageMode(LOCAL)).toBe('filesystem');
    expect(storageMode(PRODUCTION)).toBe('postgres');
  });

  it('treats a Vercel PREVIEW as durable too', () => {
    // A preview deployment has the same ephemeral filesystem and the same real
    // API key as production. There is no version of "it is only a preview" that
    // makes a double charge acceptable.
    expect(requiresDurableStorage({ VERCEL: '1', NODE_ENV: 'development' })).toBe(true);
    expect(requiresDurableStorage({ NODE_ENV: 'production' })).toBe(true);
    expect(requiresDurableStorage(LOCAL)).toBe(false);
  });

  it('lets a developer force Postgres locally', () => {
    // Narrowing toward durability is always allowed: it is how the durable path
    // is exercised against a local Postgres.
    expect(storageMode({ ...LOCAL, PIT_STORAGE: 'postgres' })).toBe('postgres');
  });

  it('refuses to be forced back onto the filesystem where it is a correctness bug', () => {
    // The one setting that reinstates the double charge. There is deliberately no
    // escape hatch: an environment variable is not a good enough reason.
    expect(() => storageMode({ ...PRODUCTION, PIT_STORAGE: 'filesystem' })).toThrow(PipelineBindingError);
    expect(() => storageMode({ ...PRODUCTION, PIT_STORAGE: 'filesystem' })).toThrow(/re-buy a phase/);
  });

  it('refuses a mode it does not recognise rather than guessing', () => {
    expect(() => storageMode({ ...LOCAL, PIT_STORAGE: 'sqlite' })).toThrow(/must be "filesystem" or "postgres"/);
  });
});

describe('a misconfigured deployment fails at startup, not at the first paid run', () => {
  it('is happy when everything is set', () => {
    expect(bindingProblems(PRODUCTION)).toEqual([]);
    expect(() => assertBindingsConfigured(PRODUCTION)).not.toThrow();
  });

  it('names the missing database and the missing bucket in one message', () => {
    // Both at once, not the first: someone configuring a deployment should not
    // have to redeploy three times to be told about three variables.
    const problems = bindingProblems({ VERCEL: '1', NODE_ENV: 'production' });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('DATABASE_URL');
    expect(problems.join('\n')).toContain('PIT_SNAPSHOT_BUCKET_URL');

    const thrown = (() => {
      try {
        assertBindingsConfigured({ VERCEL: '1', NODE_ENV: 'production' });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(PipelineBindingError);
    expect(String((thrown as Error).message)).toContain('2 problem(s)');
  });

  it('rejects a bucket URL that is not a URL', () => {
    const problems = bindingProblems({ ...PRODUCTION, PIT_SNAPSHOT_BUCKET_URL: '/var/snapshots' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must be an http(s) URL');
  });

  it('has no problems to report about a local filesystem deployment', () => {
    // The filesystem binding needs nothing, which is why it is the local story —
    // and exactly why it must not be reachable in production.
    expect(bindingProblems(LOCAL)).toEqual([]);
  });

  it('warns, once, when a placement cannot invalidate the edge', () => {
    // Survivable — `BOARD_CACHE_CONTROL` carries `stale-while-revalidate` — but
    // not silent: `02 §4` asks for the category's path to be invalidated, and
    // without a purge endpoint the new board is up to a day late.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { PIT_SNAPSHOT_PURGE_URL: _omitted, ...withoutPurge } = PRODUCTION;
      assertBindingsConfigured(withoutPurge);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('PIT_SNAPSHOT_PURGE_URL');

      warn.mockClear();
      assertBindingsConfigured(PRODUCTION);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the bindings themselves', () => {
  it('hands out a file store and a file sink locally', () => {
    const bindings = defaultBindings(LOCAL);
    expect(bindings.store('Health, Fitness & Wellness', VERSIONS)).toBeInstanceOf(FilePipelineStore);
    expect(bindings.snapshots).toBeInstanceOf(FileSnapshotSink);
  });

  it('gives a placement its own scope on the filesystem', () => {
    // The phases of a placement and of the category's seed run carry identical
    // version stamps and hold different things (`store.ts`'s `placementScope`),
    // so they must not share a namespace. On disk that is a separate directory.
    const bindings = defaultBindings(LOCAL);
    const category = bindings.store('Health, Fitness & Wellness', VERSIONS);
    const placement = bindings.store('Health, Fitness & Wellness', VERSIONS, { placement: 41 });
    expect(placement.slug).not.toBe(category.slug);
    expect(placement.slug).toContain('placement-41');
  });

  it('refuses to hand out any bindings at all when production is unconfigured', () => {
    // Not "returns filesystem bindings with a warning". The whole point is that
    // there is no path from a missing variable to a store on local disk.
    expect(() => defaultBindings({ VERCEL: '1', NODE_ENV: 'production' })).toThrow(PipelineBindingError);
  });

  it('hands out a Postgres store and a bucket sink when it is configured', () => {
    // `DATABASE_URL` here points at a host that does not exist. `postgres` opens
    // no socket until a query is issued, so this asserts the WIRING without a
    // database — which is also why `createDatabase` is called lazily rather than
    // at module scope.
    const bindings = defaultBindings(PRODUCTION);
    expect(bindings.store('Health, Fitness & Wellness', VERSIONS)).toBeInstanceOf(PgPipelineStore);
    expect(bindings.snapshots).toBeInstanceOf(BucketSnapshotSink);
  });

  it('keys a placement on its own job row in Postgres, under the category\'s slug', () => {
    const bindings = defaultBindings(PRODUCTION);
    const category = bindings.store('Health, Fitness & Wellness', VERSIONS) as PgPipelineStore;
    const placement = bindings.store('Health, Fitness & Wellness', VERSIONS, { placement: 41 }) as PgPipelineStore;

    // A different run, but the same board: `slug` is what the snapshot is keyed
    // on, and a placement republishes the category's board, not one of its own.
    expect(placement.runId).not.toBe(category.runId);
    expect(placement.slug).toBe(category.slug);
  });
});
