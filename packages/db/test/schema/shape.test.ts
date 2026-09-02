/**
 * The schema's surface: which tables exist, which enums exist and what they hold.
 *
 * Every expectation here is written from the requirement, not read back off the
 * generated SQL. The table list is the one the Phase 2 brief enumerates; the enum
 * members are the ones `brief` / `01` / `DECISIONS.md` fix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { columnsOf, enumLabels, migratedDatabase, tablesOf, type TestDatabase } from '../support/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

/**
 * The twenty-two tables, plus nothing. An extra table is as much a defect as a
 * missing one: it means a concept was modelled twice, or that something another
 * agent owns leaked in here.
 *
 * Sixteen were Phase 2's. `accounts` and `verdicts` are `0003`'s: the identity
 * `brief §2.1` describes without naming, and the frozen delivered verdict
 * `brief` Part 6 requires to stay addressable while the board moves under it.
 *
 * `account_identities` is `0005`'s, and it is the only table the second and
 * third sign-in paths needed. The capability URL added no table at all — it is
 * one column on `accounts`, because rotation has to REPLACE a slug rather than
 * add one, and a table of slugs would permit two live at once.
 *
 * `webhook_events` and `submissions` are `0006`'s, and each closed a gap that
 * only appeared when the Dodo webhook was actually wired up:
 *
 * - `handleDodoWebhook` records every event it is NOT going to grant on — a
 *   refund, a dispute, an amount it refuses to price — and it records them
 *   BEFORE resolving an account, because resolving one for a payment that did
 *   not succeed would be creating an account for a payment that did not succeed.
 *   `orders.account_id` is NOT NULL, so there was nowhere to put them.
 * - `pit/placement.requested` carries a `Product`, which needs a name and a
 *   300-character description. Dodo metadata is a small string map, and
 *   `products_source_submitter` refuses a paid row with no submitter — which
 *   under guest checkout is every row until the webhook arrives.
 *
 * `free_run_requests` is `0012`'s, and it is the free first throw's whole
 * defence. The offer is only survivable because a person gets exactly one, and
 * "exactly one" is a claim about state: `packages/auth`'s `MemoryRateLimiter`
 * says of itself that on Vercel "every serverless invocation may be a fresh
 * instance and the map is empty again", so a per-instance limiter on that path
 * is not a weak defence but no defence at all.
 */
const REQUIRED_TABLES = [
  'account_identities',
  'accounts',
  'attempts',
  'categories',
  'cluster_members',
  'clusters',
  'demand_votes',
  'flagged_injections',
  'free_run_requests',
  'jobs',
  'jury_versions',
  'mob_votes',
  'orders',
  'persona_versions',
  'products',
  'rankings',
  'score_rows',
  'snapshots',
  'submissions',
  'tokens',
  'verdicts',
  'webhook_events',
];

describe('tables', () => {
  it('creates exactly the twenty-two required tables', async () => {
    const tables = await tablesOf(database.pg);
    expect(tables).toEqual(REQUIRED_TABLES);
  });
});

describe('enums', () => {
  it('categories carry the b2b / consumer / prosumer archetype (brief Part 4)', async () => {
    expect(await enumLabels(database.pg, 'category_type')).toEqual(['b2b', 'consumer', 'prosumer']);
  });

  it('a forced choice can be first, second, or none', async () => {
    // `none` is the member `02 §9` omitted. Without it a persona's refusal cannot
    // be stored, and `reduceDemand` distinguishes "the Floor convened and nobody
    // wanted anything" (demand 0) from "the Floor never convened" (solo cluster,
    // merit-only per DECISIONS.md S3).
    expect(await enumLabels(database.pg, 'demand_pick')).toEqual(['first', 'second', 'none']);
  });

  it('the Mob uses the same pick vocabulary as the Floor (brief Part 4)', async () => {
    // "Same forced choice, same cluster, same schema — so synthetic demand and
    // real demand are directly comparable per cluster." One shared enum type is
    // what makes that a union rather than a translation.
    const mob = await database.pg.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'mob_votes' AND column_name = 'pick'`,
    );
    const floor = await database.pg.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'demand_votes' AND column_name = 'pick'`,
    );
    expect(mob.rows[0]?.udt_name).toBe('demand_pick');
    expect(floor.rows[0]?.udt_name).toBe('demand_pick');
  });

  it('demand_status distinguishes a scored product from a solo cluster', async () => {
    expect(await enumLabels(database.pg, 'demand_status')).toEqual(['scored', 'solo_cluster']);
  });

  it('product_status has no preview state (DECISIONS.md S13)', async () => {
    // `02 §9` sketched `('preview','pending','placed','rejected')`. S13 declares
    // `02` §2 and §10 dead: there is no preview -> place funnel, and `brief §2.6`'s
    // free preview persists nothing. A `preview` member here would mean the dead
    // design had been rebuilt.
    const labels = await enumLabels(database.pg, 'product_status');
    expect(labels).not.toContain('preview');
    expect(labels).toEqual(['pending', 'placed', 'held', 'rejected']);
  });

  it('the injection stage separates the gating input check from the output alarm', async () => {
    // `DECISIONS.md` S9 split one regex into two jobs. The input gate holds a
    // submission; the output alarm never gates delivery.
    expect(await enumLabels(database.pg, 'injection_stage')).toEqual(['input', 'output']);
  });

  it('an attempt ledger row is a grant, a consume, or a human correction', async () => {
    // `adjustment` is what makes append-only workable rather than merely
    // prohibitive: a refund or a support credit is a compensating row, never an
    // edit. Matches `AttemptEntryReason` in `@the-pit/payments`.
    expect(await enumLabels(database.pg, 'attempt_kind')).toEqual(['grant', 'consume', 'adjustment']);
  });

  it('recalibration is a job kind (brief Part 3)', async () => {
    // Part 3 adds nightly top-20 and weekly full-board rebuilds, which `02 §9`
    // predates. A rebuild that had to masquerade as a `full_run` would be
    // indistinguishable from an admin re-seed in the cost ledger.
    expect(await enumLabels(database.pg, 'job_kind')).toEqual(['preview', 'placement', 'full_run', 'recalibration']);
  });
});

describe('version columns that gate cache invalidation', () => {
  /**
   * `brief §1.3` keys the preview cache on
   * `(description_hash, category_snapshot_version, prompt_version, persona_version)`,
   * and `01 §4` Steps 2-3 bump `prompt_version` / `persona_version` on any panel
   * edit precisely so caches invalidate. Every one of them must exist and be
   * NOT NULL wherever a cached or resumable decision is made: a nullable version
   * collides two genuinely different states onto one key.
   */
  const expectations: [table: string, columns: string[]][] = [
    ['categories', ['prompt_version', 'persona_version', 'category_snapshot_version']],
    ['jobs', ['prompt_version', 'persona_version', 'category_snapshot_version', 'engine_version']],
    ['snapshots', ['prompt_version', 'persona_version', 'category_snapshot_version', 'uniqueness_version']],
    ['score_rows', ['prompt_version']],
    ['demand_votes', ['persona_version', 'uniqueness_version']],
    ['cluster_members', ['uniqueness_version']],
    ['clusters', ['uniqueness_version']],
  ];

  it.each(expectations)('%s carries %s, all NOT NULL', async (table, columns) => {
    const result = await database.pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
      [table, columns],
    );

    expect(result.rows.map((r) => r.column_name).sort()).toEqual([...columns].sort());
    for (const row of result.rows) {
      expect(`${table}.${row.column_name} nullable=${row.is_nullable}`).toBe(`${table}.${row.column_name} nullable=NO`);
    }
  });
});

describe('tokens (brief §2.1)', () => {
  it('has exactly the five specified columns and nowhere to put a raw token', async () => {
    // "Table: tokens(token_hash, email, expires_at, used_at, created_at). Store
    // SHA-256 of the token, never the raw value." A table with no column for a
    // raw token cannot leak one through a backup or a `SELECT *`.
    expect(await columnsOf(database.pg, 'tokens')).toEqual([
      'token_hash',
      'email',
      'expires_at',
      'used_at',
      'created_at',
    ]);
  });
});
