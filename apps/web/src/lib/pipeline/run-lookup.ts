/**
 * One submission, and the run it bought.
 *
 * ## The bug this module exists to remove
 *
 * The status page used to be keyed on the CATEGORY slug and read phases at the
 * category's CURRENT `category_snapshot_version`. A running job is stamped with
 * the version that was read when it was enqueued, and every placement that lands
 * afterwards moves the category's — `brief §1.2`, appending a product moves every
 * z-score, so it is a different board under a different version. So the moment
 * anybody else's submission delivered, the waiting customer's page addressed a
 * job row that does not exist and reported an empty run: five steps pending, on
 * the page they opened to be reassured.
 *
 * Every version here comes off the JOB. `jobs.category_snapshot_version` is what
 * the run is actually being judged under, `jobs.placement_engine_id` is which
 * product inside it, and neither moves once the row is written.
 *
 * ## What the two columns buy
 *
 *   submission -> jobs.submission_id      -> the run
 *   jobs.category_snapshot_version        -> the versions the phases are stamped with
 *   jobs.placement_engine_id              -> the phase scope, and the board version
 *   jobs.id -> verdicts.job_id            -> the permanent URL, once it exists
 *
 * The board version is DERIVED rather than stored, by the same
 * `nextCategorySnapshotVersion` the placement publishes under. Deriving it here
 * keeps one definition of "which board did this run produce"; storing a second
 * copy would be a second thing to keep in step with the run.
 *
 * ## No submission is trusted to name a category
 *
 * The category comes from the job's own `category_id`, joined here. A page that
 * read `submissions.category_slug` would be reading a column written before the
 * payment, by the form, and using it to choose which run's phases to show.
 */

import { and, desc, eq } from 'drizzle-orm';
import { categories, jobs, submissions, verdicts, type Database } from '@the-pit/db';

/** Where one buyer's run is, in the terms the pipeline addresses it by. */
export interface SubmissionRun {
  /** The `jobs` row. Also `verdicts.job_id`, when a verdict exists. */
  readonly runId: string;
  readonly categorySlug: string;
  /** `jobs.category_snapshot_version` — the version the run READ. Never the category's. */
  readonly categoryVersion: string;
  /** `jobs.placement_engine_id`. Absent on a job that is not placing anything. */
  readonly engineId: number | null;
  /** `verdicts.public_slug`, once the run has delivered. */
  readonly verdictSlug: string | null;
}

/** The submission itself, whether or not a run has started against it. */
export interface SubmissionRecord {
  readonly submissionId: string;
  readonly name: string;
  readonly categorySlug: string;
  /** The run this submission bought, or `null` while the webhook has not enqueued one. */
  readonly run: SubmissionRun | null;
}

/**
 * The one read the status surfaces share.
 *
 * A single method, and it is a READ. There is no write on this seam and there
 * must not be: the status page is reachable by anyone holding a signed link, and
 * a lookup that could touch a job would be a way to move somebody's run from a
 * URL.
 */
export interface SubmissionRunSource {
  find(submissionId: string): Promise<SubmissionRecord | null>;
}

/** Postgres is UUID-typed; a malformed id is a 404 rather than a driver error. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresSubmissionRunSource(db: Database): SubmissionRunSource {
  return {
    async find(submissionId: string): Promise<SubmissionRecord | null> {
      if (!UUID_SHAPE.test(submissionId)) return null;

      const [draft] = await db
        .select({ name: submissions.name, categorySlug: submissions.categorySlug })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);
      if (draft === undefined) return null;

      // Newest first. A free retry resumes the same row, so more than one is a
      // re-pitch under moved versions — and the run the buyer is watching is the
      // one that started last.
      const [job] = await db
        .select({
          runId: jobs.id,
          categorySlug: categories.slug,
          categoryVersion: jobs.categorySnapshotVersion,
          engineId: jobs.placementEngineId,
        })
        .from(jobs)
        .innerJoin(categories, eq(categories.id, jobs.categoryId))
        .where(eq(jobs.submissionId, submissionId))
        .orderBy(desc(jobs.createdAt))
        .limit(1);

      if (job === undefined) {
        return { submissionId, name: draft.name, categorySlug: draft.categorySlug, run: null };
      }

      const [verdict] = await db
        .select({ publicSlug: verdicts.publicSlug })
        .from(verdicts)
        .where(and(eq(verdicts.jobId, job.runId)))
        .limit(1);

      return {
        submissionId,
        name: draft.name,
        categorySlug: draft.categorySlug,
        run: { ...job, verdictSlug: verdict?.publicSlug ?? null },
      };
    },
  };
}
