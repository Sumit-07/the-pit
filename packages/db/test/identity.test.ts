/**
 * The seam between `@the-pit/payments`' vocabulary and this schema's.
 *
 * Two things are checked, and the first one is checked by the COMPILER rather
 * than at runtime:
 *
 * 1. `src/identity.ts` re-declares `AttemptEntry` and `VerdictWrite` locally so
 *    that `@the-pit/db` — which `apps/web` depends on — does not drag the
 *    payments package into its public type surface. A re-declaration is a copy,
 *    and a copy drifts. The `Exact` assertions below fail this package's
 *    typecheck the moment a field is added, removed or retyped on either side,
 *    which is the only thing that makes the copy safe to have.
 *
 * 2. The mapping itself. `runId` must land in `job_id` and `listingId` in
 *    `product_id` — the two the packages actually disagreed about, and the two a
 *    silent swap would leave a consume pointing at the wrong listing while every
 *    foreign key still resolved.
 *
 * No database: these are pure functions producing row objects.
 */

import type { AttemptEntry, DeliveryTx, VerdictWrite, WithDeliveryTx } from '@the-pit/payments';
import { describe, expect, it } from 'vitest';

import type { LedgerEntry, DeliveredVerdict } from '../src/identity.js';
import { attemptRow, PAYMENTS_IDENTITY_MAPPING, verdictRow, verdictSlug } from '../src/identity.js';
import type { PostgresDeliveryTx, WithPostgresDeliveryTx } from '../src/delivery-store.js';

/**
 * Mutual assignability. `A extends B ? B extends A ? true : never : never` is
 * `never` — a compile error at the annotation below — unless the two types are
 * structurally identical.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const ENTRY_MIRRORS_PAYMENTS: Exact<LedgerEntry, AttemptEntry> = true;
const VERDICT_MIRRORS_PAYMENTS: Exact<DeliveredVerdict, VerdictWrite> = true;

/**
 * The third mirror, and the one that carries the money.
 *
 * `createPostgresDeliveryStore` is what `AttemptsLedger.deliver` runs inside —
 * `brief §2.3`'s "same transaction that writes the verdict and marks it
 * delivered" — and `src/delivery-store.ts` re-declares its interface locally for
 * the same reason the two above are re-declared. A method added or a signature
 * changed over in `@the-pit/payments` has to fail this package's typecheck: the
 * alternative is a `DeliveryTx` that compiles, satisfies the interface it thinks
 * it implements, and silently stops being handed to the ledger.
 */
const DELIVERY_TX_MIRRORS_PAYMENTS: Exact<PostgresDeliveryTx, DeliveryTx> = true;
const WITH_DELIVERY_TX_MIRRORS_PAYMENTS: Exact<WithPostgresDeliveryTx, WithDeliveryTx> = true;

const AT = new Date('2026-03-01T12:00:00.000Z');

/** Ids that are visibly different from one another, so a swap cannot pass. */
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const LISTING = '33333333-3333-4333-8333-333333333333';
const VERDICT = '44444444-4444-4444-8444-444444444444';
const ORDER = '55555555-5555-4555-8555-555555555555';

describe('the type mirror', () => {
  it('is structurally identical to what @the-pit/payments produces', () => {
    // The assertion is the two `const` declarations above; this asserts they were
    // evaluated rather than tree-shaken out of the compilation.
    expect([
      ENTRY_MIRRORS_PAYMENTS,
      VERDICT_MIRRORS_PAYMENTS,
      DELIVERY_TX_MIRRORS_PAYMENTS,
      WITH_DELIVERY_TX_MIRRORS_PAYMENTS,
    ]).toEqual([true, true, true, true]);
  });

  it('records the mapping the two packages disagreed about', () => {
    expect(PAYMENTS_IDENTITY_MAPPING).toEqual({
      accountId: 'accounts.id',
      runId: 'jobs.id',
      listingId: 'products.id',
      verdictId: 'verdicts.id',
    });
  });
});

describe('attemptRow', () => {
  it('puts the run in job_id and the listing in product_id', () => {
    const entry: AttemptEntry = {
      accountId: ACCOUNT,
      delta: -1,
      reason: { kind: 'consume', runId: RUN, verdictId: VERDICT, listingId: LISTING },
      idempotencyKey: `delivery:run:${RUN}`,
      createdAt: AT,
    };

    expect(attemptRow(entry)).toEqual({
      accountId: ACCOUNT,
      kind: 'consume',
      delta: -1,
      idempotencyKey: `delivery:run:${RUN}`,
      jobId: RUN,
      productId: LISTING,
      createdAt: AT,
    });
  });

  it('names the order a grant was written against', () => {
    // `AttemptEntryReason`'s grant arm carries provider ids, not the `orders` row
    // uuid, so the caller that just inserted the order supplies it. Without it,
    // `attempts_grant_has_order` would reject the insert at the database.
    const entry: AttemptEntry = {
      accountId: ACCOUNT,
      delta: 1,
      reason: {
        kind: 'grant',
        providerEventId: 'evt_1',
        providerPaymentId: 'pay_1',
        tier: 'single',
        amountCents: 500,
      },
      idempotencyKey: 'dodo:event:evt_1',
      createdAt: AT,
    };

    expect(attemptRow(entry, { orderId: ORDER })).toEqual({
      accountId: ACCOUNT,
      kind: 'grant',
      delta: 1,
      idempotencyKey: 'dodo:event:evt_1',
      orderId: ORDER,
      createdAt: AT,
    });
  });

  it('refuses a grant with no order rather than writing a row the database will reject', () => {
    const entry: AttemptEntry = {
      accountId: ACCOUNT,
      delta: 1,
      reason: {
        kind: 'grant',
        providerEventId: 'evt_2',
        providerPaymentId: 'pay_2',
        tier: 'single',
        amountCents: 500,
      },
      idempotencyKey: 'dodo:event:evt_2',
      createdAt: AT,
    };

    expect(() => attemptRow(entry)).toThrow(/attempts_grant_has_order/);
  });

  it('carries an adjustment’s person through', () => {
    // Free text is acceptable on this arm and on no other, and the database says
    // the same thing with `attempts_adjustment_has_reason`.
    const entry: AttemptEntry = {
      accountId: ACCOUNT,
      delta: 1,
      reason: { kind: 'adjustment', note: 'support credit after a provider outage', actor: 'ops@thepit.show' },
      idempotencyKey: 'adjust:1',
      createdAt: AT,
    };

    expect(attemptRow(entry)).toEqual({
      accountId: ACCOUNT,
      kind: 'adjustment',
      delta: 1,
      idempotencyKey: 'adjust:1',
      note: 'support credit after a provider outage',
      actor: 'ops@thepit.show',
      createdAt: AT,
    });
  });

  it('refuses an order on a consume, which would make it a grant in the database', () => {
    const entry: AttemptEntry = {
      accountId: ACCOUNT,
      delta: -1,
      reason: { kind: 'consume', runId: RUN, verdictId: VERDICT, listingId: LISTING },
      idempotencyKey: `delivery:run:${RUN}`,
      createdAt: AT,
    };

    expect(() => attemptRow(entry, { orderId: ORDER })).toThrow(/attempts_consume_has_job/);
  });
});

describe('verdictRow', () => {
  it('maps all four identities and stamps the board', () => {
    const write: VerdictWrite = {
      verdictId: VERDICT,
      listingId: LISTING,
      runId: RUN,
      accountId: ACCOUNT,
      attemptNumber: 3,
      payload: { rank: 4 },
      createdAt: AT,
    };

    expect(verdictRow(write, { publicSlug: 'thirdpitchslug', productCount: 48 })).toEqual({
      id: VERDICT,
      publicSlug: 'thirdpitchslug',
      productId: LISTING,
      jobId: RUN,
      accountId: ACCOUNT,
      attemptNumber: 3,
      payload: { rank: 4 },
      productCount: 48,
      deliveredAt: AT,
    });
  });
});

describe('verdictSlug', () => {
  it('is stable, and is not the id', () => {
    expect(verdictSlug(VERDICT)).toBe(verdictSlug(VERDICT));
    expect(verdictSlug(VERDICT)).not.toBe(VERDICT);
  });

  it('satisfies verdicts_public_slug_shape', () => {
    // 32 lowercase hex characters: inside the 12-128 length window, and matching
    // `^[a-z0-9]+(-[a-z0-9]+)*$`. Asserted here so a change to the derivation
    // fails without needing a database to notice.
    const slug = verdictSlug(RUN);
    expect(slug).toHaveLength(32);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('gives two verdicts two URLs', () => {
    expect(verdictSlug(VERDICT)).not.toBe(verdictSlug(RUN));
  });
});
