/**
 * Board snapshots — static JSON, regenerated on placement, served from a CDN.
 *
 * `brief` Part 3: "Boards are **CDN snapshots**, regenerated on placement. Reads
 * never touch a model." `02 §4` says the same thing twice over: "The board never
 * computes anything at read time", and "A permanent placement is the *only* event
 * that regenerates a category's `ranking.json`; the worker writes the new
 * snapshot and invalidates the CDN path for that one category."
 *
 * Two consequences, and they are the whole design:
 *
 * ## 1. A snapshot is `ranking.json`, wrapped — not a new projection of it
 *
 * `02 §4` again: the app "keeps that contract and simply **publishes those
 * files** to the bucket". So the payload is the engine's `Ranking` document
 * verbatim, inside an envelope that says which category, when, and under which
 * versions. Nothing here recomputes `cuts`, re-sorts rows or re-derives a
 * composite. `brief §1.2` has every z-score move on every placement; a second
 * place that computed board numbers would be a second thing to keep in step with
 * `packages/engine/src/rank/`, and the failure mode is a board that disagrees
 * with the verdict page it links to.
 *
 * ## 2. Every path here is model-free by construction
 *
 * No function in this module takes a `ModelClient`, so "reads never touch a
 * model" is a property of the signatures rather than a rule to remember. The
 * regeneration trigger is the `deliver` step, which runs exactly once per
 * delivered run — a placement, and nothing else.
 *
 * ## Dated URLs
 *
 * `brief` Part 3, on changing the panel: "keep old snapshots permanently
 * addressable at dated URLs so issued verdict cards still resolve". So each
 * publish writes twice — an immutable, version-and-timestamp-addressed document
 * that is never overwritten, and the mutable `<slug>` path the board reads, which
 * is the one that gets invalidated. A verdict card issued last season keeps
 * resolving because its URL was never the one that moved.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Ranking } from '@the-pit/engine';

/** Bumped when the ENVELOPE changes shape. The ranking inside it carries its own versions. */
export const SNAPSHOT_VERSION = 1;

/**
 * `Cache-Control` for the mutable `<slug>` board path.
 *
 * `s-maxage` lets the CDN serve it, `stale-while-revalidate` keeps a board up
 * while a placement regenerates it, and `max-age=0` keeps browsers asking — a
 * placement must be visible on a refresh, and `brief §1.2` says a placement
 * reshuffles ranks, so a browser holding yesterday's board is showing positions
 * that no longer exist. The publisher invalidates this path; the dated path below
 * is never invalidated because it never changes.
 */
export const BOARD_CACHE_CONTROL = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

/** `Cache-Control` for a dated snapshot. It cannot change, so it is cached forever. */
export const DATED_SNAPSHOT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * A published board.
 *
 * The envelope answers the three questions a cached document has to answer about
 * itself — which category, how old, and under which versions — without anyone
 * having to open `ranking` to find out.
 */
export interface BoardSnapshot {
  snapshot_version: number;
  slug: string;
  category: string;
  /** ISO-8601. `brief` Part 5: the verdict card is timestamped precisely because the board moves. */
  generated_at: string;
  /** `brief` Part 5: and product-count-stamped, for the same reason. */
  product_count: number;
  /** The engine build that produced the ranking — `brief` Part 7's integrity record. */
  engine_version: string;
  /** The category snapshot the ranking was computed over (`brief §1.3`'s cache key component). */
  category_version: string;
  /**
   * The engine ids published without a name or a URL.
   *
   * The `ranking` below has ALREADY had those identities removed — `buildSnapshot`
   * redacts before it wraps, so the name never reaches the bucket, the CDN or
   * `/api/boards/<slug>`, which serves this document verbatim. A reader of the
   * published snapshot cannot recover a name that was never written into it, which
   * is a stronger guarantee than redacting on the way out to HTML.
   *
   * This field is therefore not the redaction; it is the record of WHICH rows were
   * redacted, which the renderer needs in order to draw a robot rather than a
   * favicon in the identity slot. Without it the surfaces would have to infer
   * anonymity from a blank `url`, and inferring a privacy rule from a sentinel is
   * how a named product eventually renders as anonymous or the reverse.
   *
   * Optional only for documents written before anonymous listings existed; a
   * reader falls back to the blank-`url` sentinel for those. Every publish since
   * writes it, possibly as `[]`.
   */
  anonymous_ids?: number[];
  /** The engine's `ranking.json`, with any anonymous listing's identity already removed. */
  ranking: Ranking;
}

/**
 * Where a published snapshot lives — and, since the read path goes through it
 * too, where one is read back FROM.
 *
 * `read` is not a convenience. `/boards/<slug>` used to `readFile` a directory
 * while a placement published to a bucket, so a customer could pay, place, and
 * watch the public board never change — no error, just two different documents.
 * One interface, both directions, is what makes that impossible to reintroduce.
 */
export interface SnapshotSink {
  /** Write the immutable dated document and the mutable board path. Returns both keys. */
  publish(snapshot: BoardSnapshot): Promise<PublishedSnapshot>;
  /** The current board for a category, or `undefined` if it has never been published. */
  read(slug: string): Promise<BoardSnapshot | undefined>;
  /**
   * Every slug with a published board.
   *
   * Empty is a legitimate answer for a store that cannot ENUMERATE as well as for
   * one that holds nothing — `BucketSnapshotSink` says why it is the former.
   * Callers that need the full roster of categories get it from the category
   * source, not from here: a placement appends a product to a category that
   * already exists, so publishing never invents a slug.
   */
  list(): Promise<string[]>;
}

/** What a publish wrote. `board` is the path a reader hits; `dated` is the permanent one. */
export interface PublishedSnapshot {
  board: string;
  dated: string;
}

/**
 * The permanent, never-overwritten key for a snapshot.
 *
 * Carries the category version and the generation timestamp, so two placements
 * in the same second under the same version would collide — and they cannot,
 * because a placement regenerates one category's board and the `deliver` step is
 * serialized per run. The timestamp is filesystem- and URL-safe.
 */
export function datedSnapshotKey(snapshot: BoardSnapshot): string {
  const stamp = snapshot.generated_at.replaceAll(':', '').replaceAll('-', '').replace('.', '');
  return `${snapshot.slug}/${snapshot.category_version}/${stamp}`;
}

/** JSON on disk, under `<root>/boards/`. The local and CI story; a bucket implements the same interface. */
export class FileSnapshotSink implements SnapshotSink {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async publish(snapshot: BoardSnapshot): Promise<PublishedSnapshot> {
    const dated = `dated/${datedSnapshotKey(snapshot)}`;
    const board = `boards/${snapshot.slug}`;
    // Dated first. If the process dies between the two writes, the permanent
    // record exists and the board is merely one placement behind — the other
    // order would leave a board pointing at a version with no archived copy.
    await this.write(dated, snapshot);
    await this.write(board, snapshot);
    return { board, dated };
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'boards'), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .sort();
    } catch {
      // No `boards/` directory is a deployment that has published nothing yet,
      // which is every category before its first delivered run.
      return [];
    }
  }

  async read(slug: string): Promise<BoardSnapshot | undefined> {
    try {
      return JSON.parse(await readFile(join(this.root, `boards/${slug}.json`), 'utf8')) as BoardSnapshot;
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async write(key: string, snapshot: BoardSnapshot): Promise<void> {
    const path = join(this.root, `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }
}

/** An in-memory sink that remembers every publish, in order. For tests. */
export class MemorySnapshotSink implements SnapshotSink {
  readonly published: PublishedSnapshot[] = [];
  private readonly documents = new Map<string, BoardSnapshot>();

  publish(snapshot: BoardSnapshot): Promise<PublishedSnapshot> {
    const keys = { board: `boards/${snapshot.slug}`, dated: `dated/${datedSnapshotKey(snapshot)}` };
    this.documents.set(keys.dated, snapshot);
    this.documents.set(keys.board, snapshot);
    this.published.push(keys);
    return Promise.resolve(keys);
  }

  read(slug: string): Promise<BoardSnapshot | undefined> {
    return Promise.resolve(this.documents.get(`boards/${slug}`));
  }

  list(): Promise<string[]> {
    return Promise.resolve(
      [...this.documents.keys()]
        .filter((key) => key.startsWith('boards/'))
        .map((key) => key.slice('boards/'.length))
        .sort(),
    );
  }

  /** Every document ever written, dated keys included. Lets a test prove the archive is not overwritten. */
  get keys(): readonly string[] {
    return [...this.documents.keys()];
  }
}
