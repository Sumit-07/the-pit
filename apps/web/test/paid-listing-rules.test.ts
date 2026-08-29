/**
 * The four rules a paid listing turns back on — and the one of them that is not
 * a missing feature but a violation of the product's core promise.
 *
 * ## The slot machine
 *
 * `brief §2.4` caps submissions at **one pitch per product per recalibration
 * cycle**, and forbids keep-the-best in the same breath. Those two clauses are
 * one rule: if a founder can pay $5 repeatedly for the same product inside one
 * cycle, then re-rolling until they like the result and stopping IS
 * keep-the-best, whatever the code says about not comparing verdicts. Dodo's
 * terms prohibit "chance-based reward mechanics", so this is not only a product
 * rule.
 *
 * Every one of these rules hangs off ONE fact: `ListingSnapshot.lastPitchedAt` is
 * non-null, and `createPostgresListingStore` computes it as
 * `seeded ? null : greatest(created_at, latest verdict)`. While
 * `PgPipelineStore.writeProducts` wrote every row as `source = 'seeded'` with a
 * null submitter, that fact was unreachable and every rule below was dead code
 * that could not be made to fire from any input.
 *
 * So these tests are written against the REAL listing store over the REAL schema,
 * driven by the same two writes the placement path makes — the paid `products`
 * row and the delivered `verdicts` row — and each one is paired with the seeded
 * control that must still pass. A test that only asserted the rejection would
 * pass against an implementation that rejected everybody, including a founder
 * claiming their own unclaimed cold-start listing, which `brief` Part 7 wants to
 * be a first pitch.
 *
 * ## Hand-derived clock
 *
 * The nightly rebuild is 02:00 UTC (`brief §2.4`'s worked example). The cycle
 * containing 2026-03-01T12:00Z opened at 2026-03-01T02:00Z and closes at
 * 2026-03-02T02:00Z. A re-pitch attempted at 16:00 therefore has 10h 0m left to
 * wait, which is the countdown these tests assert on.
 */

import { createPostgresListingStore, verdictSlug, deterministicUuid } from '@the-pit/db';
import { NIGHTLY_REBUILD, ordinalPitch } from '@the-pit/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nextRebuildFor, runSubmissionGuards, type SubmissionGuardDeps } from '@/lib/checkout/guards';
import { pitchLabel } from '@/lib/verdict/model';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  PERSONA_VERSION,
  PROMPT_VERSION,
} from './helpers/panel.js';
import { installCategory, migratedDatabase, type TestDatabase } from './helpers/pg.js';

let database: TestDatabase;
let categoryId: string;

/** Noon inside the cycle that opened at 02:00 UTC on the same day. */
const NOW = new Date('2026-03-01T12:00:00.000Z');
/** Inside the same cycle, four hours after the pitch landed. */
const LATER_SAME_CYCLE = new Date('2026-03-01T16:00:00.000Z');
/** After the rebuild: a new cycle, and the cap is spent. */
const AFTER_REBUILD = new Date('2026-03-02T09:00:00.000Z');

const URL = 'https://example.com/margin';
const NORMALIZED = 'example.com/margin';
const FIRST_PITCH = 'Turns raw meeting notes into a shared action list nobody has to type.';
const REWRITTEN =
  'A meeting recorder that produces a decision log with owners and dates, priced per seat for teams.';
const PAYER_EMAIL = 'payer@example.com';

beforeAll(async () => {
  database = await migratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec(
    'TRUNCATE categories, jobs, products, snapshots, rankings, accounts, orders, attempts, verdicts CASCADE;',
  );
  categoryId = await installCategory(database.pg, {
    slug: CATEGORY_SLUG,
    name: CATEGORY,
    promptVersion: PROMPT_VERSION,
    personaVersion: PERSONA_VERSION,
    categoryVersion: CATEGORY_VERSION,
  });
});

async function account(email: string): Promise<string> {
  const rows = await database.pg.query<{ id: string }>(
    `INSERT INTO accounts (email, capability_slug) VALUES ($1, $2) RETURNING id`,
    [email, email.padEnd(43, 'z').slice(0, 43).replace(/[^A-Za-z0-9_-]/g, 'x')],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('no account');
  return id;
}

/**
 * The row the placement path writes for a paying customer.
 *
 * `source = 'paid'` with the payer's address, exactly what
 * `PgPipelineStore.writeProducts` now writes and what
 * `products_source_submitter` requires. `created_at` is the instant the pitch
 * landed, which is what `lastPitchedAt` falls back to before a verdict exists.
 */
async function paidListing(createdAt: Date, description = FIRST_PITCH): Promise<string> {
  const rows = await database.pg.query<{ id: string }>(
    `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description,
                           description_hash, source, status, submitted_by_email, created_at, updated_at)
     VALUES ($1, 1, 'Margin', $2, $3, $4, $5, 'paid', 'pending', $6, $7, $7)
     RETURNING id`,
    [categoryId, URL, NORMALIZED, description, 'a'.repeat(64), PAYER_EMAIL, createdAt.toISOString()],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('no product');
  return id;
}

/** The cold-start row `brief` Part 7 marks "unclaimed": no submitter, no pitch. */
async function seededListing(createdAt: Date, description = FIRST_PITCH): Promise<string> {
  const rows = await database.pg.query<{ id: string }>(
    `INSERT INTO products (category_id, engine_id, name, url, normalized_url, description,
                           description_hash, source, status, submitted_by_email, created_at,
                           updated_at, placed_at)
     VALUES ($1, 2, 'Margin', $2, $3, $4, $5, 'seeded', 'placed', NULL, $6, $6, $6)
     RETURNING id`,
    [categoryId, URL, NORMALIZED, description, 'b'.repeat(64), createdAt.toISOString()],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('no product');
  return id;
}

/** The verdict the delivery transaction writes, with its pitch ordinal. */
async function deliveredVerdict(input: {
  productId: string;
  accountId: string | null;
  attemptNumber: number | null;
  deliveredAt: Date;
}): Promise<string> {
  const jobId = deterministicUuid('job', 'paid-listing-suite', String(input.attemptNumber ?? 0));
  await database.pg.query(
    `INSERT INTO jobs (id, kind, status, category_id, prompt_version, persona_version,
                       category_snapshot_version, engine_version, delivered_at)
     VALUES ($1, 'full_run', 'succeeded', $2, $3, $4, $5, 'engine-test', $6)`,
    [jobId, categoryId, PROMPT_VERSION, PERSONA_VERSION, CATEGORY_VERSION, input.deliveredAt.toISOString()],
  );
  const verdictId = deterministicUuid('verdict', 'paid-listing-suite', jobId);
  await database.pg.query(
    `INSERT INTO verdicts (id, public_slug, product_id, job_id, account_id, attempt_number,
                           payload, product_count, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{"a":1}'::jsonb, 9, $7)`,
    [
      verdictId,
      verdictSlug(verdictId),
      input.productId,
      jobId,
      input.accountId,
      input.attemptNumber,
      input.deliveredAt.toISOString(),
    ],
  );
  return verdictId;
}

function guards(): SubmissionGuardDeps {
  return {
    listings: createPostgresListingStore(database.db),
    candidateCategories: () => Promise.resolve([CATEGORY]),
    schedule: NIGHTLY_REBUILD,
  };
}

async function submit(input: {
  now: Date;
  description: string;
  accountId?: string | null;
}): Promise<Awaited<ReturnType<typeof runSubmissionGuards>>> {
  return runSubmissionGuards(
    {
      draft: { url: URL, name: 'Margin', description: input.description, categorySlug: CATEGORY },
      now: input.now,
      accountId: input.accountId ?? null,
    },
    guards(),
  );
}

describe('brief §2.4: one pitch per product per recalibration cycle — the slot-machine guard', () => {
  it('rejects a second $5 for the same product inside one cycle, with the countdown', async () => {
    // The pitch that was paid for. This is the ONLY thing that changed: before
    // the placement path wrote `source = 'paid'`, this row was `seeded` with a
    // null submitter, `lastPitchedAt` came back null, and the whole `if` this cap
    // lives inside was skipped.
    await paidListing(NOW);

    const second = await submit({ now: LATER_SAME_CYCLE, description: REWRITTEN });

    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') throw new Error('unreachable');
    expect(second.rejection.code).toBe('cycle_locked');

    // `brief §2.4` asks for a countdown to the next rebuild rather than an
    // arbitrary limit. 16:00 to the 02:00 boundary is 10h.
    const countdown = nextRebuildFor(second.rejection, LATER_SAME_CYCLE);
    expect(countdown?.at.toISOString()).toBe('2026-03-02T02:00:00.000Z');
    expect(countdown?.humanized).toBe('10h 0m');
    expect(second.rejection.message).toContain('02:00 UTC');
    expect(second.rejection.message).toContain('10h 0m');
  });

  it('is not fooled by a rewrite: even a genuinely different pitch is capped', async () => {
    // The cap is not the material-change rule. A founder who rewrites the
    // description completely still gets one pitch per cycle — otherwise
    // "re-roll until you like it" is one paraphrase away.
    await paidListing(NOW);
    const rejected = await submit({ now: LATER_SAME_CYCLE, description: REWRITTEN });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('unreachable');
    expect(rejected.rejection.code).toBe('cycle_locked');
  });

  it('counts the cycle off the verdict, not only off the row', async () => {
    // A listing created last week and re-pitched at noon today is capped for the
    // rest of today's cycle: `lastPitchedAt` is `greatest(created_at, latest
    // verdict)`, which is what makes the cap survive `planRepitch`'s
    // replace-in-place reading of S8.
    const accountId = await account(PAYER_EMAIL);
    const productId = await paidListing(new Date('2026-02-20T09:00:00.000Z'));
    await deliveredVerdict({ productId, accountId, attemptNumber: 1, deliveredAt: NOW });

    const rejected = await submit({ now: LATER_SAME_CYCLE, description: REWRITTEN });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('unreachable');
    expect(rejected.rejection.code).toBe('cycle_locked');
  });

  it('lets the same product be pitched again after the rebuild', async () => {
    // The other half of the rule, and the reason it is a countdown: the founder
    // is told when, and when arrives.
    await paidListing(NOW);
    const accepted = await submit({ now: AFTER_REBUILD, description: REWRITTEN });
    expect(accepted.status).toBe('accepted');
  });

  it('does not cap a founder claiming their own unclaimed cold-start listing', async () => {
    // The discriminating control. `brief` Part 7 seeds boards with listings
    // "marked clearly as unclaimed", and claiming one is a FIRST pitch. Using the
    // seed date would cycle-lock a product nobody has ever pitched.
    await seededListing(NOW);
    const accepted = await submit({ now: LATER_SAME_CYCLE, description: REWRITTEN });
    expect(accepted.status).toBe('accepted');
    if (accepted.status !== 'accepted') throw new Error('unreachable');
    expect(accepted.clearance.flags).toContain('claims_seeded_listing');
    expect(accepted.clearance.attemptNumber).toBe(1);
  });
});

describe('brief §2.4: a re-pitch needs materially changed description text', () => {
  it('rejects an unchanged description on a new cycle', async () => {
    await paidListing(NOW);
    const rejected = await submit({ now: AFTER_REBUILD, description: FIRST_PITCH });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('unreachable');
    expect(rejected.rejection.code).toBe('description_unchanged');
    expect(rejected.rejection.message).toContain('same pitch');
  });

  it('rejects a one-word edit, which is what an identity check would let through', async () => {
    await paidListing(NOW);
    const rejected = await submit({
      now: AFTER_REBUILD,
      // One word swapped: two tokens move, and `MATERIAL_CHANGE_MIN_TOKEN_DELTA`
      // is 3. An identity check on the hash would call this a different pitch.
      description: FIRST_PITCH.replace('shared', 'common'),
    });

    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('unreachable');
    expect(rejected.rejection.code).toBe('description_unchanged');
  });

  it('accepts a genuine rewrite', async () => {
    await paidListing(NOW);
    expect((await submit({ now: AFTER_REBUILD, description: REWRITTEN })).status).toBe('accepted');
  });

  it('does not compare a first pitch against text somebody else wrote', async () => {
    // The control again: an unclaimed row's description was written by outbid's
    // source data (`DECISIONS.md` S4), and rejecting a founder for being too
    // close to it would reject them for describing their own product.
    await seededListing(NOW);
    expect((await submit({ now: AFTER_REBUILD, description: FIRST_PITCH })).status).toBe('accepted');
  });
});

describe('brief §2.5: the ownership rule, which joins through submitted_by_email', () => {
  it('holds a submission for a product already listed under another account', async () => {
    // `accountId` on the snapshot is resolved by joining `accounts.email` to
    // `products.submitted_by_email`. With every row written as a null submitter
    // that join produced null forever and this rule could not fire from any
    // input.
    await account(PAYER_EMAIL);
    const stranger = await account('stranger@example.com');
    await paidListing(NOW);

    const held = await submit({
      now: AFTER_REBUILD,
      description: REWRITTEN,
      accountId: stranger,
    });

    expect(held.status).toBe('rejected');
    if (held.status !== 'rejected') throw new Error('unreachable');
    expect(held.rejection.code).toBe('ownership_conflict');
    // `brief §2.5`: flag for review, do not hard-block. The wording has to say
    // that a person will look, because a false rejection on a paying customer is
    // worse than an extra run.
    expect(held.rejection.message).toContain('held your submission for review');
  });

  it('lets the owner re-pitch their own listing', async () => {
    const owner = await account(PAYER_EMAIL);
    await paidListing(NOW);

    const accepted = await submit({ now: AFTER_REBUILD, description: REWRITTEN, accountId: owner });
    expect(accepted.status).toBe('accepted');
  });

  it('lets anybody claim an unclaimed listing, because nobody owns it', async () => {
    const stranger = await account('stranger@example.com');
    await seededListing(NOW);

    const accepted = await submit({ now: AFTER_REBUILD, description: REWRITTEN, accountId: stranger });
    expect(accepted.status).toBe('accepted');
  });
});

describe('brief §2.4: the attempt count, shown publicly', () => {
  it('makes a genuine second pitch the 2nd pitch', async () => {
    const accountId = await account(PAYER_EMAIL);
    const productId = await paidListing(NOW);
    await deliveredVerdict({ productId, accountId, attemptNumber: 1, deliveredAt: NOW });

    const clearance = await submit({ now: AFTER_REBUILD, description: REWRITTEN, accountId });
    expect(clearance.status).toBe('accepted');
    if (clearance.status !== 'accepted') throw new Error('unreachable');

    // 1 delivered pitch, so the next one is the 2nd — and it renders as such on
    // the public card. `pitchLabel` is `apps/web`'s restatement of `ordinalPitch`
    // and the two are asserted together so they cannot drift.
    expect(clearance.clearance.attemptNumber).toBe(2);
    expect(pitchLabel(clearance.clearance.attemptNumber)).toBe('2nd pitch');
    expect(ordinalPitch(clearance.clearance.attemptNumber)).toBe('2nd pitch');
  });

  it('counts pitches and not runs — a free retry does not advance it', async () => {
    // `attempt_number` lives on `verdicts`, which is written once per DELIVERY.
    // A run retried three times for free delivers once, so the ordinal moves once.
    const accountId = await account(PAYER_EMAIL);
    const productId = await paidListing(NOW);
    await deliveredVerdict({ productId, accountId, attemptNumber: 1, deliveredAt: NOW });

    const listing = await createPostgresListingStore(database.db).findByNormalizedUrl(NORMALIZED);
    expect(listing?.attemptNumber).toBe(1);
    expect(listing?.currentVerdictId).not.toBeNull();
  });

  it('leaves an unclaimed listing with no ordinal at all', async () => {
    // `verdicts.attempt_number` is NULL on a seeded verdict — storing 1 would
    // print "1st pitch" under a listing whose owner has never been here, and
    // would take the ordinal their real first pitch is entitled to.
    const productId = await seededListing(NOW);
    await deliveredVerdict({ productId, accountId: null, attemptNumber: null, deliveredAt: NOW });

    const listing = await createPostgresListingStore(database.db).findByNormalizedUrl(NORMALIZED);
    expect(listing?.attemptNumber).toBe(0);
    expect(listing?.lastPitchedAt).toBeNull();
  });
});

describe('what the listing store reports, paid versus seeded', () => {
  it('reports a paid row as pitched and owned', async () => {
    const accountId = await account(PAYER_EMAIL);
    await paidListing(NOW);

    const listing = await createPostgresListingStore(database.db).findByNormalizedUrl(NORMALIZED);
    expect(listing?.accountId).toBe(accountId);
    expect(listing?.lastPitchedAt?.toISOString()).toBe(NOW.toISOString());
    // One paid pitch has happened even though no verdict is delivered yet.
    expect(listing?.attemptNumber).toBe(1);
  });

  it('reports a seeded row as unpitched and unowned', async () => {
    await account(PAYER_EMAIL);
    await seededListing(NOW);

    const listing = await createPostgresListingStore(database.db).findByNormalizedUrl(NORMALIZED);
    expect(listing?.accountId).toBeNull();
    expect(listing?.lastPitchedAt).toBeNull();
    expect(listing?.attemptNumber).toBe(0);
  });
});
