/**
 * The durable `CategorySource` — a category, its population and its two frozen
 * panels, read from Postgres.
 *
 * ## Why the filesystem source cannot stay bound in production
 *
 * `FileCategorySource` reads `cjr/runs/<slug>/products.json` and the two
 * installed panels beside it. That is right locally, right in CI, and right for
 * `01 §4`'s offline seeding — and it survived into the production binding on the
 * argument that `cjr/` is COMMITTED, so it ships with the deployment and every
 * read succeeds.
 *
 * Every read does succeed. What it cannot do is see a placement.
 * `brief §1.2`: appending a product "shifts the population mean and std and
 * therefore moves every existing z-score", so the placement path appends a
 * `products` row and bumps `categories.category_snapshot_version`. Both of those
 * land in Postgres. A committed `products.json` has neither — so the first real
 * paid placement would be scored against a population that does not include it,
 * under a snapshot version that has already moved, and the board would be
 * computed over the wrong set. It is not a crash; it is a wrong number, which is
 * worse.
 *
 * So the production binding reads the tables the placement path writes.
 *
 * ## The panels are re-validated on every read, exactly as on disk
 *
 * `02 §8`: a jury or panel is "generated and approved *offline* … and stored,
 * versioned, in Postgres", and "only an admin action bumps a version". An admin
 * action is a hand-written INSERT, and a hand-written INSERT can produce a row
 * that satisfies `jury_versions_metrics_count` (3-6 metrics, 6 jurors — the two
 * claims a check constraint can make) and still breaks the rule a check
 * constraint cannot see: that every juror's weight vector is keyed by the
 * rubric's metric names. `validateJury` and `validatePersonas` are the engine's
 * own gates and are the same two `FileCategorySource` runs, for the same reason:
 * a silently reweighted composite is a wrong board that nothing downstream can
 * detect.
 *
 * ## The one behavioural difference from the filesystem source, and it is the point
 *
 * `FileCategorySource` defaults `categoryVersion` to the installed jury's
 * `prompt_version`, because flat files hold no population version at all. This
 * source defaults it to `categories.category_snapshot_version` — the column
 * `brief §1.3` keys the preview cache on and the placement path bumps. That
 * default is the entire fix: a run enqueued with no explicit version now picks up
 * the CURRENT population version rather than one frozen at the last commit.
 *
 * ## Products
 *
 * Ordered by `engine_id`, which is `Product.id` in the engine and the identity
 * every stored score, cluster assignment and demand vote hangs off. It is read,
 * never re-derived — `packages/engine/src/run/store.ts` and
 * `packages/db/src/schema/products.ts` both spell out that re-deriving it from a
 * set that has gained or lost a row renumbers every product.
 *
 * `held` and `rejected` rows are excluded. A held submission is `DECISIONS.md`
 * S9's flag-not-drop: it is awaiting a human and has never been scored, so
 * putting it in the population would have the jury score a product nobody
 * approved and would move every z-score in the category to do it. `pending` IS
 * included: that is what a row looks like between `writeProducts` and the board
 * that places it, which is the middle of a run.
 */

import {
  validateJury,
  validatePersonas,
  type Jury,
  type PersonaPanel,
  type Product,
} from '@the-pit/engine';
import { categories, juryVersions, personaVersions, products, type Database } from '@the-pit/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { CategoryNotRunnableError, type CategorySource } from './catalog';
import type { PipelineInput } from './types';

/** Statuses that are part of the scored population. See the module header. */
const RUNNABLE_STATUSES = ['placed', 'pending'] as const;

/** `categories` + `products` + the two version tables, behind `CategorySource`. */
export class PgCategorySource implements CategorySource {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Everything a run needs, or `undefined` when the slug is not installed here.
   *
   * `undefined` is a 404 and is the same answer the filesystem source gives for a
   * missing directory. A category that EXISTS but has no approved jury or panel
   * is a different thing entirely — someone provisioned half of it — and that is
   * a `CategoryNotRunnableError` naming which half, because `01 §4` Steps 2 and 3
   * are human approval gates and no retry passes one.
   */
  async load(slug: string, options?: { categoryVersion?: string }): Promise<PipelineInput | undefined> {
    const [category] = await this.db
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        promptVersion: categories.promptVersion,
        personaVersion: categories.personaVersion,
        categorySnapshotVersion: categories.categorySnapshotVersion,
      })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1);
    if (category === undefined) return undefined;

    const [jury, personas, population] = await Promise.all([
      this.jury(slug, category.id, category.type, category.promptVersion),
      this.personas(slug, category.id, category.personaVersion),
      this.products(category.id),
    ]);

    return {
      category: category.name,
      products: population,
      jury,
      personas,
      config: {
        // The point of this whole module: the CURRENT population version, not one
        // frozen into a committed file. `brief §1.3` keys the preview cache on it
        // and `brief §1.2` moves it on every placement.
        categoryVersion: options?.categoryVersion ?? category.categorySnapshotVersion,
      },
    };
  }

  /** The installed jury row, re-validated. `01 §4` Step 2 (APPROVAL GATE 1). */
  private async jury(slug: string, categoryId: string, type: string, version: string): Promise<Jury> {
    const [row] = await this.db
      .select({ metrics: juryVersions.metrics, jurors: juryVersions.jurors })
      .from(juryVersions)
      .where(and(eq(juryVersions.categoryId, categoryId), eq(juryVersions.version, version)))
      .limit(1);
    if (row === undefined) {
      throw new CategoryNotRunnableError(
        `no jury_versions row for ${JSON.stringify(slug)} at version ${JSON.stringify(version)}, which is the ` +
          'version `categories.prompt_version` points at. A run cannot be enqueued for a category whose panel ' +
          'has not been approved and installed (01 §4 Step 2).',
      );
    }

    // `type` lives on the category rather than on the jury row, because it is a
    // property of the category and `Jury` merely carries it into the prompts.
    const result = validateJury({ type, prompt_version: version, metrics: row.metrics, jurors: row.jurors });
    if (!result.valid) {
      throw new CategoryNotRunnableError(
        `jury_versions (${slug}, ${version}) is not a valid jury: ${result.errors.join('; ')}`,
      );
    }
    return result.value;
  }

  /** The installed persona panel, re-validated. `01 §4` Step 3 (APPROVAL GATE 2). */
  private async personas(slug: string, categoryId: string, version: string): Promise<PersonaPanel> {
    const [row] = await this.db
      .select({ personas: personaVersions.personas })
      .from(personaVersions)
      .where(and(eq(personaVersions.categoryId, categoryId), eq(personaVersions.version, version)))
      .limit(1);
    if (row === undefined) {
      throw new CategoryNotRunnableError(
        `no persona_versions row for ${JSON.stringify(slug)} at version ${JSON.stringify(version)}. ` +
          'The Floor cannot convene without an approved panel (01 §4 Step 3).',
      );
    }

    const result = validatePersonas({ persona_version: version, personas: row.personas });
    if (!result.valid) {
      throw new CategoryNotRunnableError(
        `persona_versions (${slug}, ${version}) is not a valid panel: ${result.errors.join('; ')}`,
      );
    }
    return result.value;
  }

  /** The category's population, in `engine_id` order. */
  private async products(categoryId: string): Promise<readonly Product[]> {
    const rows = await this.db
      .select({
        engineId: products.engineId,
        name: products.name,
        description: products.description,
        url: products.url,
        normalizedUrl: products.normalizedUrl,
      })
      .from(products)
      .where(and(eq(products.categoryId, categoryId), inArray(products.status, [...RUNNABLE_STATUSES])))
      .orderBy(asc(products.engineId));

    return rows.map((row) => ({
      id: row.engineId,
      name: row.name,
      description: row.description,
      url: row.url,
      normalized_url: row.normalizedUrl,
      // The source sheet's own position is not stored — `packages/db/src/seed/
      // rehydrate.ts` says why, and reaches the same reconstruction: nothing in
      // `01 §6` reads `orig_rank`, and `engine_id` is already the ingest order it
      // was derived from. Reproduced so the shape is total, not because it is the
      // sheet's number.
      orig_rank: row.engineId + 1,
    }));
  }
}
