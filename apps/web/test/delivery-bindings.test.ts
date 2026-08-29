/**
 * What each environment binds for the end of the money path — and the two
 * bindings that were missing entirely.
 *
 * `lib/verdict/service.ts` bound a memory store built from `cjr/` in EVERY
 * environment, so a verdict written by a paid delivery could never be read back:
 * `/v/<slug>` 404'd forever for the one person who paid for it. And nothing
 * anywhere in `apps/web/src` called `revalidatePath` or `revalidateTag`, so the
 * rendered board pages — `revalidate = 86400` on all three — stayed up to a day
 * behind a placement that had already republished the board JSON.
 *
 * Both are wiring, and wiring fails silently. So each is asserted twice: that the
 * right thing is bound when the environment has it, and that nothing is silently
 * bound when it does not.
 *
 * No connection is opened. `postgres()` is lazy — it connects on the first query
 * — so a syntactically valid URL pointing nowhere proves the wiring resolves, and
 * no test here issues a query.
 */

import { TIER_SINGLE } from '@the-pit/payments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boardPaths, nextBoardInvalidator } from '@/lib/delivery/revalidate';
import {
  deliveryBindings,
  registerDeliveryBindings,
  resetDeliveryBindings,
} from '@/lib/delivery/config';
import { MemoryVerdictStore } from '@/lib/verdict/store';

/** Valid enough for `requireDatabaseUrl`; nothing listens on it and nothing tries. */
const NOWHERE = 'postgresql://user:pw@127.0.0.1:1/thepit';

const revalidated: string[] = [];

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

let savedDatabaseUrl: string | undefined;

beforeEach(() => {
  savedDatabaseUrl = process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL'];
  revalidated.length = 0;
  resetDeliveryBindings();
});

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = savedDatabaseUrl;
  resetDeliveryBindings();
});

describe('the rendered board pages are invalidated (Fix 3)', () => {
  it('calls revalidatePath for every path that reads the board', async () => {
    // The assertion that would have caught the whole bug: before this, there was
    // no `revalidatePath` call anywhere in `apps/web/src`.
    await nextBoardInvalidator().invalidateBoard('developer-tools');

    expect(revalidated).toEqual(['/', '/boards', '/boards/developer-tools']);
    expect(revalidated).toEqual([...boardPaths('developer-tools')]);
  });

  it('invalidates the home page and the index, not only the category page', async () => {
    // `/boards` lists every board with its product count and `/` leads with a
    // rail over the same JSON, so invalidating only `/boards/<slug>` would leave
    // two surfaces contradicting the one that moved.
    await nextBoardInvalidator().invalidateBoard('health-fitness-wellness');
    expect(revalidated).toContain('/');
    expect(revalidated).toContain('/boards');
  });
});

describe('the delivery bindings', () => {
  it('are null with no database, so a settle reports rather than crashes', () => {
    // A real state: `next build` traces server modules with no connection string,
    // and a local run against `cjr/` has no `jobs` table to mark delivered.
    expect(deliveryBindings()).toBeNull();
  });

  it('resolve over the database when one is configured', () => {
    process.env['DATABASE_URL'] = NOWHERE;
    const bindings = deliveryBindings();

    expect(bindings).not.toBeNull();
    expect(Object.keys(bindings ?? {}).sort()).toEqual(['findListing', 'ledgerFor']);
  });

  it('let an explicit registration win, so a test needs no environment', () => {
    const stub = {
      findListing: () => Promise.resolve(null),
      ledgerFor: () => {
        throw new Error('not used');
      },
    };
    registerDeliveryBindings(stub as unknown as NonNullable<ReturnType<typeof deliveryBindings>>);
    expect(deliveryBindings()).toBe(stub);
  });

  it('refuse to GRANT an attempt, whatever else they can do', async () => {
    // The mirror of `lib/payments/config.ts`, which builds a ledger that may
    // grant and may never consume. `brief §2.2` puts attempt creation on a signed
    // webhook and nowhere else, so a grant reaching the delivery path fails
    // loudly rather than being written.
    process.env['DATABASE_URL'] = NOWHERE;
    const bindings = deliveryBindings();
    const ledger = bindings?.ledgerFor({
      accountId: '99999999-8888-4777-8666-555555555555',
      publicSlug: 'a'.repeat(32),
      productCount: 9,
    });

    await expect(
      ledger?.grant({
        accountId: '99999999-8888-4777-8666-555555555555',
        tier: TIER_SINGLE,
        providerEventId: 'evt_1',
        providerPaymentId: 'pay_1',
        amountCents: 500,
        now: new Date(),
      }),
    ).rejects.toThrow(/never grant/);
  });
});

describe('the verdict store binding', () => {
  it('reads the table when a database is configured', async () => {
    process.env['DATABASE_URL'] = NOWHERE;
    const { resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');
    resetVerdictStore();

    const store = await verdictStore();
    // A Postgres-backed store is not the seeded memory one. The distinction is
    // the whole fix: the seeded store holds `brief` Part 7's cold-start rows and
    // is blind to every verdict a paying customer was ever issued.
    expect(store).not.toBeInstanceOf(MemoryVerdictStore);
    expect(Object.keys(store)).toEqual(['bySlug']);
    resetVerdictStore();
  });

  it('falls back to the seeded rows only when there is no database', async () => {
    const { resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');
    resetVerdictStore();

    const store = await verdictStore();
    expect(store).toBeInstanceOf(MemoryVerdictStore);
    resetVerdictStore();
  });

  it('exposes one method and no way to enumerate an account’s verdicts', async () => {
    // `brief §2.1` splits the surfaces: verdict URLs are public, balance and
    // history sit behind a session. A store that could list by account would be
    // reachable from the one route in the product that has no session at all.
    process.env['DATABASE_URL'] = NOWHERE;
    const { resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');
    resetVerdictStore();

    const store = await verdictStore();
    expect(Object.keys(store)).toEqual(['bySlug']);
    expect('byAccount' in store).toBe(false);
    expect('list' in store).toBe(false);
    resetVerdictStore();
  });
});
