/**
 * `@the-pit/auth`'s `IdentityStore`, plus the webhook's account provisioning,
 * against these tables.
 *
 * It lives here for the same reason `auth-store.ts` does: every statement below
 * is a claim about a table's shape and its constraints —
 * `accounts(id, email UNIQUE, capability_slug UNIQUE, created_at)` and
 * `account_identities(account_id, provider, provider_user_id, linked_email)` —
 * and a claim about a table belongs next to the table, where the schema tests
 * can execute it against a real Postgres.
 *
 * ## `ensureAccount` is one statement, and that is an idempotency requirement
 *
 * `brief §2.2`: "Webhook handler must be **idempotent** — Dodo retries." The
 * handler resolves the account before it appends the grant, so a retry must find
 * the same account rather than race a second insert:
 *
 * ```sql
 * INSERT INTO accounts (email, capability_slug) VALUES ($1, $2)
 * ON CONFLICT (email) DO UPDATE SET email = excluded.email
 * RETURNING id, email, capability_slug, (xmax = 0) AS created
 * ```
 *
 * A `SELECT` followed by an `INSERT` is a race: two concurrent deliveries of the
 * same webhook both find nothing, both insert, and one gets a unique violation
 * that surfaces as a 500 — which tells Dodo to retry an event that actually
 * succeeded. The upsert cannot lose that race.
 *
 * `DO UPDATE SET email = excluded.email` is a deliberate no-op write. `DO
 * NOTHING` would return no row at all on conflict, leaving the handler with
 * nothing to grant against and forcing a second round trip; assigning the column
 * its own value makes the conflicting row a RETURNING row.
 *
 * **`xmax = 0` is how we know whether we created it.** On an upsert, a freshly
 * inserted tuple has `xmax` of zero, while one that was updated by the conflict
 * clause carries the updating transaction's id. It is the only way to get
 * insert-or-update out of a single statement, and `WebhookStore.ensureAccount`
 * needs it: `accountCreated` is what tells the webhook to send the backup email
 * and — more importantly — it is how a first purchase is distinguished from a
 * returning payer without a second query that could disagree with the first.
 *
 * Note that the slug parameter is only USED on the insert branch. A returning
 * payer keeps the slug they already bookmarked; re-minting one on every payment
 * would silently invalidate the URL they have been using since their last
 * purchase, which is a rotation nobody asked for.
 *
 * ## Rotation is one UPDATE, and the old value is gone inside it
 *
 * See `schema/accounts.ts`. There is no window in which both slugs resolve
 * because there is only one column, and the row count is the answer to "did that
 * account exist".
 *
 * ## The types are mirrored, not imported
 *
 * Same reason as `auth-store.ts` and `identity.ts`: `apps/web` depends on
 * `@the-pit/db`, and this package should not put `@the-pit/auth` into its
 * published type surface. `test/identity-store.test.ts` asserts mutual
 * assignability against the real `IdentityStore`, so a change over there fails
 * this package's typecheck.
 */

import { and, eq, gt, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { accountIdentities, accounts, orders } from './schema/index.js';

/** Mirrors `AuthAccount` in `@the-pit/auth`. */
export interface AccountRow {
  readonly accountId: string;
  readonly email: string;
}

/** Mirrors `AccountIdentity` in `@the-pit/auth`. */
export interface AccountIdentityRow {
  readonly accountId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly linkedEmail: string;
}

/** Mirrors `RotateSlugResult` in `@the-pit/auth`. */
export type RotateSlugOutcome = { readonly outcome: 'rotated' } | { readonly outcome: 'unknown_account' };

/** Mirrors `IdentityStore` in `@the-pit/auth`. */
export interface PostgresIdentityStore {
  findAccountByCapabilitySlug(slug: string): Promise<AccountRow | null>;
  capabilitySlugFor(accountId: string): Promise<string | null>;
  rotateCapabilitySlug(input: {
    readonly accountId: string;
    readonly slug: string;
    readonly now: Date;
  }): Promise<RotateSlugOutcome>;
  findAccountByProviderIdentity(input: {
    readonly provider: string;
    readonly providerUserId: string;
  }): Promise<AccountRow | null>;
  linkIdentity(input: AccountIdentityRow & { readonly now: Date }): Promise<void>;
  identitiesFor(accountId: string): Promise<readonly AccountIdentityRow[]>;
}

/** Mirrors `HandoffStore` in `@the-pit/auth`. */
export interface PostgresHandoffStore {
  findCapabilityByPayment(input: {
    readonly provider: string;
    readonly providerPaymentId: string;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<{ readonly accountId: string; readonly email: string; readonly slug: string } | null>;
}

/**
 * What the Dodo webhook gets back. Structurally a `ResolvedAccount` from
 * `@the-pit/payments`' `WebhookStore`, with the slug and address added — extra
 * properties satisfy that interface, so this can be handed straight to
 * `handleDodoWebhook` without `packages/payments` knowing capability URLs exist.
 */
export interface EnsuredAccount {
  readonly accountId: string;
  readonly created: boolean;
  readonly email: string;
  readonly capabilitySlug: string;
}

export function createPostgresIdentityStore(db: Database): PostgresIdentityStore & PostgresHandoffStore {
  return {
    async findAccountByCapabilitySlug(slug: string): Promise<AccountRow | null> {
      // Exact match. No `lower()`, no trim, no prefix — `accounts_capability_slug_uk`
      // answers this from the index, and a lookup that normalized would accept
      // slugs the mint never produced and widen the guessing space for free.
      const rows = await db
        .select({ accountId: accounts.id, email: accounts.email })
        .from(accounts)
        .where(eq(accounts.capabilitySlug, slug))
        .limit(1);
      return rows[0] ?? null;
    },

    async capabilitySlugFor(accountId: string): Promise<string | null> {
      const rows = await db
        .select({ slug: accounts.capabilitySlug })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      return rows[0]?.slug ?? null;
    },

    async rotateCapabilitySlug(input: {
      accountId: string;
      slug: string;
      now: Date;
    }): Promise<RotateSlugOutcome> {
      // One column, overwritten. The old slug stops resolving in this statement,
      // which is the whole revocation story — see `schema/accounts.ts`.
      const rotated = await db
        .update(accounts)
        .set({ capabilitySlug: input.slug })
        .where(eq(accounts.id, input.accountId))
        .returning({ id: accounts.id });

      return rotated.length === 0 ? { outcome: 'unknown_account' } : { outcome: 'rotated' };
    },

    async findAccountByProviderIdentity(input: {
      provider: string;
      providerUserId: string;
    }): Promise<AccountRow | null> {
      const rows = await db
        .select({ accountId: accounts.id, email: accounts.email })
        .from(accountIdentities)
        .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
        .where(
          and(
            eq(accountIdentities.provider, input.provider),
            eq(accountIdentities.providerUserId, input.providerUserId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async linkIdentity(input: AccountIdentityRow & { now: Date }): Promise<void> {
      // `DO UPDATE` touches `linked_email` and `updated_at` and NOTHING ELSE.
      // Moving `account_id` here would let anyone who signed in once have their
      // link transferred to a customer's account by adding and verifying the
      // customer's address on GitHub. See the header of `schema/identities.ts`.
      await db
        .insert(accountIdentities)
        .values({
          accountId: input.accountId,
          provider: input.provider,
          providerUserId: input.providerUserId,
          linkedEmail: input.linkedEmail,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [accountIdentities.provider, accountIdentities.providerUserId],
          set: { linkedEmail: input.linkedEmail, updatedAt: input.now },
        });
    },

    async identitiesFor(accountId: string): Promise<readonly AccountIdentityRow[]> {
      return await db
        .select({
          accountId: accountIdentities.accountId,
          provider: accountIdentities.provider,
          providerUserId: accountIdentities.providerUserId,
          linkedEmail: accountIdentities.linkedEmail,
        })
        .from(accountIdentities)
        .where(eq(accountIdentities.accountId, accountId))
        .orderBy(accountIdentities.createdAt);
    },

    async findCapabilityByPayment(input: {
      provider: string;
      providerPaymentId: string;
      now: Date;
      windowMs: number;
    }): Promise<{ accountId: string; email: string; slug: string } | null> {
      // The age rule is IN the query, not left to the caller. An implementation
      // that returned the row and left the comparison to TypeScript would hand
      // the whole answer to any caller who forgot — and the one that forgets is
      // the one written in a hurry against a support ticket.
      //
      // `orders_payment_idx` is `(provider, provider_payment_id)`, so this is an
      // index lookup rather than a scan.
      const cutoff = new Date(input.now.getTime() - input.windowMs);
      const rows = await db
        .select({ accountId: accounts.id, email: accounts.email, slug: accounts.capabilitySlug })
        .from(orders)
        .innerJoin(accounts, eq(accounts.id, orders.accountId))
        .where(
          and(
            eq(orders.provider, input.provider),
            eq(orders.providerPaymentId, input.providerPaymentId),
            gt(orders.createdAt, cutoff),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/**
 * Find or create the account for an email Dodo verified, and guarantee it has a
 * capability slug.
 *
 * This is `WebhookStore.ensureAccount` from `@the-pit/payments`, implemented.
 * It is the ONLY function in this repository that inserts into `accounts`, which
 * is what makes "an account is a purchase" true rather than aspirational — the
 * auth paths have no method that could, by construction.
 *
 * `mintSlug` is injected so `@the-pit/db` does not depend on `@the-pit/auth` at
 * runtime; `apps/web` passes `mintCapabilitySlug`. The default falls back to the
 * column's own DEFAULT by passing `undefined`, which is a working floor rather
 * than the intended path — see the migration's note on why both exist.
 */
export function createPostgresWebhookAccounts(
  db: Database,
  options: { readonly mintSlug?: () => string } = {},
): { ensureAccount(input: { email: string; now: Date }): Promise<EnsuredAccount> } {
  return {
    async ensureAccount(input: { email: string; now: Date }): Promise<EnsuredAccount> {
      const slug = options.mintSlug?.();

      // One statement. See the header for why `xmax = 0` and why the update is
      // a deliberate no-op write.
      const result: unknown = await db.execute(
        slug === undefined
          ? sql`INSERT INTO accounts (email, created_at) VALUES (${input.email}, ${input.now})
                ON CONFLICT (email) DO UPDATE SET email = excluded.email
                RETURNING id, email, capability_slug, (xmax = 0) AS created`
          : sql`INSERT INTO accounts (email, capability_slug, created_at) VALUES (${input.email}, ${slug}, ${input.now})
                ON CONFLICT (email) DO UPDATE SET email = excluded.email
                RETURNING id, email, capability_slug, (xmax = 0) AS created`,
      );

      const row = rowsOf<UpsertedAccountRow>(result)[0];
      if (row === undefined) {
        throw new Error(`ensureAccount returned no row for ${input.email}; the upsert cannot miss both branches.`);
      }
      return {
        accountId: row.id,
        email: row.email,
        capabilitySlug: row.capability_slug,
        created: row.created === true,
      };
    },
  };
}

/** The four columns the `ensureAccount` upsert returns, as Postgres names them. */
interface UpsertedAccountRow {
  readonly id: string;
  readonly email: string;
  readonly capability_slug: string;
  /** `xmax = 0` — true when this statement inserted the row rather than found it. */
  readonly created: boolean;
}

/**
 * `db.execute` returns an array under postgres-js and a `{ rows }` object under
 * some other drivers. Normalized here so the caller reads one shape.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
