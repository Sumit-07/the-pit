-- The edge a buyer's status page walks: submission -> the run it bought.
--
-- Every other route from one to the other was a dead end. `submissions` holds no
-- account and no job — it is a draft written before checkout opens, and under
-- guest checkout (`brief §2.1`) there is no identity to put on it. `jobs`
-- addressed the work by `idempotency_key`, a hash over an account id the buyer
-- has no way to supply from a page, and by `product_id`, which is not written
-- until the catalogue row exists — the LAST step of the run. So the one moment a
-- customer most wants to look, the first ninety seconds, was the one moment
-- nothing could resolve.
--
-- ## Two columns, because the version alone is not the run
--
-- `submission_id` finds the row. `placement_engine_id` is what makes the row
-- usable: `runJobId` folds the engine id into the job's own id, the placement's
-- phase envelopes hang off it, the board it publishes is
-- `nextCategorySnapshotVersion(category_version, engine_id)`, and the verdict is
-- keyed to the job. Without it a status page knows the category and nothing else
-- about the run inside it.
--
-- The version the run is judged under is `category_snapshot_version`, already on
-- this table and already stamped at enqueue. That is the point of reading status
-- from the JOB rather than from the category: a placement that lands after this
-- one moves `categories.category_snapshot_version`, and a page that read the
-- category's current value would find an empty run for a job that is fine.
--
-- ## Written by the claim, not by the first phase
--
-- `lib/pipeline/pg-claims.ts` inserts this row before the first step runs, so
-- both columns are set before anything is spent. A page that waited for the first
-- persisted phase would 404 for the whole of the score phase, which is the part
-- of the wait that actually feels long.
--
-- Nullable, because most jobs have no buyer: a seed run, a preview and an admin
-- placement all have nobody watching. Backfilling is not possible and not needed
-- — every job written before this migration has either delivered or been
-- abandoned, and the status page is for runs in flight.
--
-- Forward only, per `cli/migrate.ts`.

ALTER TABLE "jobs" ADD COLUMN "submission_id" uuid;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "placement_engine_id" integer;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX "jobs_submission_idx" ON "jobs" USING btree ("submission_id","created_at");
