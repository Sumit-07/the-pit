/**
 * The durable placement claim, against a real Postgres.
 *
 * The claim in `claims.ts` is only worth as much as the constraint under it.
 * `packages/payments/src/submission/job.ts` makes the point about its own store:
 * a store that reads before it writes "provides no protection at all, and the
 * race it fails to guard is precisely the one a double click creates." So these
 * tests run against PGlite — Postgres itself, in-process, with the real DDL and
 * the real `jobs_idempotency_key_uk` — rather than against a mock that would only
 * confirm the mock.
 *
 * What is being prevented: two `pit/placement.requested` events for ONE
 * submission, each running the whole pipeline. Twelve juror calls, two clustering
 * passes and two persona rounds for one $5. The customer is charged once
 * (`brief §2.3` consumes an attempt only on delivery) and therefore never
 * notices, which is why it has to be caught here rather than in a support queue.
 */

import type { PhaseVersions } from '@the-pit/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PlacementOutcome, PlacementSubmission } from '@/lib/pipeline';
import { PgPlacementClaims } from '@/lib/pipeline/pg-claims';
import { runJobId } from '@/lib/pipeline/pg-store';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, PERSONA_VERSION, PROMPT_VERSION } from './helpers/panel.js';
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec('TRUNCATE categories, jobs, products, snapshots, rankings CASCADE;');
  await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
});

/** `jobIdempotencyKey` from `@the-pit/payments`, as a submission carries it. */
const KEY = 'c'.repeat(64);
const PRODUCT_ID = 99;

function versions(categoryVersion: string = CATEGORY_VERSION): PhaseVersions {
  return {
    category_version: categoryVersion,
    prompt_version: PROMPT_VERSION,
    persona_version: PERSONA_VERSION,
    engine_version: 'engine-1',
  };
}

function submission(categoryVersion: string = CATEGORY_VERSION, key: string = KEY): PlacementSubmission {
  return { key, slug: CATEGORY_SLUG, versions: versions(categoryVersion), productId: PRODUCT_ID };
}

/** A finished placement, reduced to the fields this module stores and reads back. */
function outcome(productCount: number): PlacementOutcome {
  return {
    status: 'placed',
    slug: CATEGORY_SLUG,
    reports: [],
    product_count: productCount,
    assignment: { cluster_id: 'pair-0', label: 'Pairs', size: 3, is_new: false },
  } as unknown as PlacementOutcome;
}

function claims(): PgPlacementClaims {
  return new PgPlacementClaims(database.db);
}

describe('the second event for one submission does not run', () => {
  it('gives the key to the first claimant and refuses the second', async () => {
    // The second event carries the bumped population version the FIRST placement
    // produced — `brief §1.2` moves every z-score, so the version moves with it.
    // That makes it a different run id, which is exactly why the phase store
    // cannot deduplicate it and something keyed on the SUBMISSION has to.
    const first = await claims().claim(submission('cat-v1'));
    expect(first.mine).toBe(true);
    expect(first.runId).toBe(runJobId(CATEGORY_SLUG, versions('cat-v1'), 'full_run', PRODUCT_ID));

    const second = await claims().claim(submission('cat-v2'));
    expect(second.mine).toBe(false);
    expect(second.runId).toBe(first.runId);
  });

  it('resolves a duplicate to the first placement once it has finished', async () => {
    const store = claims();
    await store.claim(submission('cat-v1'));
    await store.record(submission('cat-v1'), outcome(9));

    const duplicate = await store.claim(submission('cat-v2'));
    expect(duplicate.mine).toBe(false);
    expect(duplicate.outcome).toMatchObject({ status: 'placed', product_count: 9 });
  });

  it('lets the SAME run re-claim, because an Inngest retry is not a duplicate', async () => {
    // Same key AND same versions: attempt two of one event. It addresses the row
    // it already owns, so `brief §2.3`'s free retry still resumes rather than
    // being refused.
    const store = claims();
    const first = await store.claim(submission('cat-v1'));
    const retry = await store.claim(submission('cat-v1'));

    expect(retry.mine).toBe(true);
    expect(retry.runId).toBe(first.runId);
    expect(retry.outcome).toBeUndefined();
  });

  it('does not block a re-pitch, which is a different submission under a new cycle', async () => {
    // `brief §2.4` allows the same product to be pitched again after the next
    // rebuild, and `packages/payments` puts the cycle id IN the key for exactly
    // that. A guard keyed on the product would have blocked the one path the
    // brief explicitly permits.
    const store = claims();
    const original = await store.claim(submission('cat-v1', KEY));
    const rePitch = await store.claim({
      ...submission('cat-v2', 'd'.repeat(64)),
      productId: PRODUCT_ID + 1,
    });

    expect(original.mine).toBe(true);
    expect(rePitch.mine).toBe(true);
    expect(rePitch.runId).not.toBe(original.runId);
  });
});

describe('the guarantee is the unique index, not this code', () => {
  it('exists on jobs.idempotency_key, and only one row can hold a key', async () => {
    const indexes = await database.pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'jobs'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('jobs_idempotency_key_uk');

    await claims().claim(submission('cat-v1'));
    await claims().claim(submission('cat-v2'));
    await claims().claim(submission('cat-v3'));

    const holders = await database.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = $1`,
      [KEY],
    );
    expect(holders.rows[0]?.n).toBe(1);
  });

  it('gives the key to exactly one of three claimants, all of whom agree who won', async () => {
    // PGlite is one connection, so these are serialized rather than genuinely
    // simultaneous — the true race is guarded by the index asserted above, and
    // this asserts the other half: that all three losers name the SAME winner, so
    // each can resolve to that run's outcome rather than to one another's.
    const results = await Promise.all([
      claims().claim(submission('cat-v1')),
      claims().claim(submission('cat-v2')),
      claims().claim(submission('cat-v3')),
    ]);

    expect(results.filter((result) => result.mine)).toHaveLength(1);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
  });

  it('never marks the claim row delivered — delivery is the money event', async () => {
    // `brief §2.3`: an attempt is consumed only on delivery, in the transaction
    // that writes the verdict. A claim is taken before the first step runs and
    // must not look like one.
    await claims().claim(submission('cat-v1'));
    const row = await database.pg.query<{ status: string; delivered_at: string | null; kind: string }>(
      `SELECT status, delivered_at, kind FROM jobs WHERE idempotency_key = $1`,
      [KEY],
    );
    expect(row.rows[0]).toMatchObject({ status: 'running', delivered_at: null, kind: 'full_run' });
  });
});
