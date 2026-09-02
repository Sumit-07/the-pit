/**
 * Submission -> run, against a real Postgres.
 *
 * The whole status page hangs off one join, and the join hangs off two columns
 * that did not exist until `0011_run_status_link.sql`. So this suite runs the
 * real DDL under PGlite — Postgres in-process — rather than against a fake that
 * would only confirm the fake: the migration has to apply, the foreign key has to
 * hold, and the claim has to actually write the link before the first step runs.
 *
 * The last test is the regression the page was rebuilt for, stated at the level
 * it actually happened: `categories.category_snapshot_version` moves when a later
 * placement lands, and the version this lookup returns must not move with it.
 */

import type { PhaseVersions } from '@the-pit/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PgPlacementClaims } from '@/lib/pipeline/pg-claims';
import { runJobId } from '@/lib/pipeline/pg-store';
import { createPostgresSubmissionRunSource } from '@/lib/pipeline/run-lookup';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, PERSONA_VERSION, PROMPT_VERSION } from './helpers/panel.js';
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';

let database: TestDatabase;
let categoryId = '';

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec('TRUNCATE categories, jobs, products, snapshots, rankings, submissions, verdicts CASCADE;');
  categoryId = await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
});

const ENGINE_ID = 99;
const HASH = 'a'.repeat(64);
const KEY = 'c'.repeat(64);

const VERSIONS: PhaseVersions = {
  category_version: CATEGORY_VERSION,
  prompt_version: PROMPT_VERSION,
  persona_version: PERSONA_VERSION,
  engine_version: 'engine-1',
};

/** The draft the buyer typed, written before checkout opened. */
async function seedSubmission(): Promise<string> {
  const result = await database.pg.query<{ id: string }>(
    `INSERT INTO submissions
       (category_slug, name, url, normalized_url, description, description_hash, cycle_id, tier, attempt_number)
     VALUES ($1, 'Margin', 'https://example.com/99', 'example.com/99', 'Notes into actions.', $2, 'cycle-1', 'single', 1)
     RETURNING id`,
    [CATEGORY_SLUG, HASH],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('the submission was not inserted');
  return id;
}

/** The claim the webhook's placement takes, before a single step runs. */
async function claim(submissionId: string): Promise<string> {
  await new PgPlacementClaims(database.db).claim({
    key: KEY,
    slug: CATEGORY_SLUG,
    versions: VERSIONS,
    productId: ENGINE_ID,
    submissionId,
  });
  return runJobId(CATEGORY_SLUG, VERSIONS, 'full_run', ENGINE_ID);
}

describe('finding the run a submission bought', () => {
  it('resolves it from the claim alone, before any phase has landed', async () => {
    const submissionId = await seedSubmission();
    const runId = await claim(submissionId);

    const found = await createPostgresSubmissionRunSource(database.db).find(submissionId);
    expect(found?.name).toBe('Margin');
    expect(found?.run).toEqual({
      runId,
      categorySlug: CATEGORY_SLUG,
      categoryVersion: CATEGORY_VERSION,
      engineId: ENGINE_ID,
      verdictSlug: null,
    });
  });

  it('answers with the draft and no run while the webhook has not enqueued one', async () => {
    const submissionId = await seedSubmission();
    const found = await createPostgresSubmissionRunSource(database.db).find(submissionId);
    expect(found?.run).toBeNull();
    expect(found?.categorySlug).toBe(CATEGORY_SLUG);
  });

  it('is null for a submission nobody wrote, and for a value that is not an id', async () => {
    const source = createPostgresSubmissionRunSource(database.db);
    expect(await source.find('00000000-0000-4000-8000-000000000000')).toBeNull();
    // Postgres is uuid-typed; a malformed id is a 404 rather than a driver error.
    expect(await source.find('not-a-uuid')).toBeNull();
  });

  it('carries the verdict slug once one is written against the run', async () => {
    const submissionId = await seedSubmission();
    const runId = await claim(submissionId);

    const product = await database.pg.query<{ id: string }>(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, submitted_by_email, placed_at)
       VALUES ($1, $2, 'Margin', 'https://example.com/99', 'example.com/99', 'Notes into actions.', $3,
          'paid', 'placed', 'payer@example.com', now())
       RETURNING id`,
      [categoryId, ENGINE_ID, HASH],
    );
    // A verdict may only name a delivered job, and delivery is the money event
    // (`brief §2.3`). The trigger says so; this is the transaction settlement
    // would have run.
    await database.pg.query(
      `UPDATE jobs SET status = 'succeeded', delivered_at = now() WHERE id = $1`,
      [runId],
    );
    await database.pg.query(
      `INSERT INTO verdicts (public_slug, product_id, job_id, payload, product_count)
       VALUES ('quiet-anvil-4417', $1, $2, '{}'::jsonb, 9)`,
      [product.rows[0]?.id, runId],
    );

    const found = await createPostgresSubmissionRunSource(database.db).find(submissionId);
    expect(found?.run?.verdictSlug).toBe('quiet-anvil-4417');
  });

  /**
   * The regression, at the level it happened.
   *
   * A later placement republishes the board and moves
   * `categories.category_snapshot_version` in the same transaction
   * (`pg-store.ts`'s `publishAs`). The waiting customer's job is not touched by
   * that, and the version their status is read at must come off the job.
   */
  it('keeps the version stamped on the job when the category moves under it', async () => {
    const submissionId = await seedSubmission();
    await claim(submissionId);

    await database.pg.query('UPDATE categories SET category_snapshot_version = $1 WHERE id = $2', [
      `${CATEGORY_VERSION}+p7`,
      categoryId,
    ]);

    const found = await createPostgresSubmissionRunSource(database.db).find(submissionId);
    expect(found?.run?.categoryVersion).toBe(CATEGORY_VERSION);
  });
});
