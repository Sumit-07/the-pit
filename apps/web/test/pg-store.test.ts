/**
 * The durable `PipelineStore`, against a real Postgres.
 *
 * Two claims are load-bearing here and everything else in this file supports
 * them.
 *
 * ## 1. A phase stored under one `prompt_version` is not reused after a bump
 *
 * `01 §9` rule 5 and `brief §1.3`: a stored phase produced under a superseded
 * rubric "is a stale answer, not a saving". Reusing it would put a board's scores
 * under a rubric that never produced them, and would deliver a verdict nobody can
 * defend in the dispute `brief` Part 7 anticipates. So the bumped run must
 * RE-RUN — and the superseded phases must still be readable, because they are the
 * integrity record of what the earlier attempt actually bought.
 *
 * ## 2. A run whose steps are served by two store instances still resumes
 *
 * This is the Vercel failure the durable store exists to remove. `brief` Part 7
 * puts each phase in its own Inngest step; Vercel gives each invocation its own
 * filesystem. With `FilePipelineStore` the second step finds nothing, decides the
 * phase never ran, and re-buys it — a customer charged twice for one attempt,
 * with the retry still reported as free. It is simulated below by constructing
 * two `PgPipelineStore`s over the same database and running one attempt through
 * each, which is exactly what two lambdas are.
 *
 * Hand-derived call counts, from 8 products / 6 jurors / 1 chunk / 4 personas:
 *
 *   attempt 1, clustering fails    6 scoring + 1 clustering        = 7
 *   attempt 2, fresh store object  1 clustering + 4 forced choices = 5
 *   -----------------------------------------------------------------
 *   12 across both, against 11 + 11 = 22 if the second store saw nothing.
 *
 * Every run below goes through the REAL `runPipeline` with the REAL step runner
 * and call meter. Only the model is a fixture.
 */

import {
  FixtureClient,
  ModelCallError,
  phaseVersions,
  type PersistedPhase,
  type PhaseVersions,
  type Ranking,
  type RunResults,
} from '@the-pit/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import {
  PgPipelineStore,
  PipelineStoreNotProvisionedError,
  runJobId,
  SnapshotVersionConflictError,
} from '@/lib/pipeline/pg-store';
import { readStoredPhase, reusableStoredPhase } from '@/lib/pipeline/resume';
import { runPipeline, type PipelineResult } from '@/lib/pipeline/run';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import type { PipelineInput } from '@/lib/pipeline/types';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  PERSONA_VERSION,
  PROMPT_VERSION,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
  type ScriptOptions,
} from './helpers/panel.js';
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

/**
 * Wipe every row a run writes, so each test starts from an unrun category.
 *
 * `TRUNCATE`, not `DELETE`, because `jobs_delivery_immutable_trg` refuses to
 * delete a DELIVERED job — `brief` Part 6 makes a verdict URL permanent — and
 * `TRUNCATE` does not fire row triggers. An undelivered job does delete, since
 * `migrations/0004_jobs_delete_guard.sql`; before it, the trigger returned `NEW`
 * on a delete, `NEW` is NULL there, and Postgres read that as "skip this
 * operation" — so every delete was silently cancelled, delivered or not.
 */
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

function makeInput(options: { promptVersion?: string; personaVersion?: string; categoryVersion?: string } = {}): PipelineInput {
  return {
    category: CATEGORY,
    products: makeProducts(8),
    jury: makeJury(options.promptVersion),
    personas: makePanel(options.personaVersion),
    config: { categoryVersion: options.categoryVersion ?? CATEGORY_VERSION },
  };
}

function store(versions: PhaseVersions): PgPipelineStore {
  return new PgPipelineStore(database.db, CATEGORY, { versions });
}

/**
 * One attempt, through a store instance of its own.
 *
 * A fresh `PgPipelineStore` per attempt is the point: it holds no phase in
 * memory, so everything a later attempt reuses came back out of Postgres.
 */
async function attempt(
  input: PipelineInput,
  script: ScriptOptions = {},
): Promise<{ result?: PipelineResult; error?: unknown; meter: CallMeter; store: PgPipelineStore }> {
  const versions = phaseVersions(input);
  const attemptStore = store(versions);
  const meter = new CallMeter(new FixtureClient(makeScript(script)));
  try {
    const result = await runPipeline(
      input,
      {
        client: meter,
        store: attemptStore,
        snapshots: new MemorySnapshotSink(),
        now: () => new Date('2026-03-01T12:00:00.000Z'),
      },
      new RecordingStepRunner(),
    );
    return { result, meter, store: attemptStore };
  } catch (error) {
    return { error, meter, store: attemptStore };
  }
}

/** The envelope shape `resume.ts` classifies. Hand-built where a real run is not the subject. */
function envelope(versions: PhaseVersions, phase: 'score' | 'uniqueness' | 'customer'): PersistedPhase<unknown> {
  return {
    versions,
    result: {
      phase,
      status: 'ok',
      value: { marker: `${phase}-value` },
      cost: { calls: 6, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cost_usd: 0.01 },
    },
  } as unknown as PersistedPhase<unknown>;
}

describe('an envelope survives Postgres byte for byte', () => {
  it('reads back exactly what was written, version stamp and all', async () => {
    const versions = phaseVersions(makeInput());
    const written = envelope(versions, 'score');

    const writer = store(versions);
    await writer.writePhase('score', written);

    // A second instance, because the first one could be answering from memory.
    const read = await store(versions).readPhase('score');
    expect(read).toEqual(written);

    // And the version stamp specifically — it is the only thing `resume.ts` looks
    // at before deciding whether to spend money.
    expect((read as PersistedPhase<unknown>).versions).toEqual(versions);
  });

  it('reports a phase that was never written as absent, not as an error', async () => {
    const versions = phaseVersions(makeInput());
    expect(await store(versions).readPhase('customer')).toBeUndefined();
    expect((await readStoredPhase(store(versions), 'customer', versions)).state).toBe('absent');
  });
});

describe('a bumped prompt_version re-runs the phase — it is never reused', () => {
  it('classifies the stored phase as stale and names the version that moved', async () => {
    const before = phaseVersions(makeInput({ promptVersion: 'jury-v1' }));
    const after = phaseVersions(makeInput({ promptVersion: 'jury-v2' }));

    await store(before).writePhase('score', envelope(before, 'score'));

    const stored = await readStoredPhase(store(after), 'score', after);
    // `stale`, not `absent` and not `reusable`: the status page has to say WHY a
    // paid phase is being bought again.
    expect(stored.state).toBe('stale');
    if (stored.state === 'stale') {
      expect(stored.moved).toHaveLength(1);
      expect(stored.moved[0]).toContain('prompt_version');
      expect(stored.moved[0]).toContain('jury-v1');
      expect(stored.moved[0]).toContain('jury-v2');
    }

    // And the one call a phase step makes before deciding to spend says no.
    expect(await reusableStoredPhase(store(after), 'score', after)).toBeUndefined();

    // The superseded phase is still there. `brief` Part 7 wants the record of
    // what the earlier attempt bought; a store that overwrote it would destroy
    // the evidence while claiming to be resumable.
    expect((await readStoredPhase(store(before), 'score', before)).state).toBe('reusable');
  });

  it('makes the bumped run buy the score phase again, in full', async () => {
    const first = await attempt(makeInput({ promptVersion: 'jury-v1' }));
    expect(first.error).toBeUndefined();
    // 6 juror calls + 1 clustering call + 4 forced choices.
    expect(first.meter.total).toBe(11);

    // A re-approved jury is a new board (`brief` Part 3's season change), so it
    // arrives with a new population version — which is also what invalidates
    // `brief §1.3`'s preview cache.
    const bumpedInput = makeInput({ promptVersion: 'jury-v2', categoryVersion: 'cat-v2' });
    const bumped = await attempt(bumpedInput);
    expect(bumped.error).toBeUndefined();
    expect(bumped.meter.callsIn('score')).toBe(6);
    expect(bumped.meter.total).toBe(11);

    // A re-run under the SAME versions buys nothing, which is what makes the 11
    // above a statement about the version bump rather than about a store that
    // never resumes anything.
    const repeat = await attempt(bumpedInput);
    expect(repeat.error).toBeUndefined();
    expect(repeat.meter.total).toBe(0);
  });

  it('refuses a re-approved jury that forgot to bump the population version', async () => {
    // The schema allows exactly one board per `category_snapshot_version`
    // (`snapshots_category_version_uk`), because `brief §1.3` keys the preview
    // cache on it and two boards under one key give it two answers. A rubric bump
    // that reuses the version therefore cannot be stored — and the failure has to
    // say so, rather than surfacing as a trigger's `restrict_violation` from
    // inside the rank step.
    expect((await attempt(makeInput({ promptVersion: 'jury-v1' }))).error).toBeUndefined();

    const clash = await attempt(makeInput({ promptVersion: 'jury-v2' }));
    expect(clash.error).toBeInstanceOf(SnapshotVersionConflictError);
    expect(String((clash.error as Error).message)).toMatch(/category_snapshot_version/);
    expect(String((clash.error as Error).message)).toMatch(/Bump categories\.category_snapshot_version/);

    // And the board that was already issued is untouched.
    const board = await store(phaseVersions(makeInput({ promptVersion: 'jury-v1' }))).readRanking();
    expect(board?.prompt_version).toBe('jury-v1');
  });

  it('keeps the two runs in separate job rows so neither overwrites the other', async () => {
    const before = phaseVersions(makeInput({ promptVersion: 'jury-v1' }));
    const after = phaseVersions(makeInput({ promptVersion: 'jury-v2' }));
    expect(runJobId(CATEGORY_SLUG, before)).not.toBe(runJobId(CATEGORY_SLUG, after));

    await store(before).writePhase('score', envelope(before, 'score'));
    await store(after).writePhase('score', envelope(after, 'score'));

    const rows = await database.pg.query<{ count: string }>('SELECT count(*) AS count FROM jobs');
    expect(Number(rows.rows[0]?.count)).toBe(2);
  });

  it('applies the same rule to persona_version, category_version and engine_version', async () => {
    const base = phaseVersions(makeInput());
    await store(base).writePhase('customer', envelope(base, 'customer'));

    for (const moved of [
      phaseVersions(makeInput({ personaVersion: 'personas-v9' })),
      phaseVersions(makeInput({ categoryVersion: 'cat-v9' })),
      { ...base, engine_version: `${base.engine_version}-next` },
    ]) {
      expect(await reusableStoredPhase(store(moved), 'customer', moved)).toBeUndefined();
    }
  });
});

describe('a run served by two store instances resumes — the Vercel failure', () => {
  it('re-runs only the failed phase when the retry is a different store object', async () => {
    const input = makeInput();

    // Instance one. Clustering fails; the six juror calls are already bought.
    const first = await attempt(input, {
      uniquenessError: () => new ModelCallError('rate limited', { retryable: true, status: 429 }),
    });
    expect(first.error).toBeDefined();
    expect(first.meter.total).toBe(7);

    // Instance two: a brand-new object over the same database, holding nothing
    // from the first. This is the second lambda.
    const second = await attempt(input);
    expect(second.error).toBeUndefined();

    // 1 clustering call + 4 forced choices. Not 11: the score phase came back out
    // of Postgres. On an ephemeral filesystem this line reads 11, and the
    // customer has paid for the jury twice.
    expect(second.meter.total).toBe(5);
    expect(second.meter.callsIn('score')).toBe(0);
    expect(second.meter.callsIn('cluster')).toBe(1);
    expect(second.meter.callsIn('persona')).toBe(4);

    // And it still delivered a whole board — `brief §2.3`'s "deliver once whole".
    expect(second.result?.product_count).toBe(8);
  });

  it('lets a third instance read the finished run back with no model at all', async () => {
    const input = makeInput();
    const versions = phaseVersions(input);
    expect((await attempt(input)).error).toBeUndefined();

    const reader = store(versions);
    const results = await reader.readResults();
    const ranking = await reader.readRanking();

    expect(results?.scoreLog).toHaveLength(6);
    expect(ranking?.ranking).toHaveLength(8);
    expect(ranking?.prompt_version).toBe(PROMPT_VERSION);
    for (const phase of ['score', 'uniqueness', 'customer'] as const) {
      expect((await readStoredPhase(reader, phase, versions)).state).toBe('reusable');
    }
  });
});

describe('phases are written as they land, never batch-committed', () => {
  it('has the score phase durable before the failing clustering step returns', async () => {
    const input = makeInput();
    const versions = phaseVersions(input);

    const failed = await attempt(input, {
      uniquenessError: () => new ModelCallError('overloaded', { retryable: true, status: 529 }),
    });
    expect(failed.error).toBeDefined();

    // Read through a different instance: nothing here is in the failed attempt's
    // memory, so this is the state a retry on another machine would find.
    const reader = store(versions);
    expect((await readStoredPhase(reader, 'score', versions)).state).toBe('reusable');
    expect((await readStoredPhase(reader, 'uniqueness', versions)).state).toBe('failed');

    // And nothing downstream was written. A batch commit at the end would have
    // produced either everything or nothing; this is neither.
    expect(await reader.readResults()).toBeUndefined();
    expect(await reader.readRanking()).toBeUndefined();
  });

  it('merges two concurrent Round 1 writers instead of letting one clobber the other', async () => {
    // `01 §2`'s Round 1 runs the Score and Uniqueness phases at the same time and
    // both land in the same jsonb column. A read-modify-write in TypeScript would
    // lose whichever finished first, and the lost phase would be re-bought on the
    // next attempt — the same double charge, one layer down.
    const versions = phaseVersions(makeInput());
    const writer = store(versions);

    await Promise.all([
      writer.writePhase('score', envelope(versions, 'score')),
      writer.writePhase('uniqueness', envelope(versions, 'uniqueness')),
      writer.writePhase('customer', envelope(versions, 'customer')),
    ]);

    const reader = store(versions);
    for (const phase of ['score', 'uniqueness', 'customer'] as const) {
      expect(await reader.readPhase(phase)).toEqual(envelope(versions, phase));
    }
  });

  it('never marks the job delivered — that is the attempt ledger\'s transaction', async () => {
    // `brief §2.3`: an attempt is consumed only on delivery, "in the same
    // transaction that writes the verdict and marks it delivered". A store that
    // set `delivered_at` would unlock the decrement from the wrong place, and
    // `jobs_delivery_immutable_trg` would then freeze the row mid-run.
    expect((await attempt(makeInput())).error).toBeUndefined();
    const rows = await database.pg.query<{ delivered_at: string | null; status: string }>(
      'SELECT delivered_at, status FROM jobs',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.delivered_at).toBeNull();
    expect(rows.rows[0]?.status).toBe('running');
  });
});

describe('products keep their engine ids', () => {
  it('pins every id once, and a second run does not duplicate or renumber them', async () => {
    const input = makeInput();
    expect((await attempt(input)).error).toBeUndefined();
    expect((await attempt(input)).error).toBeUndefined();

    const rows = await database.pg.query<{ engine_id: number; name: string }>(
      'SELECT engine_id, name FROM products ORDER BY engine_id',
    );
    expect(rows.rows).toHaveLength(8);
    expect(rows.rows.map((row) => row.engine_id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rows.rows[3]?.name).toBe('Product 3');
  });

  it('leaves a paid listing alone rather than relabelling it as seeded scaffolding', async () => {
    // The submission path owns a paid row: it knows the payer, and `products`
    // freezes the scored text anyway. A store that upserted over it would erase
    // the customer's claim on their own listing.
    const category = await database.pg.query<{ id: string }>('SELECT id FROM categories LIMIT 1');
    const categoryId = category.rows[0]?.id;
    await database.pg.query(
      `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description,
                             description_hash, source, status, submitted_by_email)
       VALUES ($1, 3, 'Product 3', 'https://example.com/3', 'example.com/3',
               'A tool that helps someone do task number 3 without a spreadsheet.',
               repeat('a', 64), 'paid', 'pending', 'payer@example.com')`,
      [categoryId],
    );

    expect((await attempt(makeInput())).error).toBeUndefined();

    const rows = await database.pg.query<{ source: string; submitted_by_email: string | null }>(
      'SELECT source, submitted_by_email FROM products WHERE engine_id = 3',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.source).toBe('paid');
    expect(rows.rows[0]?.submitted_by_email).toBe('payer@example.com');
  });
});

describe('the board is stored as one snapshot per population version', () => {
  it('stores the ranking document verbatim and reads it back', async () => {
    const input = makeInput();
    const versions = phaseVersions(input);
    const ran = await attempt(input);
    expect(ran.error).toBeUndefined();

    const row = await database.pg.query<{
      category_snapshot_version: string;
      prompt_version: string;
      persona_version: string;
      uniqueness_version: string;
      product_count: number;
    }>('SELECT category_snapshot_version, prompt_version, persona_version, uniqueness_version, product_count FROM snapshots');
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.category_snapshot_version).toBe(CATEGORY_VERSION);
    expect(row.rows[0]?.prompt_version).toBe(PROMPT_VERSION);
    expect(row.rows[0]?.persona_version).toBe(PERSONA_VERSION);
    expect(row.rows[0]?.product_count).toBe(8);

    const ranking = await store(versions).readRanking();
    expect(ranking?.category).toBe(CATEGORY);
    expect(ranking?.ranking.map((product) => product.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not serve one population version\'s board for another', async () => {
    // `brief §1.2`: appending a product shifts the mean and std, so every z-score
    // moves. The newest board is a DIFFERENT board, and a store that answered
    // "the latest snapshot" would hand a run the ranks of a population it was
    // never computed over.
    const input = makeInput();
    expect((await attempt(input)).error).toBeUndefined();

    const laterPopulation = phaseVersions(makeInput({ categoryVersion: 'cat-v2' }));
    expect(await store(laterPopulation).readRanking()).toBeUndefined();
  });

  it('refuses a different board under the same population version, loudly', async () => {
    // `snapshots_body_immutable_trg`, and the reason for it: a verdict card is
    // stamped against a board at an instant (`brief` Part 5). A DIFFERENT board
    // under an unchanged `category_snapshot_version` means somebody skipped
    // `brief §1.2`'s bump, and swallowing it would leave `readRanking` serving
    // the old ranks to a run that was computed over a new population.
    const input = makeInput();
    const versions = phaseVersions(input);
    expect((await attempt(input)).error).toBeUndefined();

    const original = await store(versions).readRanking();
    const tampered = { ...(original as Ranking), category: 'Something Else' };
    await expect(store(versions).writeRanking(tampered)).rejects.toBeInstanceOf(SnapshotVersionConflictError);

    expect((await store(versions).readRanking())?.category).toBe(CATEGORY);
  });

  it('lets a retried rank step rewrite the identical board', async () => {
    // The other half of the same rule: a retry recomputes the same arithmetic
    // over the same stored rows, so an identical rewrite has to be a no-op rather
    // than an error, or `brief §2.3`'s free retry would fail on its last step.
    const input = makeInput();
    const versions = phaseVersions(input);
    expect((await attempt(input)).error).toBeUndefined();

    const original = await store(versions).readRanking();
    await expect(store(versions).writeRanking(original as Ranking)).resolves.toBeUndefined();
    expect((await store(versions).readRanking())?.ranking).toHaveLength(8);
  });
});

describe('a placement\'s phases never share a namespace with its category\'s run', () => {
  it('keeps them in separate job rows under identical versions', async () => {
    // `store.ts`'s `placementScope`: a placement's `uniqueness` envelope holds a
    // cluster ASSIGNMENT and a seed run's holds the whole ROSTER, and both carry
    // the same four stamps. If they shared a namespace the resume gate would hand
    // one to the other and be right to — nothing in the envelope says which kind
    // of run wrote it.
    const versions = phaseVersions(makeInput());
    const categoryRun = new PgPipelineStore(database.db, CATEGORY, { versions });
    const placement = new PgPipelineStore(database.db, CATEGORY, { versions, placement: 41 });

    expect(placement.runId).not.toBe(categoryRun.runId);

    await categoryRun.writePhase('uniqueness', envelope(versions, 'uniqueness'));

    // The placement sees nothing — not the seed run's roster, and not a `stale`
    // classification either, because nothing about it is stale. It simply is not
    // this run's work.
    expect(await placement.readPhase('uniqueness')).toBeUndefined();
    expect((await readStoredPhase(placement, 'uniqueness', versions)).state).toBe('absent');

    // And the placement's own phase does not leak back the other way.
    await placement.writePhase('uniqueness', envelope(versions, 'uniqueness'));
    const rows = await database.pg.query<{ count: string }>('SELECT count(*) AS count FROM jobs');
    expect(Number(rows.rows[0]?.count)).toBe(2);
  });

  it('still reports a superseded placement as stale rather than as never run', async () => {
    const before = phaseVersions(makeInput({ promptVersion: 'jury-v1' }));
    const after = phaseVersions(makeInput({ promptVersion: 'jury-v2' }));
    const scope = { placement: 41 };

    await new PgPipelineStore(database.db, CATEGORY, { versions: before, ...scope }).writePhase(
      'score',
      envelope(before, 'score'),
    );

    const bumped = new PgPipelineStore(database.db, CATEGORY, { versions: after, ...scope });
    const stored = await readStoredPhase(bumped, 'score', after);
    expect(stored.state).toBe('stale');
    expect(await reusableStoredPhase(bumped, 'score', after)).toBeUndefined();
  });
});

describe('results are the job row, not a second copy of the phases', () => {
  it('round-trips the assembled results document', async () => {
    const versions = phaseVersions(makeInput());
    const results = {
      scoreLog: [],
      uniqueness: null,
      demand: null,
      flaggedInjections: [],
      meta: { category: CATEGORY, category_version: CATEGORY_VERSION },
    } as unknown as RunResults;

    await store(versions).writeResults(results);
    expect(await store(versions).readResults()).toEqual(results);
  });

  it('is undefined before the rank step has assembled anything', async () => {
    const versions = phaseVersions(makeInput());
    await store(versions).writePhase('score', envelope(versions, 'score'));
    expect(await store(versions).readResults()).toBeUndefined();
  });
});

describe('an unprovisioned category fails loudly rather than inventing itself', () => {
  it('names the slug and says how to fix it', async () => {
    const versions = phaseVersions(makeInput());
    const orphan = new PgPipelineStore(database.db, 'A Category Nobody Installed', { versions });

    await expect(orphan.writePhase('score', envelope(versions, 'score'))).rejects.toBeInstanceOf(
      PipelineStoreNotProvisionedError,
    );
    await expect(orphan.readRanking()).rejects.toThrow(/a-category-nobody-installed/);
  });

  it('refuses a category with no slug at all', () => {
    const versions = phaseVersions(makeInput());
    expect(() => new PgPipelineStore(database.db, '   ', { versions })).toThrow(RangeError);
  });
});

/**
 * The same store against a LIVE Postgres, through the real `postgres` driver.
 *
 * Everything above runs on PGlite, which is Postgres itself — the DDL, the
 * triggers and the jsonb semantics are the real ones. What it does not exercise
 * is the driver: `postgres-js` decides how a `jsonb` parameter is bound and how a
 * `jsonb` column comes back, and a phase envelope that round-trips through PGlite
 * and comes back double-encoded through `postgres-js` would fail the version gate
 * on every read and re-buy every phase.
 *
 * Skipped without `DATABASE_URL`, per Global Constraint 5: the suite is green
 * offline. It applies the migrations itself, and it leaves behind the one
 * category and the one job row it created — `jobs_delivery_immutable_trg` is a
 * BEFORE DELETE trigger returning `NEW`, so a job row cannot be deleted at all.
 * The slug is timestamped so repeated runs do not collide.
 */
describe.skipIf(!process.env['DATABASE_URL'])('against a live database', () => {
  it('round-trips a version-stamped envelope through the postgres driver', async () => {
    const { createDatabase, readMigrations } = await import('@the-pit/db');
    const { sql } = await import('drizzle-orm');

    const handle = createDatabase();
    try {
      for (const migration of await readMigrations()) {
        for (const statement of migration.statements) {
          await handle.db.execute(sql.raw(statement));
        }
      }

      const liveSlug = `pit-live-${Date.now()}`;
      const liveName = `Pit Live ${Date.now()}`;
      await handle.db.execute(
        sql`insert into categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
            values (${liveSlug}, ${liveName}, 'consumer', ${PROMPT_VERSION}, ${PERSONA_VERSION}, ${CATEGORY_VERSION})`,
      );

      const versions = phaseVersions(makeInput());
      const written = envelope(versions, 'score');
      await new PgPipelineStore(handle.db, liveName, { versions }).writePhase('score', written);

      // A second instance — the second lambda — reads it back byte for byte.
      const read = await new PgPipelineStore(handle.db, liveName, { versions }).readPhase('score');
      expect(read).toEqual(written);
      expect(await reusableStoredPhase(new PgPipelineStore(handle.db, liveName, { versions }), 'score', versions)).toBeDefined();

      // And a bumped rubric still refuses it.
      const bumped = { ...versions, prompt_version: 'jury-v2' };
      expect(
        await reusableStoredPhase(new PgPipelineStore(handle.db, liveName, { versions: bumped }), 'score', bumped),
      ).toBeUndefined();
    } finally {
      await handle.close();
    }
  }, 120_000);
});
