/**
 * The Postgres `IdentityStore` and the webhook's `ensureAccount`, run against
 * Postgres.
 *
 * PGlite is Postgres in-process, so the SQL executed here is the SQL Neon will
 * execute, against the migrations Neon will apply.
 *
 * The two statements worth this much attention:
 *
 * 1. **`ensureAccount`** is one upsert, because `brief §2.2` requires the
 *    webhook to be idempotent and Dodo retries. A `SELECT`-then-`INSERT` is a
 *    race that two concurrent deliveries of one event both lose. The test opens
 *    two transactions at once to prove it is not one.
 * 2. **`rotateCapabilitySlug`** is one UPDATE over one column, because that is
 *    what makes the old URL stop working in the same statement that writes the
 *    new one.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AccountIdentity, AuthAccount, IdentityStore, HandoffStore } from '@the-pit/auth';
import { CAPABILITY_SLUG_PATTERN, mintCapabilitySlug } from '@the-pit/auth';

import type { Database } from '../src/client.js';
import type {
  AccountIdentityRow,
  AccountRow,
  PostgresHandoffStore,
  PostgresIdentityStore,
} from '../src/identity-store.js';
import { createPostgresIdentityStore, createPostgresWebhookAccounts } from '../src/identity-store.js';
import { readMigrations } from '../src/migrations.js';
import * as schema from '../src/schema/index.js';

/** Mutual assignability: the mirror is the interface, or this file does not compile. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const ACCOUNT_MIRRORS_AUTH: Exact<AccountRow, AuthAccount> = true;
const IDENTITY_MIRRORS_AUTH: Exact<AccountIdentityRow, AccountIdentity> = true;
const STORE_MIRRORS_AUTH: Exact<PostgresIdentityStore, IdentityStore> = true;
const HANDOFF_MIRRORS_AUTH: Exact<PostgresHandoffStore, HandoffStore> = true;

let pg: PGlite;
let db: Database;
let store: PostgresIdentityStore & PostgresHandoffStore;
let webhook: ReturnType<typeof createPostgresWebhookAccounts>;

const AT = new Date('2026-04-01T10:00:00.000Z');

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of await readMigrations()) {
    for (const statement of migration.statements) await pg.exec(statement);
  }
  db = drizzle(pg, { schema });
  store = createPostgresIdentityStore(db);
  webhook = createPostgresWebhookAccounts(db, { mintSlug: mintCapabilitySlug });
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM account_identities; DELETE FROM orders; DELETE FROM accounts;');
});

const rejection = async (body: Promise<unknown>): Promise<string> => {
  try {
    await body;
    return 'accepted';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
};

// ---------------------------------------------------------------------------

describe('ensureAccount — the only thing that creates an account', () => {
  it('creates on the first payment and reports that it did', async () => {
    const first = await webhook.ensureAccount({ email: 'payer@example.com', now: AT });
    expect(first.created).toBe(true);
    expect(first.email).toBe('payer@example.com');
    expect(first.capabilitySlug).toMatch(CAPABILITY_SLUG_PATTERN);
  });

  it('finds the same account on the second payment, and says it did not create one', async () => {
    // `xmax = 0` is what distinguishes the two branches of one upsert.
    const first = await webhook.ensureAccount({ email: 'returning@example.com', now: AT });
    const second = await webhook.ensureAccount({ email: 'returning@example.com', now: AT });

    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);

    const count = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('does NOT re-mint the slug for a returning payer', async () => {
    // Re-minting would silently invalidate the URL the customer has been using
    // since their last purchase — a rotation nobody asked for, triggered by
    // giving us more money.
    const first = await webhook.ensureAccount({ email: 'loyal@example.com', now: AT });
    const second = await webhook.ensureAccount({ email: 'loyal@example.com', now: AT });
    expect(second.capabilitySlug).toBe(first.capabilitySlug);
  });

  it('is idempotent under two concurrent deliveries of the same event', async () => {
    // THE test. Dodo retries, and a `SELECT`-then-`INSERT` would have both
    // callers find nothing, both insert, and one surface a unique violation as a
    // 500 — which tells Dodo to retry an event that actually succeeded.
    const results = await Promise.all([
      webhook.ensureAccount({ email: 'concurrent@example.com', now: AT }),
      webhook.ensureAccount({ email: 'concurrent@example.com', now: AT }),
      webhook.ensureAccount({ email: 'concurrent@example.com', now: AT }),
    ]);

    expect(new Set(results.map((r) => r.accountId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const count = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('refuses an address the accounts table will not store', async () => {
    // A webhook field moving and this column ending up with a customer id.
    const message = await rejection(webhook.ensureAccount({ email: 'cus_12345', now: AT }));
    expect(message).toMatch(/accounts_email_shape/);
  });

  it('falls back to the column default when no minter is supplied', async () => {
    const bare = createPostgresWebhookAccounts(db);
    const account = await bare.ensureAccount({ email: 'defaulted@example.com', now: AT });
    expect(account.capabilitySlug).toMatch(CAPABILITY_SLUG_PATTERN);
  });
});

describe('the capability slug, through the store', () => {
  it('resolves an account from its slug', async () => {
    const account = await webhook.ensureAccount({ email: 'bookmarked@example.com', now: AT });
    const found = await store.findAccountByCapabilitySlug(account.capabilitySlug);
    expect(found).toEqual({ accountId: account.accountId, email: 'bookmarked@example.com' });
  });

  it('resolves nothing for a slug nobody holds', async () => {
    expect(await store.findAccountByCapabilitySlug(mintCapabilitySlug())).toBeNull();
  });

  it('matches exactly — no case folding, no trimming', async () => {
    // A lookup that normalized would accept slugs the mint never produced and
    // widen the guessing space for free.
    const account = await webhook.ensureAccount({ email: 'exact@example.com', now: AT });
    const slug = account.capabilitySlug;
    expect(await store.findAccountByCapabilitySlug(slug.toUpperCase())).toBeNull();
    expect(await store.findAccountByCapabilitySlug(` ${slug} `)).toBeNull();
    expect(await store.findAccountByCapabilitySlug(slug)).not.toBeNull();
  });

  it('rotation makes the old slug resolve to nothing', async () => {
    const account = await webhook.ensureAccount({ email: 'rotating@example.com', now: AT });
    const old = account.capabilitySlug;
    const fresh = mintCapabilitySlug();

    expect(await store.rotateCapabilitySlug({ accountId: account.accountId, slug: fresh, now: AT })).toEqual({
      outcome: 'rotated',
    });

    expect(await store.findAccountByCapabilitySlug(old)).toBeNull();
    expect((await store.findAccountByCapabilitySlug(fresh))?.accountId).toBe(account.accountId);
    expect(await store.capabilitySlugFor(account.accountId)).toBe(fresh);
  });

  it('reports an unknown account rather than silently doing nothing', async () => {
    expect(
      await store.rotateCapabilitySlug({
        accountId: '00000000-0000-0000-0000-000000000000',
        slug: mintCapabilitySlug(),
        now: AT,
      }),
    ).toEqual({ outcome: 'unknown_account' });
  });

  it('lets the database refuse a rotation to a slug that is not a secret', async () => {
    const account = await webhook.ensureAccount({ email: 'weak@example.com', now: AT });
    const message = await rejection(
      store.rotateCapabilitySlug({ accountId: account.accountId, slug: '1', now: AT }),
    );
    expect(message).toMatch(/accounts_capability_slug_shape/);
  });
});

describe('the provider link, through the store', () => {
  it('records a link and finds it again by provider user id', async () => {
    const account = await webhook.ensureAccount({ email: 'linked@example.com', now: AT });
    await store.linkIdentity({
      accountId: account.accountId,
      provider: 'github',
      providerUserId: '4242',
      linkedEmail: 'linked@example.com',
      now: AT,
    });

    const found = await store.findAccountByProviderIdentity({ provider: 'github', providerUserId: '4242' });
    expect(found).toEqual({ accountId: account.accountId, email: 'linked@example.com' });
  });

  it('is idempotent, and refreshes the address on a repeat', async () => {
    // The customer changed their GitHub email. One row, new address, same
    // account — which is what keeps them reachable.
    const account = await webhook.ensureAccount({ email: 'refresh@example.com', now: AT });
    const link = {
      accountId: account.accountId,
      provider: 'github',
      providerUserId: '4242',
      now: AT,
    };
    await store.linkIdentity({ ...link, linkedEmail: 'old@example.com' });
    await store.linkIdentity({ ...link, linkedEmail: 'new@example.com' });

    expect(await store.identitiesFor(account.accountId)).toEqual([
      {
        accountId: account.accountId,
        provider: 'github',
        providerUserId: '4242',
        linkedEmail: 'new@example.com',
      },
    ]);
  });

  it('refuses to move a link to another account', async () => {
    // The takeover. The unique index is the control, and the ON CONFLICT clause
    // deliberately does not name `account_id` — so this fails rather than
    // silently transferring the link.
    const attacker = await webhook.ensureAccount({ email: 'attacker@example.com', now: AT });
    const victim = await webhook.ensureAccount({ email: 'victim@example.com', now: AT });

    await store.linkIdentity({
      accountId: attacker.accountId,
      provider: 'github',
      providerUserId: '4242',
      linkedEmail: 'attacker@example.com',
      now: AT,
    });
    await store.linkIdentity({
      accountId: victim.accountId,
      provider: 'github',
      providerUserId: '4242',
      linkedEmail: 'victim@example.com',
      now: AT,
    });

    // The link still points at the attacker's own account.
    const found = await store.findAccountByProviderIdentity({ provider: 'github', providerUserId: '4242' });
    expect(found?.accountId).toBe(attacker.accountId);
    expect(await store.identitiesFor(victim.accountId)).toEqual([]);
  });

  it('never creates an account as a side effect of linking', async () => {
    const message = await rejection(
      store.linkIdentity({
        accountId: '00000000-0000-0000-0000-000000000000',
        provider: 'github',
        providerUserId: 'ghost',
        linkedEmail: 'ghost@example.com',
        now: AT,
      }),
    );
    expect(message).toMatch(/account_identities_account_id_accounts_id_fk/);

    const count = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
    expect(count.rows[0]?.n).toBe(0);
  });
});

describe('the success-page handoff', () => {
  /** An order for an account, as the webhook would have written it. */
  async function insertOrder(accountId: string, paymentId: string, createdAt: Date): Promise<void> {
    await pg.query(
      `INSERT INTO orders (provider, provider_event_id, provider_payment_id, account_id, amount_cents,
                           currency, attempts_granted, status, raw_event, created_at)
       VALUES ('dodo', $2 || '-evt', $2, $1, 500, 'USD', 1, 'paid', '{}'::jsonb, $3)`,
      [accountId, paymentId, createdAt],
    );
  }

  it('hands over the URL for a payment inside the window', async () => {
    const account = await webhook.ensureAccount({ email: 'justpaid@example.com', now: AT });
    await insertOrder(account.accountId, 'pay_inside', AT);

    const found = await store.findCapabilityByPayment({
      provider: 'dodo',
      providerPaymentId: 'pay_inside',
      now: new Date(AT.getTime() + 5000),
      windowMs: 30 * 60 * 1000,
    });
    expect(found).toEqual({
      accountId: account.accountId,
      email: 'justpaid@example.com',
      slug: account.capabilitySlug,
    });
  });

  it('reveals nothing once the window has closed', async () => {
    // The age rule is in the query, not left to the caller — so a caller who
    // forgets cannot get the whole answer anyway.
    const account = await webhook.ensureAccount({ email: 'stale@example.com', now: AT });
    await insertOrder(account.accountId, 'pay_stale', AT);

    const found = await store.findCapabilityByPayment({
      provider: 'dodo',
      providerPaymentId: 'pay_stale',
      now: new Date(AT.getTime() + 30 * 60 * 1000 + 1),
      windowMs: 30 * 60 * 1000,
    });
    expect(found).toBeNull();
  });

  it('reveals nothing for a payment id nobody used', async () => {
    expect(
      await store.findCapabilityByPayment({
        provider: 'dodo',
        providerPaymentId: 'pay_guessed',
        now: AT,
        windowMs: 30 * 60 * 1000,
      }),
    ).toBeNull();
  });

  it('keys on the provider too', async () => {
    const account = await webhook.ensureAccount({ email: 'provider@example.com', now: AT });
    await insertOrder(account.accountId, 'pay_provider', AT);
    expect(
      await store.findCapabilityByPayment({
        provider: 'somebody_else',
        providerPaymentId: 'pay_provider',
        now: AT,
        windowMs: 30 * 60 * 1000,
      }),
    ).toBeNull();
  });

  it('follows a rotation, so the page never shows a slug that stopped working', async () => {
    const account = await webhook.ensureAccount({ email: 'rotated@example.com', now: AT });
    await insertOrder(account.accountId, 'pay_rotated', AT);
    const fresh = mintCapabilitySlug();
    await store.rotateCapabilitySlug({ accountId: account.accountId, slug: fresh, now: AT });

    const found = await store.findCapabilityByPayment({
      provider: 'dodo',
      providerPaymentId: 'pay_rotated',
      now: new Date(AT.getTime() + 1000),
      windowMs: 30 * 60 * 1000,
    });
    expect(found?.slug).toBe(fresh);
  });
});
