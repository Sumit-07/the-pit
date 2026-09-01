/**
 * Where a run's state lives — which is the engine's `RunStore`, unchanged.
 *
 * `brief §2.3` ("retry only the failed phase"), `brief` Part 6 ("someone who
 * closes the tab at 40s returns to live progress") and `the-pit-agent-prompts.md`
 * Phase 2 ("jobs resumable: persist each phase result as it lands, never
 * batch-commit at the end") are three demands on the same state, and the engine
 * already holds it: `packages/engine/src/run/store.ts` writes a version-stamped
 * `PersistedPhase` envelope the moment each phase lands.
 *
 * So this module adds no state of its own. It adds two READS the engine's
 * interface does not expose because the engine never needed them — the CLI reads
 * `results.json` and `ranking.json` off disk itself, in `src/cli/load.ts`, which
 * is not part of the published entry point. The status page and the snapshot
 * publisher need the same two files, so `PipelineStore` is `RunStore` plus those
 * two readers and nothing else.
 *
 * The interface is also the seam where a durable, non-filesystem store plugs in.
 * Vercel's filesystem is ephemeral, so `FilePipelineStore` is the local and
 * CI story; the Postgres-backed implementation belongs to whoever owns
 * `packages/db`'s schema, and it arrives by implementing this interface rather
 * than by changing anything above it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_WORKDIR,
  FileRunStore,
  MemoryRunStore,
  type PhaseName,
  type ProductSet,
  type Ranking,
  type RunResults,
  type RunStore,
} from '@the-pit/engine';

/**
 * The engine's `RunStore` plus the two documents a surface reads back.
 *
 * Both readers return `undefined` for "not written yet" rather than throwing.
 * A run that has not reached its `rank` step has no `results.json`, and that is
 * the normal state of every in-flight run the status page is asked about.
 */
export interface PipelineStore extends RunStore {
  readResults(): Promise<RunResults | undefined>;
  readRanking(): Promise<Ranking | undefined>;
  /**
   * The durable identity of this run — `jobs.id` — when the store has one.
   *
   * `undefined` on the filesystem and memory stores, which key a run by a
   * directory and by nothing at all. It is on the interface rather than reached
   * for with a cast because it is what the delivery transaction names: `brief
   * §2.3` puts the attempt decrement in the same transaction that "marks it
   * delivered", `attempts_consume_requires_delivery` reads `jobs.delivered_at`
   * to enforce that, and a delivery with no run to mark cannot be settled at all.
   * Optional is therefore the honest type: a run that cannot be charged for is a
   * run whose store has no id, and the two facts should not be able to disagree.
   */
  readonly runId?: string;
  /**
   * The `category_snapshot_version` the board this run publishes is stored
   * under, when the store keys boards by one.
   *
   * `undefined` on the filesystem and memory stores, which hold a single
   * `ranking.json` and overwrite it — which is exactly why the defect this
   * property exists to close was invisible for as long as it was. On Postgres a
   * board is one `snapshots` row per population version, a PLACEMENT produces a
   * new board (`brief §1.2` moves every z-score the moment a product is
   * appended), and the version has to move with it or the write is refused by
   * `snapshots_body_immutable_trg` after the customer has been charged.
   *
   * It is read here rather than passed a second time so that the version the
   * published document, its CDN key and the frozen verdict payload are stamped
   * with is the version the row was actually written under. Two independent
   * copies of that answer is how a board comes to disagree with its own cache
   * key.
   */
  readonly publishedCategoryVersion?: string;
}

/**
 * `cjr/runs/<slug>/` on disk, per `01 §3`.
 *
 * Extends the engine's `FileRunStore` rather than reimplementing its paths, so
 * the layout stays defined in exactly one file. `FileRunStore.path` is the
 * public getter it exposes for precisely this.
 */
export class FilePipelineStore extends FileRunStore implements PipelineStore {
  constructor(category: string, workdir: string = DEFAULT_WORKDIR) {
    super(category, workdir);
  }

  async readResults(): Promise<RunResults | undefined> {
    return (await readJson(join(this.path, 'results.json'))) as RunResults | undefined;
  }

  async readRanking(): Promise<Ranking | undefined> {
    return (await readJson(join(this.path, 'ranking.json'))) as Ranking | undefined;
  }
}

/**
 * The in-memory store, for tests and for a dry local run.
 *
 * `MemoryRunStore` already records `results`, `ranking` and an ordered `writes`
 * log; this only exposes the two reads. The `writes` log is what lets a test
 * assert "persisted as it landed" rather than "persisted eventually" — the claim
 * `the-pit-agent-prompts.md` Phase 2 actually makes.
 */
export class MemoryPipelineStore extends MemoryRunStore implements PipelineStore {
  readResults(): Promise<RunResults | undefined> {
    return Promise.resolve(this.results);
  }

  readRanking(): Promise<Ranking | undefined> {
    return Promise.resolve(this.ranking);
  }
}

/**
 * The name a placement's PHASE envelopes are stored under.
 *
 * A placement writes a `score`, a `uniqueness` and a `customer` envelope, exactly
 * like a full run — and they are not the same documents. A placement's score
 * phase holds one product's rows; a full run's holds the category's. Its
 * `uniqueness` envelope holds a `Placement` (which cluster, is it new); a full
 * run's holds the whole cluster roster. Both are stamped with the same four
 * versions, so if they shared `cjr/runs/<slug>/phases/` the resume gate would
 * hand one to the other and be right to: the stamp matches, the phase name
 * matches, and nothing in the envelope says which KIND of run wrote it.
 *
 * What that would cost is not an exception. The placement's cluster step would
 * "resume" the seed run's roster as its own assignment; or a later full run would
 * resume a one-product score phase and rank a category off it. Both produce a
 * board rather than an error. So the phases live in their own scope, derived from
 * the product being placed, and the two kinds of run can never read each other's
 * work by accident.
 *
 * Only the phases move. `products.json`, `results.json` and `ranking.json` are
 * the CATEGORY's documents — the placement updates them in place, which is the
 * whole point of a placement — and they stay where the board and the next
 * submission look for them (`PlacementPhaseStore`).
 */
export function placementScope(category: string, productId: number): string {
  return `${category} placement ${productId}`;
}

/**
 * The category's store, with the phase envelopes redirected to a placement's own
 * scope. See `placementScope` for why.
 *
 * `slug` is deliberately the CATEGORY's: it is what the board snapshot is keyed
 * on, and a placement republishes the category's board, not a board of its own.
 */
export class PlacementPhaseStore implements PipelineStore {
  private readonly category: PipelineStore;
  private readonly scoped: PipelineStore;

  constructor(category: PipelineStore, scoped: PipelineStore) {
    this.category = category;
    this.scoped = scoped;
  }

  get slug(): string {
    return this.category.slug;
  }

  /**
   * The PLACEMENT's run, not the category's.
   *
   * `slug` above is deliberately the category's, because a placement republishes
   * the category's board. The run identity is deliberately the other way round: a
   * placement's phases live on their own job row (see `placementScope`), and that
   * row is what `jobs.delivered_at` must be set on and what
   * `consumeIdempotencyKey` keys the decrement to. Naming the category's seed run
   * here would mark a run somebody else paid for as delivered.
   */
  get runId(): string | undefined {
    return this.scoped.runId;
  }

  /**
   * The CATEGORY's, like `slug` and unlike `runId`: a placement republishes the
   * category's board, and the board is what this version names.
   */
  get publishedCategoryVersion(): string | undefined {
    return this.category.publishedCategoryVersion;
  }

  writePhase(phase: PhaseName, envelope: unknown): Promise<void> {
    return this.scoped.writePhase(phase, envelope);
  }

  readPhase(phase: PhaseName): Promise<unknown> {
    return this.scoped.readPhase(phase);
  }

  writeProducts(products: ProductSet): Promise<void> {
    return this.category.writeProducts(products);
  }

  writeResults(results: RunResults): Promise<void> {
    return this.category.writeResults(results);
  }

  writeRanking(ranking: Ranking): Promise<void> {
    return this.category.writeRanking(ranking);
  }

  readResults(): Promise<RunResults | undefined> {
    return this.category.readResults();
  }

  readRanking(): Promise<Ranking | undefined> {
    return this.category.readRanking();
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    // A file that has not been written yet is the normal case for an in-flight
    // run. Anything else — a permissions problem, a truncated write — is real and
    // is re-thrown, because reporting it as "not started" would tell a customer
    // their finished run had not begun.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
