/**
 * Where a board read gets its data: a JSON file, and nothing else.
 *
 * `brief` Part 3: "Boards are **CDN snapshots**, regenerated on placement. Reads
 * never touch a model." `02 §4` says it twice more: "The board never computes
 * anything at read time", and a placement is the *only* event that regenerates a
 * category's ranking. A visitor browsing the boards is a cache hit.
 *
 * ## Why that is a property here, not a rule to remember
 *
 * **Nothing reachable from this module imports `@the-pit/engine`, `@the-pit/db`,
 * `postgres` or an SDK at runtime.** The engine types it uses are `import type`
 * and are erased at compile time; the runtime dependencies are `node:fs/promises`,
 * `node:path` and the snapshot sink, which is `fetch` and JSON. So "a board read
 * cannot open a database connection or a model client" is checkable by reading an
 * import list, and `test/boards-read-path.test.ts` walks the transitive graph from
 * the routes and fails if anything on it gains one — naming the file and the
 * specifier. A rule enforced by the module graph does not decay.
 *
 * ## The board is read through the SINK a placement publishes to
 *
 * This module used to `readFile` a directory. A placement in production publishes
 * to a bucket, so `/boards/<slug>` could never see one: a customer paid, placed,
 * and the public board went on showing the board from before their submission —
 * no error, no failed step, just two different documents in two different places.
 *
 * So the published board now comes back through `SnapshotSink.read`, the same
 * interface `run.ts`'s `deliver` step publishes through, resolved from the same
 * `defaultSnapshotSink(env)`. There is no second answer to where a board lives.
 *
 * It stays a static read. `SnapshotSink` is `publish`, `read`, `list` — a
 * document fetched by key from a directory or a bucket behind a CDN. Nothing on
 * this path opens a database connection, re-ranks anything or re-derives a
 * composite: `brief` Part 3's "reads never touch a model" and `02 §4`'s "the
 * board never computes anything at read time" are unchanged, and are still
 * enforced by the module graph rather than remembered.
 *
 * `buildSnapshot` — the one part of the pipeline's snapshot story that needs
 * `ENGINE_VERSION` as a value — lives in `pipeline/snapshot-build.ts` precisely
 * so that resolving a sink here does not put the engine on this graph.
 *
 * ## Two sources, one shape
 *
 * 1. **A published snapshot** — read through the sink: `<snapshotRoot>/boards/<slug>.json`
 *    locally and in CI, the bucket object behind the CDN in production. Written
 *    by a placement, and it is the document that MOVES when someone pays.
 * 2. **A seeded run** — `<workdir>/runs/<slug>/ranking.json`, which is what the
 *    two categories on this branch actually are. `01 §3` puts the current source
 *    of truth in flat JSON under `cjr/`, a `ranking.json` is only written for a
 *    DELIVERED run, and the file is byte-identical in shape to the `ranking`
 *    field of a published snapshot. Reading it costs one `readFile`.
 *
 * A published snapshot wins where both exist, because it is the document a
 * placement most recently wrote. Neither path computes a score.
 *
 * ## Where the roster of slugs comes from
 *
 * From the seeded workdir and from whatever the sink can enumerate — and a bucket
 * can enumerate nothing, on purpose (`BucketSnapshotSink.list`). That is not a
 * gap: a placement APPENDS a product to a category that already exists
 * (`brief §1.2`), and a new category arrives by seeding, which commits
 * `cjr/runs/<slug>/`. Publishing never invents a slug, so the committed workdir
 * is the complete list in production and the sink supplies the rest locally.
 *
 * ## What it refuses to crash on
 *
 * A run directory with no `ranking.json` is **omitted**, not fatal — that is the
 * normal mid-pipeline state for a category being seeded, and a homepage that
 * threw on it would break exactly when someone is adding a category. A malformed
 * document is the same. A missing `results.json` costs the board its provenance
 * caveat and its engine version, and the footer says so rather than inventing
 * either.
 */

import { statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Ranking } from '@the-pit/engine';

import { redactRanking } from '@/lib/anon';
import { defaultSnapshotSink } from '@/lib/pipeline/sink';
import { FileSnapshotSink, type BoardSnapshot, type SnapshotSink } from '@/lib/pipeline/snapshot';

/**
 * The rows a stored ranking already presents anonymously.
 *
 * The fallback for a published snapshot written before `anonymous_ids` existed. A
 * blank `url` is a safe sentinel: `products.url` is `NOT NULL` and the engine's
 * `Product.url` is required, so no named row can reach a ranking without one.
 */
function anonymousIdsIn(ranking: Ranking): number[] {
  return ranking.ranking.filter((row) => row.url === '').map((row) => row.id);
}

/**
 * One board's stored document, however it was found.
 *
 * The envelope fields a published snapshot carries are all optional here, because
 * a seeded run genuinely does not have some of them and a board that filled them
 * in with plausible values would be lying about its own provenance.
 */
export interface BoardDocument {
  slug: string;
  category: string;
  /** ISO-8601. A snapshot's `generated_at`, or the ranking file's mtime. */
  generatedAt: string;
  productCount: number;
  /** `brief §1.3`'s cache-key component: which category snapshot this was ranked over. */
  categoryVersion: string;
  /** The engine build that produced it. Absent on a run that stored no `results.json`. */
  engineVersion?: string;
  /** `results.json` `meta.seeding.caveat` — absent when the run stored none. */
  caveat?: string;
  /** Where this came from, so the footer can be honest about it. */
  origin: 'snapshot' | 'seeded-run';
  /**
   * The engine ids published without a name or a URL.
   *
   * `ranking` below has already had those identities removed, so this is the
   * record of WHICH rows were redacted rather than the redaction itself — the
   * renderer needs it to put a robot in the identity slot instead of a favicon.
   *
   * Every row of a seeded run is in here. See `readSeededRun`.
   */
  anonymousIds: readonly number[];
  /** The engine's ranking document, with anonymous listings' identities removed. */
  ranking: Ranking;
}

/** A place boards are read from. A bucket implements the same two methods. */
export interface BoardSource {
  /** Every slug with a readable board, sorted. */
  list(): Promise<string[]>;
  /** One board, or `undefined` when the category has no published or seeded ranking. */
  read(slug: string): Promise<BoardDocument | undefined>;
}

/** Slugs are path segments. Anything that could escape one is not a slug. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isBoardSlug(value: string): boolean {
  return SLUG.test(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // Missing, unreadable and malformed all mean the same thing to a reader: no
    // board here. The caller decides whether that omits the board or just a line
    // of its footer.
    return undefined;
  }
}

/**
 * The shape check a stored ranking has to pass to be rendered.
 *
 * Deliberately shallow — enough to render, no more. A deeper validator here would
 * be a second opinion about `01 §6.6`'s schema, and the engine already owns that.
 */
export function isRanking(value: unknown): value is Ranking {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Ranking>;
  return (
    Array.isArray(candidate.ranking) &&
    Array.isArray(candidate.metrics) &&
    Array.isArray(candidate.clusters) &&
    Array.isArray(candidate.personas) &&
    Array.isArray(candidate.flaggedInjections) &&
    typeof candidate.category === 'string' &&
    typeof candidate.prompt_version === 'string' &&
    candidate.health !== undefined &&
    candidate.weights !== undefined
  );
}

function isSnapshot(value: unknown): value is BoardSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BoardSnapshot>;
  return typeof candidate.slug === 'string' && typeof candidate.generated_at === 'string' && isRanking(candidate.ranking);
}

/**
 * Find the directory holding `runs/`, walking up from a starting point.
 *
 * `next build` prerenders from `apps/web`, a vitest run starts wherever it was
 * invoked, and `service.ts`'s relative `'cjr'` default resolves against whichever
 * of those it happens to be. A board that renders in `pnpm dev` and comes up
 * empty in `next build` is the worst version of this bug, because the empty
 * build succeeds. So the workdir is located rather than assumed, and
 * `PIT_WORKDIR` still overrides it for a deployment with a mounted volume.
 */
export function resolveWorkdir(from: string = process.cwd()): string {
  const override = process.env['PIT_WORKDIR'];
  if (override !== undefined && override !== '') return resolve(override);

  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, 'cjr');
    // `existsSync` would be a sync call in an async module; the caller tolerates
    // a wrong guess because `list()` returns [] for a directory with no runs.
    if (dir === dirname(dir)) return join(resolve(from), 'cjr');
    if (hasRuns(candidate)) return candidate;
    dir = dirname(dir);
  }
}

// Kept sync and tiny: `resolveWorkdir` runs once per render and walking a handful
// of parent directories with `statSync` is cheaper than making every caller async.
function hasRuns(candidate: string): boolean {
  try {
    return statSync(join(candidate, 'runs')).isDirectory();
  } catch {
    return false;
  }
}

export interface FileBoardSourceOptions {
  /** Holds `runs/<slug>/ranking.json`. Defaults to the located `cjr/`. */
  workdir?: string;
  /** Holds `boards/<slug>.json`. Defaults to `<workdir>/public`, matching `service.ts`. */
  snapshotRoot?: string;
}

/** What a `SnapshotBoardSource` needs. */
export interface SnapshotBoardSourceOptions {
  /**
   * Where published boards live — the SAME sink the `deliver` step publishes to.
   *
   * Injected rather than resolved here so a test can hand it a
   * `MemorySnapshotSink` and prove that publishing through the sink is what the
   * page reads back, which is the property that was missing.
   */
  snapshots: SnapshotSink;
  /** Holds `runs/<slug>/ranking.json`. Defaults to the located `cjr/`. */
  workdir?: string;
}

/**
 * Published snapshots first, seeded runs second.
 *
 * The first read goes through `SnapshotSink` — a directory locally, a bucket
 * behind a CDN in production — and the second is one `readFile`. Neither computes
 * anything.
 */
export class SnapshotBoardSource implements BoardSource {
  private readonly workdir: string;
  private readonly snapshots: SnapshotSink;

  constructor(options: SnapshotBoardSourceOptions) {
    this.workdir = options.workdir ?? resolveWorkdir();
    this.snapshots = options.snapshots;
  }

  async list(): Promise<string[]> {
    const slugs = new Set<string>();
    for (const slug of await this.snapshots.list()) {
      if (isBoardSlug(slug)) slugs.add(slug);
    }
    // The seeded workdir, which is the complete roster in production: a placement
    // appends to a category that already exists, and a new category arrives by a
    // commit under `cjr/runs/`. See the module header.
    for (const name of await entries(join(this.workdir, 'runs'), 'dir')) {
      if (isBoardSlug(name)) slugs.add(name);
    }

    // A slug in the list has to be readable, or a board route generated from it
    // renders a 404 for a category the index just linked to.
    const readable: string[] = [];
    for (const slug of [...slugs].sort()) {
      if ((await this.read(slug)) !== undefined) readable.push(slug);
    }
    return readable;
  }

  async read(slug: string): Promise<BoardDocument | undefined> {
    if (!isBoardSlug(slug)) return undefined;
    return (await this.readSnapshot(slug)) ?? (await this.readSeededRun(slug));
  }

  /**
   * The published board, through the sink.
   *
   * A malformed document is `undefined` — the same answer a missing one gets,
   * because a homepage that threw on one corrupt object would take down every
   * board on the site. Anything else the sink raises PROPAGATES: an
   * `ObjectStoreError` from a rotated token is a 403, not "no board", and
   * reporting it as an empty list would render "nobody entered" over a category
   * that has forty products live on the edge right now (`bucket.ts` makes the
   * same distinction one layer down, and this is the layer that must not undo it).
   */
  private async readSnapshot(slug: string): Promise<BoardDocument | undefined> {
    let raw: unknown;
    try {
      raw = await this.snapshots.read(slug);
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!isSnapshot(raw)) return undefined;

    // `buildSnapshot` redacted before publishing, so this is normally a no-op —
    // and it is run anyway, because "the document in the bucket is already clean"
    // is an assumption about a file this process did not write. `redactRanking`
    // is idempotent, so the cost of being wrong is nothing and the cost of
    // trusting it would be a name on a page that paid not to have one.
    const anonymousIds = raw.anonymous_ids ?? anonymousIdsIn(raw.ranking);
    return {
      slug,
      category: raw.category,
      generatedAt: raw.generated_at,
      productCount: raw.product_count,
      categoryVersion: raw.category_version,
      engineVersion: raw.engine_version,
      origin: 'snapshot',
      anonymousIds,
      ranking: redactRanking(raw.ranking, anonymousIds, slug),
    };
  }

  private async readSeededRun(slug: string): Promise<BoardDocument | undefined> {
    const path = join(this.workdir, 'runs', slug, 'ranking.json');
    const raw = await readJson(path);
    if (!isRanking(raw)) return undefined;

    // The ranking document carries no timestamp of its own; the file's mtime is
    // when the rank was written, which is what the footer's stamp means.
    let generatedAt = new Date(0).toISOString();
    try {
      generatedAt = (await stat(path)).mtime.toISOString();
    } catch {
      // Keep the epoch rather than "now": a made-up recent time would read as a
      // fresh rebuild of a board that may be weeks old.
    }

    // Provenance lives in `results.json`, not in the ranking, and is read rather
    // than copied so a board can never show a caveat its run does not carry.
    const results = (await readJson(join(this.workdir, 'runs', slug, 'results.json'))) as
      | { meta?: { engine_version?: unknown; category_version?: unknown; seeding?: { caveat?: unknown } } }
      | undefined;
    const engineVersion = results?.meta?.engine_version;
    const categoryVersion = results?.meta?.category_version;
    const caveat = results?.meta?.seeding?.caveat;

    /**
     * EVERY row of a seeded run is anonymous.
     *
     * `DECISIONS.md`'s resolution of S4-source: 913 of the 1028 seeded
     * descriptions were scraped from a third-party directory rather than written
     * by the companies they describe, so a NAMED seeded row is AI criticism of
     * copy that company never wrote — the largest legal and reputational exposure
     * in the project, and one that `brief` Part 7's opt-out only ever mitigated
     * for the companies who happened to find out. Publishing them anonymously
     * removes it at the root while the board still demonstrates the method on
     * real market data, with every cut and every reason intact.
     *
     * The database says the same thing one layer down — `products_seeded_is_anonymous`
     * refuses to store a named unclaimed seeded row — and this is the same rule
     * for the cold-start boards, which are flat files that never went through it.
     *
     * These documents were also SCORED with the real names, before any of this
     * existed, which is why `redactRanking` scrubs the prose as well as the
     * fields: on `developer-tools` exactly one cluster reason names another
     * product, and one is enough to break the promise.
     */
    const anonymousIds = raw.ranking.map((row) => row.id);

    return {
      slug,
      category: raw.category,
      generatedAt,
      productCount: raw.ranking.length,
      categoryVersion: typeof categoryVersion === 'string' ? categoryVersion : raw.prompt_version,
      ...(typeof engineVersion === 'string' ? { engineVersion } : {}),
      ...(typeof caveat === 'string' ? { caveat } : {}),
      origin: 'seeded-run',
      anonymousIds,
      ranking: redactRanking(raw, anonymousIds, slug),
    };
  }
}

/**
 * A `SnapshotBoardSource` over a directory of board JSON. The local and CI story.
 *
 * Kept as its own name because that is what a test wants to construct: a workdir
 * and a snapshot root, with no environment involved.
 */
export class FileBoardSource extends SnapshotBoardSource {
  constructor(options: FileBoardSourceOptions = {}) {
    const workdir = options.workdir ?? resolveWorkdir();
    super({
      workdir,
      snapshots: new FileSnapshotSink(
        options.snapshotRoot ?? process.env['PIT_SNAPSHOT_ROOT'] ?? join(workdir, 'public'),
      ),
    });
  }
}

async function entries(dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => (kind === 'dir' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The source the routes use.
 *
 * The sink comes from `defaultSnapshotSink`, which is the same function
 * `service.ts` binds the pipeline's `deliver` step to — so the document this page
 * reads is, by construction, the document a placement wrote. Locally that is a
 * directory; in production it is the bucket behind the CDN.
 */
export function defaultBoardSource(): BoardSource {
  return new SnapshotBoardSource({ snapshots: defaultSnapshotSink() });
}
