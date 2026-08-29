/**
 * Where a run's artifacts land, and — more importantly — WHEN.
 *
 * `docs/plans/phase-1-engine.md` Task 7: "Persist each phase result as it lands;
 * never batch-commit at the end." That is not a tidiness preference. `brief §2.3`
 * says a failed run is retried and that the retry should re-run only the failed
 * phase, and `brief` Part 7 says each phase is one Inngest step. Both are only
 * true if a phase that succeeded is on disk BEFORE the next phase runs: a
 * batch-commit at the end means a Customer-phase failure throws away six paid
 * juror calls and a paid clustering call, and the free retry re-buys all of them.
 *
 * `01 §3` fixes the layout: everything is flat JSON under `cjr/`, no database.
 * The phase files are this engine's addition to that layout — `01`'s Workflow
 * held its intermediate results in memory because it was a single process that
 * either returned or did not.
 *
 *   cjr/runs/<slug>/products.json            `01 §4` Step 1's prepared category
 *   cjr/runs/<slug>/phases/score.json        each written the moment its phase lands
 *   cjr/runs/<slug>/phases/uniqueness.json
 *   cjr/runs/<slug>/phases/customer.json
 *   cjr/runs/<slug>/results.json             `01 §4` Step 5's Workflow return value
 *   cjr/runs/<slug>/ranking.json             `01 §6.6`, recomputable offline from the above
 *
 * `products.json` is written by this engine, not merely read by it. `Product.id`
 * is a 0-based index into the USABLE rows of the source workbook, so re-deriving
 * it from a sheet that has since gained or lost a row renumbers every product —
 * and ids are how every stored score, cluster and vote attaches to a product. A
 * resumed phase keyed to ids that shifted underneath it would silently
 * misattribute scores. Writing the file on the first run is what makes the
 * "read it first, so ids are stable" path true rather than aspirational.
 *
 * The phase files are version-stamped envelopes (`PersistedPhase`); the path
 * carries only the slug, so the versions have to travel inside the file.
 *
 * The interface exists so tests can watch the ORDER of writes, which is the only
 * way to assert "persisted as it lands" rather than "persisted eventually":
 * `MemoryRunStore` records every write, so a test can fail a later phase and
 * still assert the earlier one is already stored.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { categorySlug } from '../panels/seeded.js';
import type { ProductSet, Ranking } from '../types.js';
import type { PhaseName, RunResults } from './types.js';

/** `cjr/`, per `01 §3`. Relative to the process working directory. */
export const DEFAULT_WORKDIR = 'cjr';

/**
 * The persistence seam. Three writers and one reader; the reader is what makes a
 * run resumable, per `brief §2.3`'s "retry only the failed phase".
 */
export interface RunStore {
  readonly slug: string;
  /** Write one phase's version-stamped envelope the moment the phase lands. */
  writePhase(phase: PhaseName, envelope: unknown): Promise<void>;
  /** Read a previously persisted envelope, or `undefined` if there is none. */
  readPhase(phase: PhaseName): Promise<unknown>;
  /** Pin `Product.id` for every later run and every resume. See the header. */
  writeProducts(products: ProductSet): Promise<void>;
  writeResults(results: RunResults): Promise<void>;
  writeRanking(ranking: Ranking): Promise<void>;
}

/** JSON on disk under `cjr/runs/<slug>/`, exactly as `01 §3` lays it out. */
export class FileRunStore implements RunStore {
  readonly slug: string;
  private readonly dir: string;

  constructor(category: string, workdir: string = DEFAULT_WORKDIR) {
    this.slug = categorySlug(category);
    if (this.slug === '') {
      throw new RangeError(`FileRunStore: category ${JSON.stringify(category)} has no slug`);
    }
    this.dir = join(workdir, 'runs', this.slug);
  }

  /** The directory this run writes into, for a CLI that wants to print it. */
  get path(): string {
    return this.dir;
  }

  async writePhase(phase: PhaseName, envelope: unknown): Promise<void> {
    await this.write(join(this.dir, 'phases', `${phase}.json`), envelope);
  }

  async writeProducts(products: ProductSet): Promise<void> {
    await this.write(join(this.dir, 'products.json'), products);
  }

  async readPhase(phase: PhaseName): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'phases', `${phase}.json`), 'utf8')) as unknown;
    } catch (error) {
      // A phase that was never run is the normal case, not an error. Anything
      // else — a permissions problem, a half-written file — is a real failure and
      // is re-thrown, because silently treating it as "not run yet" would re-buy
      // a phase that is already paid for.
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeResults(results: RunResults): Promise<void> {
    await this.write(join(this.dir, 'results.json'), results);
  }

  async writeRanking(ranking: Ranking): Promise<void> {
    await this.write(join(this.dir, 'ranking.json'), ranking);
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * An in-memory store that remembers the order it was written in.
 *
 * Global Constraint 5: the whole suite runs offline with no environment. This
 * also keeps the persistence assertions honest — `writes` is an ordered log, so a
 * test asserts that `uniqueness` was stored before the Customer phase threw,
 * which is the actual claim "persist as it lands" makes.
 */
export class MemoryRunStore implements RunStore {
  readonly slug: string;
  /** Every write, in order: `'phase:score'`, `'results'`, `'ranking'`. */
  readonly writes: string[] = [];
  readonly phases = new Map<PhaseName, unknown>();
  products: ProductSet | undefined;
  results: RunResults | undefined;
  ranking: Ranking | undefined;

  constructor(category: string, seed?: ReadonlyMap<PhaseName, unknown>) {
    this.slug = categorySlug(category);
    for (const [phase, value] of seed ?? []) this.phases.set(phase, value);
  }

  writePhase(phase: PhaseName, envelope: unknown): Promise<void> {
    // Round-tripped through JSON so a test cannot pass by holding a live
    // reference to an object the orchestrator mutates after persisting it.
    this.phases.set(phase, JSON.parse(JSON.stringify(envelope)) as unknown);
    this.writes.push(`phase:${phase}`);
    return Promise.resolve();
  }

  writeProducts(products: ProductSet): Promise<void> {
    this.products = products;
    this.writes.push('products');
    return Promise.resolve();
  }

  readPhase(phase: PhaseName): Promise<unknown> {
    return Promise.resolve(this.phases.get(phase));
  }

  writeResults(results: RunResults): Promise<void> {
    this.results = results;
    this.writes.push('results');
    return Promise.resolve();
  }

  writeRanking(ranking: Ranking): Promise<void> {
    this.ranking = ranking;
    this.writes.push('ranking');
    return Promise.resolve();
  }
}
