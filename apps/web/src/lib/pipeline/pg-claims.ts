/**
 * The durable `PlacementClaims` — `brief §2.2`'s idempotency key, enforced by the
 * unique index that has been sitting on `jobs` waiting for someone to use it.
 *
 * ## Why the guarantee is the index and not this file
 *
 * `packages/payments/src/submission/job.ts` says it about its own store, and it
 * is just as true here: "if that method is implemented as a SELECT followed by an
 * INSERT, this module provides no protection at all, and the race it fails to
 * guard is precisely the one a double click creates." So the claim is ONE
 * statement whose conflict is decided by `jobs_idempotency_key_uk`, and the
 * loser learns it lost by reading back who won.
 *
 * ## Which row a claim is
 *
 * The placement's own job row — `runJobId(slug, versions, 'full_run', productId)`,
 * the same id `PgPipelineStore` addresses when it is given a `placement` scope.
 * That is deliberate and it is what makes an Inngest RETRY of one event resume
 * rather than be refused: the retry computes the same id, finds the key already
 * on its own row, and owns it. A genuinely new event under a bumped
 * `category_snapshot_version` computes a DIFFERENT id, collides on the key, and
 * is a duplicate — which is the exact shape the double-placement takes, because
 * the first placement bumps that version on its way through.
 *
 * `jobs.result` on that row holds the finished `PlacementOutcome`. It is free to:
 * a placement's `results.json` goes to the CATEGORY's row through
 * `PlacementPhaseStore.writeResults`, and the scoped row is only ever a phase
 * namespace. Storing it under a `placement` key rather than at the top level
 * keeps it distinguishable from a `RunResults` at a glance.
 *
 * ## kind = 'full_run', still
 *
 * `jobs_placement_has_product_and_account` requires a `placement` row to carry the
 * product's uuid and the payer's email. A pipeline claim holds neither — it has a
 * slug, four versions and an engine id — and inventing them to satisfy a check
 * constraint would put a row in the audit ledger claiming a payer it never saw.
 * The row that says "someone paid to place product X" belongs to the submission
 * path, which knows both. This one is a namespace and a claim.
 */

import { categorySlug } from '@the-pit/engine';
import { categories, deterministicUuid, jobs, type Database } from '@the-pit/db';
import { eq, sql } from 'drizzle-orm';

import type { PlacementClaim, PlacementClaims, PlacementSubmission } from './claims';
import type { PlacementOutcome } from './placement';
import { PipelineStoreNotProvisionedError, runJobId } from './pg-store';

/** The `jobs` row a claim is taken on. See the module header. */
function claimRowId(submission: PlacementSubmission): string {
  return runJobId(categorySlug(submission.slug), submission.versions, 'full_run', submission.productId);
}

/** `jobs.idempotency_key`, behind `PlacementClaims`. */
export class PgPlacementClaims implements PlacementClaims {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async claim(submission: PlacementSubmission): Promise<PlacementClaim> {
    const runId = claimRowId(submission);

    try {
      // One statement. `ON CONFLICT (id)` covers the retry that already owns this
      // row; `COALESCE` means re-claiming keeps whatever key is on it rather than
      // stamping a second one. A DIFFERENT row already holding the key raises a
      // unique violation from `jobs_idempotency_key_uk`, which is the answer we
      // want and the only place the winner is actually decided.
      await this.db
        .insert(jobs)
        .values({ ...(await this.row(submission, runId)), idempotencyKey: submission.key })
        .onConflictDoUpdate({
          target: jobs.id,
          set: { idempotencyKey: sql`coalesce(${jobs.idempotencyKey}, excluded.idempotency_key)` },
        });
    } catch {
      // Swallowed on purpose: the reason is read back below, and it is more
      // informative than the driver's message. A failure that is NOT a key
      // collision surfaces on the next line, because the select finds no owner
      // and the caller is told nobody holds the key.
    }

    const [owner] = await this.db
      .select({ id: jobs.id, result: jobs.result })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, submission.key))
      .limit(1);

    if (owner === undefined) {
      // The insert failed for a reason that was not the unique index. Claiming
      // nothing and running anyway would be the double-spend this module exists
      // to prevent, so it is refused loudly instead.
      throw new PipelineStoreNotProvisionedError(
        `the placement claim for idempotency key ${JSON.stringify(submission.key)} could not be written to ` +
          '`jobs`, and no row holds it. Refusing to run: an unclaimed placement can be run twice for one ' +
          'payment (brief §2.2).',
      );
    }

    const outcome = storedOutcome(owner.result);
    return {
      runId: owner.id,
      mine: owner.id === runId,
      ...(outcome === undefined ? {} : { outcome }),
    };
  }

  async record(submission: PlacementSubmission, outcome: PlacementOutcome): Promise<void> {
    // Scoped to the owner's own row AND to the key, so a duplicate that reached
    // here could not overwrite the first placement's answer with its own.
    await this.db
      .update(jobs)
      .set({ result: { placement: outcome } })
      .where(eq(jobs.id, claimRowId(submission)));
  }

  /** The columns a `jobs` row cannot be without. */
  private async row(submission: PlacementSubmission, id: string): Promise<typeof jobs.$inferInsert> {
    return {
      id,
      kind: 'full_run',
      // Never `succeeded` and never `delivered_at`: delivery is the money event
      // (`brief §2.3`) and it is written by the transaction that consumes the
      // attempt, not by a claim taken before the first step runs.
      status: 'running',
      categoryId: await this.categoryId(submission),
      promptVersion: submission.versions.prompt_version,
      personaVersion: submission.versions.persona_version,
      categorySnapshotVersion: submission.versions.category_version,
      engineVersion: submission.versions.engine_version,
    };
  }

  private async categoryId(submission: PlacementSubmission): Promise<string> {
    const slug = categorySlug(submission.slug);
    const [row] = await this.db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)).limit(1);
    if (row === undefined) {
      throw new PipelineStoreNotProvisionedError(
        `no category is installed under the slug ${JSON.stringify(slug)}, so a placement against it cannot be ` +
          'claimed. Seed the category before enqueuing a submission.',
      );
    }
    return row.id;
  }
}

/** The `PlacementOutcome` a finished owner recorded, if it recorded one. */
function storedOutcome(result: unknown): PlacementOutcome | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const placement = (result as { placement?: unknown }).placement;
  if (typeof placement !== 'object' || placement === null) return undefined;
  const status = (placement as { status?: unknown }).status;
  return status === 'placed' || status === 'held' ? (placement as PlacementOutcome) : undefined;
}
