/**
 * `@the-pit/auth`'s `AuthStore`, against these tables.
 *
 * Three methods, two of them one statement each. It lives here rather than in
 * `apps/web` because every one of them is a claim about a table's shape and its
 * constraints — `tokens(token_hash, email, expires_at, used_at, created_at)` and
 * `accounts(id, email UNIQUE, created_at)` — and a claim about a table belongs
 * next to the table, where the schema tests can execute it.
 *
 * ## `consumeToken` is one statement, and that is a correctness requirement
 *
 * `brief §2.1` makes a magic link SINGLE USE. The only implementation that
 * delivers that is:
 *
 * ```sql
 * UPDATE tokens SET used_at = $now
 *  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $now
 * RETURNING email
 * ```
 *
 * Every condition inside the WHERE clause of the write. A `SELECT` to check
 * validity followed by an `UPDATE` to spend it is a race with a window between
 * the two statements: two requests carrying the same token both read a null
 * `used_at`, both pass, and both get a session. That window is not theoretical
 * here. Magic links arrive by email, and mail clients and security scanners
 * prefetch and re-fetch the URLs in them — which is the same pressure that made
 * `GET /auth/verify` render a button instead of consuming, and it applies to the
 * POST too the moment a user double-clicks it.
 *
 * `schema/auth.ts` already describes exactly this statement, and the whole
 * design of the table depends on it: single use is enforced by the SHAPE of the
 * consuming statement rather than by a constraint, because `used_at IS NULL` is
 * a condition on the row's previous value and no CHECK can see one.
 *
 * The row count is the answer. One row updated means the link was valid and is
 * now spent; zero means expired, already used, or never existed — and the caller
 * cannot tell which apart, which is the non-enumeration posture `§2.1` requires
 * of `POST /auth/request` carried to the redemption side.
 *
 * ## `now` is passed in, not taken from the database
 *
 * The statement uses the caller's timestamp rather than `now()` so the 15-minute
 * expiry is testable at the boundary — `verifyMagicLink` in `@the-pit/auth`
 * refuses a token "at fifteen minutes exactly", and a clock the test cannot move
 * makes that assertion impossible to write without sleeping. It also removes a
 * silent dependency on the database server's clock agreeing with the app's,
 * which on Neon it need not.
 *
 * ## There is no `createAccount`, deliberately
 *
 * `brief §2.1` creates an account in exactly one place: the signed Dodo webhook,
 * from the email the provider verified. An auth path that could create one would
 * turn the magic link into self-serve signup and let anyone mint an account for
 * an address they do not control. `findAccountByEmail` returns `null` and the
 * caller renders the same "check your inbox" it renders for everyone.
 *
 * ## The types are mirrored, not imported
 *
 * Same reason as `identity.ts`: `apps/web` depends on `@the-pit/db`, and this
 * package should not put `@the-pit/auth` into its published type surface.
 * `test/auth-store.test.ts` asserts mutual assignability against the real
 * `AuthStore`, so a change over there fails this package's typecheck.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { accounts, tokens } from './schema/index.js';

/** Mirrors `AuthAccount` in `@the-pit/auth`. */
export interface AuthAccountRow {
  readonly accountId: string;
  readonly email: string;
}

/** Mirrors `NewMagicToken` in `@the-pit/auth`. */
export interface NewMagicTokenRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** Mirrors `ConsumeTokenResult` in `@the-pit/auth`. */
export type ConsumeTokenOutcome =
  | { readonly outcome: 'consumed'; readonly email: string }
  | { readonly outcome: 'rejected' };

/** Mirrors `AuthStore` in `@the-pit/auth`. */
export interface PostgresAuthStore {
  findAccountByEmail(email: string): Promise<AuthAccountRow | null>;
  createToken(token: NewMagicTokenRow): Promise<void>;
  consumeToken(input: { readonly tokenHash: string; readonly now: Date }): Promise<ConsumeTokenOutcome>;
}

/**
 * How long an unspent token stays worth keeping after it expires.
 *
 * `tokens` has no other bound on its size: every well-formed `POST /auth/request`
 * writes a row, including requests for addresses with no account — that is
 * `@the-pit/auth`'s enumeration defence, which keeps the database work identical
 * on both paths — so the table grows with traffic and never shrinks on its own.
 *
 * A day rather than fifteen minutes because a spent or expired row is still
 * evidence for a support question ("I clicked it and it said no") for about that
 * long, and because `sweepExpiredTokens` is cheap enough to run daily.
 */
export const TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

export function createPostgresAuthStore(db: Database): PostgresAuthStore {
  return {
    async findAccountByEmail(email: string): Promise<AuthAccountRow | null> {
      // `accounts_email_uk` makes this at most one row, and `accounts_email_lowercase`
      // means the caller's `normalizeEmail` output compares directly — no
      // `lower()` on the column, which would not use the unique index.
      const rows = await db
        .select({ accountId: accounts.id, email: accounts.email })
        .from(accounts)
        .where(eq(accounts.email, email))
        .limit(1);

      return rows[0] ?? null;
    },

    async createToken(token: NewMagicTokenRow): Promise<void> {
      // No `onConflictDoNothing`. `token_hash` is the primary key and a
      // collision on a 32-byte random value means the generator is broken, not
      // that a retry happened; swallowing it would hand the second requester a
      // link that redeems to the first requester's address.
      await db.insert(tokens).values({
        tokenHash: token.tokenHash,
        email: token.email,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
        usedAt: null,
      });
    },

    async consumeToken(input: { tokenHash: string; now: Date }): Promise<ConsumeTokenOutcome> {
      // THE statement. One write, every condition in its WHERE clause, the row
      // it returns as the only evidence anything happened. See the header.
      const spent = await db
        .update(tokens)
        .set({ usedAt: input.now })
        .where(
          and(eq(tokens.tokenHash, input.tokenHash), isNull(tokens.usedAt), gt(tokens.expiresAt, input.now)),
        )
        .returning({ email: tokens.email });

      const row = spent[0];
      return row === undefined ? { outcome: 'rejected' } : { outcome: 'consumed', email: row.email };
    },
  };
}

/**
 * Delete tokens that expired more than `TOKEN_RETENTION_MS` ago.
 *
 * Keyed on `expires_at`, which `tokens_expires_at_idx` covers, so the scan is
 * over exactly the rows being removed rather than the whole table.
 *
 * Spent-but-unexpired rows are deliberately left alone: they are inside the
 * 15-minute window, and deleting one would let the same token be inserted again
 * by a colliding request rather than losing to the primary key.
 *
 * Returns how many rows went, so a scheduled job can log something falsifiable.
 */
export async function sweepExpiredTokens(
  db: Database,
  options: { now?: Date; retentionMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const retention = options.retentionMs ?? TOKEN_RETENTION_MS;
  const cutoff = new Date(now.getTime() - retention);

  const deleted = await db.delete(tokens).where(sql`${tokens.expiresAt} < ${cutoff}`).returning({
    tokenHash: tokens.tokenHash,
  });
  return deleted.length;
}

/**
 * How many links were requested for one address inside `windowMs`.
 *
 * `brief §2.1` asks for a rate limit per email and per IP. `@the-pit/auth`'s
 * `MemoryRateLimiter` is correct in one long-lived process and per-instance on
 * Vercel, where each invocation may be a cold start with an empty map — weaker
 * than the brief asks. This is the shared-state half of the fix that lives in
 * this package: `tokens` already records one row per request, `tokens_email_idx`
 * is `(email, created_at)`, so the count is an index-only range scan on the
 * leading column.
 *
 * The limiter itself is NOT built here — it belongs to whoever owns the auth
 * routes, and swapping `MemoryRateLimiter` for a durable one is their decision
 * between this query and Upstash. This is the query, tested, so the choice does
 * not also require designing an index under time pressure.
 */
export async function tokenRequestsInWindow(
  db: Database,
  input: { email: string; now: Date; windowMs: number },
): Promise<number> {
  const since = new Date(input.now.getTime() - input.windowMs);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tokens)
    .where(and(eq(tokens.email, input.email), gt(tokens.createdAt, since)));

  return Number(rows[0]?.count ?? 0);
}
