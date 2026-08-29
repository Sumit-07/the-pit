/**
 * The durable `SnapshotSink` — board snapshots in an object store, behind a CDN.
 *
 * `brief` Part 3: "Boards are **CDN snapshots**, regenerated on placement. Reads
 * never touch a model." `02 §4`: "A permanent placement is the *only* event that
 * regenerates a category's `ranking.json`; the worker writes the new snapshot and
 * invalidates the CDN path for that one category."
 *
 * `FileSnapshotSink` in `snapshot.ts` already implements that contract onto a
 * directory, which is the right answer locally and in CI and the wrong one on
 * Vercel: a board written to a lambda's disk is unreadable by the next request,
 * so `/api/boards/<slug>` would 404 a category that was published thirty seconds
 * ago. This module is the same contract onto a bucket.
 *
 * ## The transport is a seam, and a small one
 *
 * `ObjectStore` is three methods — `put`, `get`, `purge` — because that is all a
 * snapshot sink does, and because every candidate store speaks them: an
 * S3-compatible bucket behind a signing proxy, Cloudflare R2, Vercel Blob. No
 * SDK is imported. That is not asceticism: an SDK here would decide the vendor
 * for a deployment that has not been provisioned yet (`brief` Part 7 budgets the
 * hosting; nothing is created), and it would make this file untestable without a
 * network. `HttpObjectStore` is `fetch` against a base URL with a bearer token,
 * and the `fetch` itself is injectable, so the whole sink is exercised offline.
 *
 * SigV4 is deliberately NOT implemented. Signing every request in userland is a
 * security-relevant cryptographic surface to own for one PUT per placement, and
 * every store on the shortlist accepts a bearer token against an endpoint. If a
 * deployment genuinely needs raw S3, it implements `ObjectStore` — twelve lines
 * around the AWS SDK — and nothing above this line changes.
 *
 * ## Two writes, one invalidation, in that order
 *
 * The dated document goes first and is never overwritten (`brief` Part 3: "keep
 * old snapshots permanently addressable at dated URLs so issued verdict cards
 * still resolve"). The mutable board path goes second. Only the board path is
 * purged, and only for the one category that was placed — `02 §4` says the worker
 * "invalidates the CDN path for that one category", and a broad purge would evict
 * every other board from the edge on every placement, turning a $1 submission
 * into a cache-fill for the whole site.
 *
 * If the process dies between the two writes, the permanent record exists and the
 * board is one placement behind. The other order would leave a board pointing at
 * a version with no archived copy.
 */

import {
  BOARD_CACHE_CONTROL,
  DATED_SNAPSHOT_CACHE_CONTROL,
  datedSnapshotKey,
  type BoardSnapshot,
  type PublishedSnapshot,
  type SnapshotSink,
} from './snapshot';

/** Content type for every object this module writes. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** How an object is written. */
export interface PutOptions {
  contentType: string;
  /** Verbatim `Cache-Control`. The sink, not the transport, decides the policy. */
  cacheControl: string;
}

/**
 * The transport a `BucketSnapshotSink` writes through.
 *
 * Keys are store-relative and carry no leading slash and no extension policy —
 * the sink supplies `boards/<slug>.json` and `dated/<...>.json` and the transport
 * puts them wherever its base points.
 */
export interface ObjectStore {
  put(key: string, body: string, options: PutOptions): Promise<void>;
  /** The object's body, or `undefined` if there is none. Anything else throws. */
  get(key: string): Promise<string | undefined>;
  /**
   * Drop the CDN's copy of ONE key.
   *
   * Separate from `put` because they are not the same operation on any real
   * store: the object is written to the origin, and the edge is told to forget
   * what it had. A store whose CDN revalidates on `Cache-Control` alone
   * implements this as a no-op, and says so.
   */
  purge(key: string): Promise<void>;
}

/** `<slug>` board key. The mutable path a reader hits and the only one purged. */
export function boardKey(slug: string): string {
  return `boards/${slug}`;
}

/** The immutable, permanently addressable key. Written once, never purged. */
export function datedKey(snapshot: BoardSnapshot): string {
  return `dated/${datedSnapshotKey(snapshot)}`;
}

/**
 * Board snapshots in an object store.
 *
 * Holds the key layout, the cache policy and the ordering; holds no transport, no
 * credentials and no vendor.
 */
export class BucketSnapshotSink implements SnapshotSink {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  async publish(snapshot: BoardSnapshot): Promise<PublishedSnapshot> {
    const dated = datedKey(snapshot);
    const board = boardKey(snapshot.slug);
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;

    // Permanent record first. See the module header.
    await this.store.put(`${dated}.json`, body, {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: DATED_SNAPSHOT_CACHE_CONTROL,
    });
    await this.store.put(`${board}.json`, body, {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: BOARD_CACHE_CONTROL,
    });

    // One category's path, after the object exists. Purging before the write
    // would refill the edge from the OLD origin object and leave the board stale
    // until `s-maxage` expired — a day, on `BOARD_CACHE_CONTROL`.
    await this.store.purge(`${board}.json`);

    return { board, dated };
  }

  async read(slug: string): Promise<BoardSnapshot | undefined> {
    const body = await this.store.get(`${boardKey(slug)}.json`);
    return body === undefined ? undefined : (JSON.parse(body) as BoardSnapshot);
  }

  /**
   * Empty, always — and deliberately.
   *
   * `ObjectStore` is `put`, `get`, `purge`, because that is the intersection every
   * candidate store speaks. LIST is not in it: S3 answers `ListObjectsV2` with
   * XML, R2 and Vercel Blob answer their own shapes, and adding a fourth method
   * would put the vendor coupling this module exists to avoid back into it — for a
   * question nothing actually needs a bucket to answer.
   *
   * Nothing needs it because a placement does not invent a category. `brief §1.2`
   * has a paid submission APPEND a product to a category that is already scored,
   * and a new category arrives by seeding, which commits `cjr/runs/<slug>/`. So
   * the roster of slugs is the category source's answer, and `SnapshotBoardSource`
   * takes it from there and asks the sink only for each board's DOCUMENT — which
   * is the half that moves on a placement, and the half that was being read from
   * the wrong place.
   *
   * If a deployment ever does need enumeration, it belongs in an index object the
   * publisher maintains, not in a LIST verb this interface has to grow.
   */
  list(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

/** A bucket that answered with something other than success. */
export class ObjectStoreError extends Error {
  override readonly name = 'ObjectStoreError';
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** What `HttpObjectStore` needs. */
export interface HttpObjectStoreConfig {
  /** The bucket's base URL. A trailing slash is optional; keys are appended under it. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>` on writes. Omitted, writes are unauthenticated. */
  token?: string;
  /**
   * Where a purge is POSTed, with `{"key": "<key>"}`.
   *
   * Optional: some stores' CDNs revalidate on `Cache-Control` alone and have no
   * purge API. When it is absent `purge` is a no-op, and `service.ts` warns at
   * startup rather than here — a warning per placement in a log is a warning
   * nobody reads.
   */
  purgeUrl?: string;
  /** Injected so the whole sink is testable with no network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * An object store over plain HTTP.
 *
 * `PUT <base>/<key>` to write, `GET <base>/<key>` to read, `POST <purgeUrl>` to
 * invalidate. That is the intersection every candidate store already speaks, and
 * it is the whole vendor coupling in this codebase.
 */
export class HttpObjectStore implements ObjectStore {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly purgeUrl: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: HttpObjectStoreConfig) {
    this.base = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.purgeUrl = config.purgeUrl;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  /** Whether a placement will actually invalidate the edge, or only rewrite the origin. */
  get purges(): boolean {
    return this.purgeUrl !== undefined;
  }

  async put(key: string, body: string, options: PutOptions): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: 'PUT',
      headers: {
        'Content-Type': options.contentType,
        'Cache-Control': options.cacheControl,
        ...this.authorization(),
      },
      body,
    });
    if (!response.ok) {
      throw new ObjectStoreError(`PUT ${key} failed: ${response.status} ${response.statusText}`, response.status);
    }
  }

  async get(key: string): Promise<string | undefined> {
    const response = await this.fetchImpl(this.url(key), { method: 'GET', headers: this.authorization() });
    // A board that has never been published is the ordinary state of every
    // category that has not been run. Anything else — 403 on a bad token, 500
    // from the store — is real and is thrown, because reporting it as "no board"
    // would let the boards route serve a 404 for a category that has forty
    // products on the edge right now.
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new ObjectStoreError(`GET ${key} failed: ${response.status} ${response.statusText}`, response.status);
    }
    return response.text();
  }

  async purge(key: string): Promise<void> {
    if (this.purgeUrl === undefined) return;
    const response = await this.fetchImpl(this.purgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authorization() },
      body: JSON.stringify({ key }),
    });
    if (!response.ok) {
      throw new ObjectStoreError(`PURGE ${key} failed: ${response.status} ${response.statusText}`, response.status);
    }
  }

  private url(key: string): string {
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }

  private authorization(): Record<string, string> {
    return this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` };
  }
}

/**
 * An in-memory object store that remembers every write and every purge, in order.
 *
 * The `purges` log is what lets a test assert `02 §4`'s actual claim — that a
 * placement invalidates ONE category's path — rather than the weaker "a placement
 * wrote a board".
 */
export class MemoryObjectStore implements ObjectStore {
  readonly writes: { key: string; cacheControl: string }[] = [];
  readonly purges: string[] = [];
  private readonly objects = new Map<string, string>();

  put(key: string, body: string, options: PutOptions): Promise<void> {
    this.objects.set(key, body);
    this.writes.push({ key, cacheControl: options.cacheControl });
    return Promise.resolve();
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.objects.get(key));
  }

  purge(key: string): Promise<void> {
    this.purges.push(key);
    return Promise.resolve();
  }

  /** Every key currently held. Lets a test prove the dated archive is not overwritten. */
  get keys(): readonly string[] {
    return [...this.objects.keys()];
  }
}
