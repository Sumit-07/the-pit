/**
 * The bucket-backed `SnapshotSink`.
 *
 * `brief` Part 3: "Boards are **CDN snapshots**, regenerated on placement. Reads
 * never touch a model." `02 §4`: a placement "writes the new snapshot and
 * invalidates the CDN path for that one category", and "keep old snapshots
 * permanently addressable at dated URLs so issued verdict cards still resolve".
 *
 * Four properties, and each one is a thing that would otherwise break silently:
 *
 * 1. The dated document is written FIRST and never rewritten. A verdict card
 *    issued last season keeps resolving because its URL was never the one that
 *    moved.
 * 2. Exactly ONE path is invalidated, and it is the board that was just placed
 *    into. A broad purge would evict every other board from the edge on every
 *    $1 submission.
 * 3. The two objects carry different cache policies — a day at the edge for the
 *    mutable board, a year and `immutable` for the dated one.
 * 4. Nothing on the read path takes or constructs a model client, which is a
 *    property of the signatures rather than a rule to remember.
 */

import { describe, expect, it } from 'vitest';

import {
  BucketSnapshotSink,
  boardKey,
  datedKey,
  HttpObjectStore,
  MemoryObjectStore,
  ObjectStoreError,
} from '@/lib/pipeline/bucket';
import {
  BOARD_CACHE_CONTROL,
  DATED_SNAPSHOT_CACHE_CONTROL,
  SNAPSHOT_VERSION,
  type BoardSnapshot,
} from '@/lib/pipeline/snapshot';

function makeSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    slug: 'health-fitness-wellness',
    category: 'Health, Fitness & Wellness',
    generated_at: '2026-03-01T12:00:00.000Z',
    product_count: 3,
    engine_version: 'engine-1',
    category_version: 'cat-v1',
    ranking: {
      category: 'Health, Fitness & Wellness',
      prompt_version: 'jury-v1',
      uniqueness_version: 'uniq-v1',
      demand_version: 'personas-v1',
      ranking: [],
    } as unknown as BoardSnapshot['ranking'],
    ...overrides,
  };
}

describe('a placement publishes twice and invalidates once', () => {
  it('writes the permanent record before the board a reader hits', async () => {
    const objects = new MemoryObjectStore();
    const snapshot = makeSnapshot();

    const published = await new BucketSnapshotSink(objects).publish(snapshot);

    // Dated first. If the process dies between the two, the permanent record
    // exists and the board is merely one placement behind; the other order leaves
    // a board pointing at a version with no archived copy.
    expect(objects.writes.map((write) => write.key)).toEqual([
      `${datedKey(snapshot)}.json`,
      `${boardKey(snapshot.slug)}.json`,
    ]);
    expect(published).toEqual({ board: 'boards/health-fitness-wellness', dated: datedKey(snapshot) });
  });

  it('invalidates exactly one path, and it is the board', async () => {
    const objects = new MemoryObjectStore();
    const snapshot = makeSnapshot();

    await new BucketSnapshotSink(objects).publish(snapshot);

    // `02 §4`: "invalidates the CDN path for that one category". Not the dated
    // document, which never changes and is cached for a year, and not a prefix.
    expect(objects.purges).toEqual(['boards/health-fitness-wellness.json']);
  });

  it('purges after the object exists, not before', async () => {
    // Purging first would refill the edge from the OLD origin object and leave
    // the board stale until `s-maxage` expired — a day.
    const order: string[] = [];
    const objects = new MemoryObjectStore();
    const recording = {
      put: async (key: string, body: string, options: Parameters<MemoryObjectStore['put']>[2]) => {
        order.push(`put ${key}`);
        await objects.put(key, body, options);
      },
      get: (key: string) => objects.get(key),
      purge: async (key: string) => {
        order.push(`purge ${key}`);
        await objects.purge(key);
      },
    };

    await new BucketSnapshotSink(recording).publish(makeSnapshot());

    expect(order[order.length - 1]).toBe('purge boards/health-fitness-wellness.json');
    expect(order).toHaveLength(3);
  });

  it('caches the board for a day and the dated document forever', async () => {
    const objects = new MemoryObjectStore();
    const snapshot = makeSnapshot();

    await new BucketSnapshotSink(objects).publish(snapshot);

    const policies = new Map(objects.writes.map((write) => [write.key, write.cacheControl]));
    expect(policies.get(`${boardKey(snapshot.slug)}.json`)).toBe(BOARD_CACHE_CONTROL);
    expect(policies.get(`${datedKey(snapshot)}.json`)).toBe(DATED_SNAPSHOT_CACHE_CONTROL);
    // `brief §1.2` reshuffles every rank on a placement, so a browser holding
    // yesterday's board is showing positions that no longer exist.
    expect(BOARD_CACHE_CONTROL).toContain('max-age=0');
  });
});

describe('a dated snapshot is never overwritten', () => {
  it('keeps every issued board addressable across two placements', async () => {
    const objects = new MemoryObjectStore();
    const sink = new BucketSnapshotSink(objects);

    const first = makeSnapshot({ category_version: 'cat-v1', generated_at: '2026-03-01T12:00:00.000Z' });
    const second = makeSnapshot({
      category_version: 'cat-v2',
      generated_at: '2026-03-02T12:00:00.000Z',
      product_count: 4,
    });

    await sink.publish(first);
    await sink.publish(second);

    // Three objects, not two: one mutable board and two permanent records. A
    // verdict card issued against `cat-v1` still resolves.
    expect(objects.keys).toHaveLength(3);
    expect(objects.keys).toContain(`${datedKey(first)}.json`);
    expect(objects.keys).toContain(`${datedKey(second)}.json`);

    const archived = JSON.parse((await objects.get(`${datedKey(first)}.json`)) ?? '') as BoardSnapshot;
    expect(archived.product_count).toBe(3);

    // And the board a reader hits is the newer one.
    expect((await sink.read('health-fitness-wellness'))?.product_count).toBe(4);
  });

  it('reads back nothing for a category that has never been published', async () => {
    // A 404 rather than an empty board: serving `[]` for a category with forty
    // products would let a front end render "no products".
    expect(await new BucketSnapshotSink(new MemoryObjectStore()).read('never-run')).toBeUndefined();
  });
});

describe('the HTTP transport', () => {
  /** A `fetch` that records every request and answers from a map. */
  function fakeFetch(objects: Map<string, string>, log: { method: string; url: string; headers: Headers }[]) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      log.push({ method: init?.method ?? 'GET', url, headers });
      if (init?.method === 'PUT') {
        objects.set(url, String(init.body));
        return new Response(null, { status: 200 });
      }
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      const body = objects.get(url);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
    };
  }

  it('PUTs under the base URL with the sink\'s cache policy and a bearer token', async () => {
    const objects = new Map<string, string>();
    const log: { method: string; url: string; headers: Headers }[] = [];
    const store = new HttpObjectStore({
      baseUrl: 'https://bucket.example.com/pit/',
      token: 'secret-token',
      purgeUrl: 'https://cdn.example.com/purge',
      fetch: fakeFetch(objects, log),
    });

    await new BucketSnapshotSink(store).publish(makeSnapshot());

    const put = log.filter((entry) => entry.method === 'PUT');
    expect(put).toHaveLength(2);
    // The trailing slash on the base is collapsed rather than doubled.
    expect(put[1]?.url).toBe('https://bucket.example.com/pit/boards/health-fitness-wellness.json');
    expect(put[1]?.headers.get('Cache-Control')).toBe(BOARD_CACHE_CONTROL);
    expect(put[1]?.headers.get('Authorization')).toBe('Bearer secret-token');

    const purge = log.filter((entry) => entry.method === 'POST');
    expect(purge).toHaveLength(1);
    expect(purge[0]?.url).toBe('https://cdn.example.com/purge');
  });

  it('round-trips a published board through GET', async () => {
    const objects = new Map<string, string>();
    const store = new HttpObjectStore({
      baseUrl: 'https://bucket.example.com',
      fetch: fakeFetch(objects, []),
    });
    const sink = new BucketSnapshotSink(store);

    await sink.publish(makeSnapshot());
    expect((await sink.read('health-fitness-wellness'))?.category_version).toBe('cat-v1');
  });

  it('reports a missing board as undefined and a broken bucket as an error', async () => {
    // The distinction is the whole point. A 404 is the ordinary state of every
    // category that has not been run; a 403 from a rotated token is not, and
    // reporting it as "no board" would 404 a category that is live on the edge
    // right now.
    const failing = (status: number) => async (): Promise<Response> => new Response(null, { status });

    const missing = new HttpObjectStore({ baseUrl: 'https://b.example.com', fetch: failing(404) });
    expect(await missing.get('boards/x.json')).toBeUndefined();

    const forbidden = new HttpObjectStore({ baseUrl: 'https://b.example.com', fetch: failing(403) });
    await expect(forbidden.get('boards/x.json')).rejects.toBeInstanceOf(ObjectStoreError);

    const broken = new HttpObjectStore({ baseUrl: 'https://b.example.com', fetch: failing(500) });
    await expect(
      broken.put('boards/x.json', '{}', { contentType: 'application/json', cacheControl: 'no-store' }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('says whether a placement will actually reach the edge', async () => {
    // Some stores' CDNs revalidate on `Cache-Control` alone and have no purge
    // API. That is survivable — `BOARD_CACHE_CONTROL` carries
    // `stale-while-revalidate` — but it is not invisible: `service.ts` reads this
    // and warns once, at startup.
    const log: { method: string; url: string; headers: Headers }[] = [];
    const store = new HttpObjectStore({
      baseUrl: 'https://bucket.example.com',
      fetch: fakeFetch(new Map(), log),
    });
    expect(store.purges).toBe(false);

    await new BucketSnapshotSink(store).publish(makeSnapshot());
    expect(log.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });
});
