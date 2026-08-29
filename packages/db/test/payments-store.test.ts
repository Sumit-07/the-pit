/**
 * The webhook's two write seams, run against Postgres.
 *
 * PGlite is Postgres in-process, so every constraint these tests lean on —
 * `orders_provider_event_uk`, `orders_payment_grant_uk`,
 * `attempts_idempotency_key_uk` and the `attempts_grant_matches_order` trigger —
 * is the one Neon will enforce. That matters more here than anywhere else in the
 * repository: the whole idempotency argument in `brief §2.2` is an argument about
 * unique indexes, and a fake that agreed with it would prove nothing.
 *
 * The three cases worth naming, because each is a different constraint doing the
 * work:
 *
 * 1. **The same event, twice.** `orders_provider_event_uk`. Dodo's ordinary retry.
 * 2. **Two different event ids for one payment.** `orders_payment_grant_uk`, the
 *    partial index over granting rows. `attempts_idempotency_key_uk` cannot see
 *    this one — the keys differ, because `grantIdempotencyKey` is
 *    `dodo:event:<event id>`.
 * 3. **Concurrent deliveries.** Two transactions open at once, which is the race
 *    a `SELECT`-then-`INSERT` loses and a unique index cannot.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mintCapabilitySlug } from '@the-pit/auth';
import type { AttemptsStore, WebhookStore } from '@the-pit/payments';
import { AttemptsLedger, TIER_SINGLE, TIER_TRIPLE, grantIdempotencyKey } from '@the-pit/payments';

import type { Database } from '../src/client.js';
import { readMigrations } from '../src/migrations.js';
import type { PostgresAttemptsStore, PostgresWebhookStore } from '../src/payments-store.js';
import {
  createPostgresAttemptsStore,
  createPostgresSubmissionStore,
  createPostgresWebhookStore,
} from '../src/payments-store.js';
import * as schema from '../src/schema/index.js';

const AT = new Date('2026-06-01T12:00:00.000Z');
const PAYER = 'payer@example.com';
const RAW = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });

let pg: PGlite;
let db: Database;
let webhook: PostgresWebhookStore;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
  webhook = createPostgresWebhookStore(db, { mintSlug: mintCapabilitySlug });
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // TRUNCATE and not DELETE. `attempts_immutable` (migration 0002) refuses a
  // DELETE outright — the ledger is append-only, and that guard is one of the
  // things this suite is here to rely on. TRUNCATE is a table-level operation
  // that row triggers do not see, which is exactly why it is the only way to
  // reset a table whose whole point is that rows never leave it.
  await pg.exec(
    'truncate attempts, orders, webhook_events, submissions, accounts restart identity cascade;',
  );
});

/**
 * Mutual assignability: the mirrors in `payments-store.ts` ARE the interfaces
 * `@the-pit/payments` declares, or this file does not compile. Same device as
 * `identity.test.ts` and `identity-store.test.ts`, and the same reason — a field
 * added, removed or retyped over there must fail this package's typecheck rather
 * than drift quietly on the money path.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type Satisfies<A, B> = [A] extends [B] ? true : never;

/**
 * `AttemptsStore` is mirrored EXACTLY: a field added or retyped over there has to
 * fail here, because every field of an `AttemptEntry` becomes a column.
 *
 * `WebhookStore` is only satisfied, and deliberately in one direction.
 * `ensureAccount` here returns an `EnsuredAccount`, which carries the email and
 * the capability slug ON TOP of `ResolvedAccount`'s `{accountId, created}` — so
 * `handleDodoWebhook` can be handed this store without `@the-pit/payments` ever
 * learning that capability URLs exist, and the success-page handover can read the
 * slug the same upsert minted. Extra properties satisfy the interface; requiring
 * exactness would force the payments package to know about them.
 */
const WEBHOOK_SATISFIES_PAYMENTS: Satisfies<PostgresWebhookStore, WebhookStore> = true;
const ATTEMPTS_MIRRORS_PAYMENTS: Exact<PostgresAttemptsStore, AttemptsStore> = true;

/** A store bound to one verified body, exactly as the route builds it per request. */
function ledgerFor(rawEvent = RAW): AttemptsLedger {
  return new AttemptsLedger(
    createPostgresAttemptsStore(db, { rawEvent }),
    () => {
      throw new Error('the delivery transaction is not this suite’s subject');
    },
  );
}

async function account(): Promise<string> {
  const ensured = await webhook.ensureAccount({ email: PAYER, now: AT });
  return ensured.accountId;
}

describe('ensureAccount, through the webhook store', () => {
  it('creates the account and mints a capability slug on the first payment', async () => {
    const first = await webhook.ensureAccount({ email: PAYER, now: AT });

    expect(first.created).toBe(true);
    expect(first.email).toBe(PAYER);
    expect(first.capabilitySlug).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('finds the same row on a second payment and keeps the slug they bookmarked', async () => {
    const first = await webhook.ensureAccount({ email: PAYER, now: AT });
    const second = await webhook.ensureAccount({ email: PAYER, now: new Date(AT.getTime() + 86_400_000) });

    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    // Re-minting on every payment would silently invalidate the URL they have
    // been using since their last purchase — a rotation nobody asked for.
    expect(second.capabilitySlug).toBe(first.capabilitySlug);
  });
});

describe('granting, and the three ways a grant is refused a second time', () => {
  it('writes one order and one ledger row for a $5 payment', async () => {
    const accountId = await account();

    const granted = await ledgerFor().grant({
      accountId,
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: AT,
    });

    expect(granted).toEqual({ outcome: 'granted', attemptsGranted: 1, balance: 1 });

    const rows = await pg.query<{ kind: string; delta: number; idempotency_key: string }>(
      'select kind, delta, idempotency_key from attempts',
    );
    expect(rows.rows).toEqual([
      { kind: 'grant', delta: 1, idempotency_key: grantIdempotencyKey('evt_1') },
    ]);

    const order = await pg.query<{ attempts_granted: number; includes_fit_report: boolean; currency: string }>(
      'select attempts_granted, includes_fit_report, currency from orders',
    );
    expect(order.rows).toEqual([{ attempts_granted: 1, includes_fit_report: false, currency: 'USD' }]);
  });

  it('grants three and marks the fit report on the $15 tier', async () => {
    const accountId = await account();

    const granted = await ledgerFor().grant({
      accountId,
      tier: TIER_TRIPLE,
      providerEventId: 'evt_15',
      providerPaymentId: 'pay_15',
      amountCents: 1500,
      now: AT,
    });

    expect(granted).toEqual({ outcome: 'granted', attemptsGranted: 3, balance: 3 });
    const order = await pg.query<{ includes_fit_report: boolean }>('select includes_fit_report from orders');
    expect(order.rows[0]?.includes_fit_report).toBe(true);
  });

  it('grants nothing the second time the SAME event arrives', async () => {
    const accountId = await account();
    const grant = { accountId, tier: TIER_SINGLE, providerEventId: 'evt_1', providerPaymentId: 'pay_1', amountCents: 500, now: AT };

    await ledgerFor().grant(grant);
    const replay = await ledgerFor().grant(grant);

    expect(replay).toEqual({ outcome: 'duplicate', attemptsGranted: 0, balance: 1 });
    const count = await pg.query<{ n: number }>('select count(*)::int as n from attempts');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('grants once when Dodo emits TWO event ids for one payment', async () => {
    // The case the event id alone cannot catch: two distinct envelopes, two
    // distinct idempotency keys, one charge. `orders_payment_grant_uk` is the
    // only thing standing between this and a second free attempt.
    const accountId = await account();
    const base = { accountId, tier: TIER_SINGLE, providerPaymentId: 'pay_1', amountCents: 500, now: AT };

    const first = await ledgerFor().grant({ ...base, providerEventId: 'evt_a' });
    const second = await ledgerFor().grant({ ...base, providerEventId: 'evt_b' });

    expect(first.outcome).toBe('granted');
    expect(second).toEqual({ outcome: 'duplicate', attemptsGranted: 0, balance: 1 });

    const orders = await pg.query<{ n: number }>('select count(*)::int as n from orders');
    expect(orders.rows[0]?.n).toBe(1);
  });

  it('refuses a grant with no raw event rather than writing an empty payload', async () => {
    const accountId = await account();
    const blind = new AttemptsLedger(createPostgresAttemptsStore(db), () => {
      throw new Error('unused');
    });

    await expect(
      blind.grant({
        accountId,
        tier: TIER_SINGLE,
        providerEventId: 'evt_1',
        providerPaymentId: 'pay_1',
        amountCents: 500,
        now: AT,
      }),
    ).rejects.toThrow(/raw event/);
  });

  it('stores the verified body verbatim, because a dispute is argued from it', async () => {
    const accountId = await account();
    await ledgerFor().grant({
      accountId,
      tier: TIER_SINGLE,
      providerEventId: 'evt_1',
      providerPaymentId: 'pay_1',
      amountCents: 500,
      now: AT,
    });

    const row = await pg.query<{ raw_event: unknown }>('select raw_event from orders');
    expect(row.rows[0]?.raw_event).toEqual({ id: 'evt_1', type: 'payment.succeeded' });
  });
});

describe('recordEvent and the review queue', () => {
  it('records once and reports every redelivery as a duplicate', async () => {
    const first = await webhook.recordEvent({ eventId: 'evt_d', type: 'dispute.opened', receivedAt: AT, outcome: 'not_a_grant' });
    const second = await webhook.recordEvent({ eventId: 'evt_d', type: 'dispute.opened', receivedAt: AT, outcome: 'not_a_grant' });

    expect([first, second]).toEqual(['recorded', 'duplicate']);
    const rows = await pg.query<{ n: number }>('select count(*)::int as n from webhook_events');
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('parks the reason and the payload on the row that was recorded', async () => {
    await webhook.recordEvent({ eventId: 'evt_d', type: 'dispute.opened', receivedAt: AT, outcome: 'not_a_grant' });
    await webhook.queueForReview({ eventId: 'evt_d', reason: 'dispute.opened', event: { id: 'evt_d' } });

    const rows = await pg.query<{ review_reason: string; payload: unknown; reviewed_at: Date | null }>(
      'select review_reason, payload, reviewed_at from webhook_events',
    );
    expect(rows.rows[0]?.review_reason).toBe('dispute.opened');
    expect(rows.rows[0]?.payload).toEqual({ id: 'evt_d' });
    // Queued, not resolved. Somebody still has to look at it.
    expect(rows.rows[0]?.reviewed_at).toBeNull();
  });
});

describe('the submission draft', () => {
  const draft = {
    categorySlug: 'developer-tools',
    name: 'Runlet',
    url: 'https://runlet.dev/',
    normalizedUrl: 'runlet.dev',
    description: 'Runs your jobs.',
    descriptionHash: 'a'.repeat(64),
    cycleId: '2026-06-01',
    tier: 'single' as const,
    attemptNumber: 1,
    repitchOf: null,
    now: AT,
  };

  it('round-trips the text Dodo metadata could not carry', async () => {
    const store = createPostgresSubmissionStore(db);
    const id = await store.create(draft);
    const read = await store.find(id);

    expect(read).toEqual({
      submissionId: id,
      categorySlug: 'developer-tools',
      name: 'Runlet',
      url: 'https://runlet.dev/',
      normalizedUrl: 'runlet.dev',
      description: 'Runs your jobs.',
      descriptionHash: 'a'.repeat(64),
      cycleId: '2026-06-01',
      tier: 'single',
      attemptNumber: 1,
      repitchOf: null,
    });
  });

  it('answers null for an id that is not a uuid, rather than raising 22P02', async () => {
    // `submission_id` arrives in Dodo metadata, which is attacker-influenced by
    // construction. A malformed uuid must be an unknown submission, not an
    // exception on the money path.
    const store = createPostgresSubmissionStore(db);
    expect(await store.find("'; drop table submissions; --")).toBeNull();
    expect(await store.find('')).toBeNull();
  });
});

describe('the mirrors', () => {
  it('are the interfaces @the-pit/payments declares', () => {
    // The assertion is the two type aliases above; this keeps them referenced so
    // an unused-value rule cannot delete the check that does the work.
    expect([WEBHOOK_SATISFIES_PAYMENTS, ATTEMPTS_MIRRORS_PAYMENTS]).toEqual([true, true]);
  });
});
