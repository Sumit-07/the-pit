/**
 * Where the pipeline gets a category from.
 *
 * An Inngest event carries a slug, not forty products and two approved panels, so
 * something has to turn one into the other. That something is deliberately a
 * seam: `01 §3` puts the current source of truth in flat JSON under `cjr/` (which
 * is what the seeded categories on this branch actually are), while the Postgres
 * tables that will replace it are another agent's. Both satisfy this interface,
 * and nothing above it changes when the second arrives.
 *
 * Two rules the filesystem implementation keeps, both inherited from
 * `packages/engine/src/cli/load.ts` — which is not reachable from the engine's
 * published entry point, so they are restated rather than imported:
 *
 * 1. **The jury and the persona panel are re-validated on every read.** They are
 *    hand-edited between runs (`01 §4` Steps 2 and 3 are human approval gates),
 *    and an edit that broke the weights-keyed-by-metric rule would otherwise
 *    surface as silently reweighted composites on a board. `validateJury` and
 *    `validatePersonas` are the engine's own gates and are used unchanged.
 * 2. **`products.json` is read, never re-derived.** `Product.id` is an index into
 *    the usable rows of the source workbook; recomputing it from a sheet that has
 *    gained or lost a row renumbers every product, and ids are how every stored
 *    score, cluster and vote attaches to a product.
 *
 * The default `categoryVersion` is the installed jury's `prompt_version`, which
 * is what `engine seed` and `engine ab` use when `--version` is not given. It is
 * a default, not a definition: the enqueuer may pass an explicit category
 * snapshot version, and after a placement it must, because `brief §1.2` moves
 * every z-score in the category and `brief §1.3` keys the preview cache on that
 * version.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  categorySlug,
  DEFAULT_WORKDIR,
  validateJury,
  validatePersonas,
  type Jury,
  type PersonaPanel,
  type Product,
  type ProductSet,
} from '@the-pit/engine';

import type { PipelineInput } from './types';

/** Turns a slug into everything a run needs. */
export interface CategorySource {
  /** `undefined` when the category is not seeded here — not an error, a 404. */
  load(slug: string, options?: { categoryVersion?: string }): Promise<PipelineInput | undefined>;
}

/** A category that exists but is not runnable, with the reason a person needs. */
export class CategoryNotRunnableError extends Error {
  override readonly name = 'CategoryNotRunnableError';
}

/** `cjr/` on disk, per `01 §3`. */
export class FileCategorySource implements CategorySource {
  private readonly workdir: string;

  constructor(workdir: string = DEFAULT_WORKDIR) {
    this.workdir = workdir;
  }

  async load(slug: string, options?: { categoryVersion?: string }): Promise<PipelineInput | undefined> {
    const products = (await readJson(join(this.workdir, 'runs', slug, 'products.json'))) as ProductSet | undefined;
    if (products === undefined) return undefined;

    const jury = await this.jury(slug);
    const personas = await this.personas(slug);

    return {
      category: products.category,
      products: products.products satisfies readonly Product[],
      jury,
      personas,
      config: { categoryVersion: options?.categoryVersion ?? jury.prompt_version },
    };
  }

  /** The installed jury, re-validated. `01 §4` Step 2 (APPROVAL GATE 1). */
  private async jury(slug: string): Promise<Jury> {
    const path = join(this.workdir, 'references', 'jurors', `${slug}.json`);
    const raw = await readJson(path);
    if (raw === undefined) {
      throw new CategoryNotRunnableError(
        `no installed jury at ${path}. A run cannot be enqueued for a category whose panel has not been approved (01 §4 Step 2).`,
      );
    }
    const result = validateJury(raw);
    if (!result.valid) {
      throw new CategoryNotRunnableError(`${path} is not a valid jury: ${result.errors.join('; ')}`);
    }
    return result.value;
  }

  /** The installed persona panel, re-validated. `01 §4` Step 3 (APPROVAL GATE 2). */
  private async personas(slug: string): Promise<PersonaPanel> {
    const path = join(this.workdir, 'references', 'personas', `${slug}.json`);
    const raw = await readJson(path);
    if (raw === undefined) {
      throw new CategoryNotRunnableError(
        `no installed persona panel at ${path}. The Floor cannot convene without one (01 §4 Step 3).`,
      );
    }
    const result = validatePersonas(raw);
    if (!result.valid) {
      throw new CategoryNotRunnableError(`${path} is not a valid persona panel: ${result.errors.join('; ')}`);
    }
    return result.value;
  }
}

/**
 * An in-memory source, keyed by slug. For tests, and for a local dry run.
 *
 * Derives its keys with the engine's `categorySlug`, so a test cannot register a
 * category under a slug the rest of the system would never look it up by.
 */
export class MemoryCategorySource implements CategorySource {
  private readonly categories = new Map<string, PipelineInput>();

  constructor(inputs: readonly PipelineInput[] = []) {
    for (const input of inputs) this.categories.set(categorySlug(input.category), input);
  }

  add(input: PipelineInput): this {
    this.categories.set(categorySlug(input.category), input);
    return this;
  }

  load(slug: string, options?: { categoryVersion?: string }): Promise<PipelineInput | undefined> {
    const input = this.categories.get(slug);
    if (input === undefined) return Promise.resolve(undefined);
    if (options?.categoryVersion === undefined) return Promise.resolve(input);
    return Promise.resolve({ ...input, config: { ...input.config, categoryVersion: options.categoryVersion } });
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
