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
 * **This module has no runtime import of `@the-pit/engine`, `@the-pit/db`,
 * `postgres` or an SDK.** The engine types it uses are `import type` and are
 * erased at compile time; the only runtime dependencies are `node:fs/promises`
 * and `node:path`. So "a board read cannot open a database connection or a model
 * client" is checkable by reading the import list, and `test/boards-read-path.test.ts`
 * walks the transitive graph from the routes and fails if anything on it gains
 * one. A rule that is enforced by the module graph does not decay.
 *
 * `apps/web/src/lib/pipeline/` owns the *write* side — `buildSnapshot` and
 * `FileSnapshotSink.publish`, called from the pipeline's `deliver` step. This is
 * the read side, deliberately a separate module: the write side imports the
 * engine (it needs `ENGINE_VERSION`), and a read path that imported the write
 * path would inherit that. The one thing shared is the envelope's shape, taken as
 * a type only.
 *
 * ## Two sources, one shape
 *
 * 1. **A published snapshot** — `<snapshotRoot>/boards/<slug>.json`, written by a
 *    placement. This is what production reads (from a bucket behind a CDN; the
 *    filesystem is the local and CI story, exactly as `service.ts` has it).
 * 2. **A seeded run** — `<workdir>/runs/<slug>/ranking.json`, which is what the
 *    two categories on this branch actually are. `01 §3` puts the current source
 *    of truth in flat JSON under `cjr/`, a `ranking.json` is only written for a
 *    DELIVERED run, and the file is byte-identical in shape to the `ranking`
 *    field of a published snapshot. Reading it costs one `readFile`.
 *
 * A published snapshot wins where both exist, because it is the document a
 * placement most recently wrote. Neither path computes a score.
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

import type { BoardSnapshot } from '@/lib/pipeline/snapshot';

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
  /** The engine's ranking document, verbatim. Never re-derived here. */
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

/** Published snapshots first, seeded runs second. Both are `readFile` and nothing more. */
export class FileBoardSource implements BoardSource {
  private readonly workdir: string;
  private readonly snapshotRoot: string;

  constructor(options: FileBoardSourceOptions = {}) {
    this.workdir = options.workdir ?? resolveWorkdir();
    this.snapshotRoot =
      options.snapshotRoot ?? process.env['PIT_SNAPSHOT_ROOT'] ?? join(this.workdir, 'public');
  }

  async list(): Promise<string[]> {
    const slugs = new Set<string>();
    for (const name of await entries(join(this.snapshotRoot, 'boards'), 'file')) {
      if (name.endsWith('.json')) {
        const slug = name.slice(0, -'.json'.length);
        if (isBoardSlug(slug)) slugs.add(slug);
      }
    }
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

  private async readSnapshot(slug: string): Promise<BoardDocument | undefined> {
    const raw = await readJson(join(this.snapshotRoot, 'boards', `${slug}.json`));
    if (!isSnapshot(raw)) return undefined;
    return {
      slug,
      category: raw.category,
      generatedAt: raw.generated_at,
      productCount: raw.product_count,
      categoryVersion: raw.category_version,
      engineVersion: raw.engine_version,
      origin: 'snapshot',
      ranking: raw.ranking,
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

    return {
      slug,
      category: raw.category,
      generatedAt,
      productCount: raw.ranking.length,
      categoryVersion: typeof categoryVersion === 'string' ? categoryVersion : raw.prompt_version,
      ...(typeof engineVersion === 'string' ? { engineVersion } : {}),
      ...(typeof caveat === 'string' ? { caveat } : {}),
      origin: 'seeded-run',
      ranking: raw,
    };
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

/** The source the routes use. One place to swap the filesystem for a bucket. */
export function defaultBoardSource(): BoardSource {
  return new FileBoardSource();
}
