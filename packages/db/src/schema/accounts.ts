/**
 * `accounts` — the one identity everything on the money path points at.
 *
 * ## Why this is a table and not a `text` column repeated five times
 *
 * `brief §2.1` describes a real account without using the word: checkout is a
 * guest flow, the Dodo webhook hands the server an email it has already
 * verified, the server creates the account from that email, and "attempt balance
 * and history sit behind a session while verdict URLs stay public". Something
 * that has a balance, a history, a session and a login link is an account.
 *
 * Phase 2 modelled it as a lowercased `account_email` on `orders`, on `attempts`
 * and on `jobs`, on the reasoning that there is no login at submission so the
 * email IS the key. That reasoning is right about the IDENTITY and wrong about
 * the STORAGE. An email repeated across four tables is a foreign key with no
 * referent: nothing stops `attempts` holding a balance for an address `orders`
 * never saw, nothing gives the magic-link flow a row to attach a session to, and
 * an address change (which support will eventually be asked for) has to be
 * applied atomically to every table that copied it or the balance splits in two.
 *
 * So the email stays the identity — it is what Dodo verifies and what the magic
 * link targets, and it is UNIQUE here for exactly that reason — and the uuid
 * becomes the key. `attempts.account_id`, `orders.account_id` and
 * `verdicts.account_id` are real foreign keys onto this table.
 *
 * ## Lower-cased `text`, not `citext`
 *
 * `citext` would express the case-insensitivity in the type, which is tidier,
 * and it is rejected here for one practical reason: it is a contrib extension,
 * so every environment that runs these migrations — Neon, and the in-process
 * PGlite the schema tests use — has to have it installed before migration 0000,
 * and a `CREATE EXTENSION` that silently is not there yields a table where
 * `A@b.com` and `a@b.com` are two accounts. The check constraint below is
 * enforced by the same Postgres everywhere, needs nothing installed, and is the
 * convention the rest of this schema already uses (`orders_email_lowercase`,
 * `tokens_email_lowercase`, `products_email_lowercase`). Normalizing on the way
 * in is the caller's job; the database refuses to store anything else.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    /**
     * The account's identity everywhere inside the system. Opaque on purpose:
     * an id that is not the email can appear in a foreign key, a log line and an
     * admin URL without spreading the customer's address through them.
     */
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The address Dodo verified (`brief §2.1`), lowercased.
     *
     * UNIQUE is the whole point of the column. It is what makes "the returning
     * payer" a fact the database knows rather than a guess the webhook handler
     * makes: the second payment from the same address finds this row instead of
     * opening a second balance, and `POST /auth/request` has exactly one row to
     * send a link to.
     */
    email: text('email').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * The capability URL's secret half — the account is reachable at
     * `/a/<capability_slug>` with no email, no password and no session.
     *
     * ## Why this column exists
     *
     * `brief §2.1` reaches a returning customer with a magic link, and a magic
     * link is a bet on DNS: SPF, DKIM and DMARC want a fortnight at `p=none`
     * before anything tightens, plus warm-up on a new sending domain. Until then
     * "check your inbox" is a promise the infrastructure cannot keep, and it
     * fails worst for the corporate mailboxes most likely to have paid. This
     * column is the path that depends on nothing being delivered: it is minted
     * when the webhook creates the account and shown on the success page while
     * the buyer is still looking at it.
     *
     * ## One column, not a table of slugs
     *
     * A bearer URL cannot be un-shared, so rotation is the only revocation it
     * has — and rotation has to mean the old one STOPS WORKING. A single column
     * gives that for free: the `UPDATE` that writes the new slug removes the old
     * one in the same statement, so there is no window in which both resolve. A
     * `capability_slugs` table would allow two live rows per account, which is
     * precisely what rotation exists to prevent.
     *
     * ## It is stored in the clear, and that is a real trade-off
     *
     * `tokens.token_hash` stores a digest because a magic-link token only ever
     * has to be VERIFIED. This one has to be DISPLAYED — on the success page, in
     * the backup email, and again whenever a customer asks support for it — and
     * a digest cannot be displayed. So the column holds a bearer credential at
     * rest: anyone with read access to this table can reach any account.
     *
     * What that buys, and why it is accepted: the alternative is that a customer
     * who closes the tab before bookmarking has no way back except email, which
     * is the dependency this whole column exists to remove. What bounds it:
     * rotation is one request, the route sends `Referrer-Policy: no-referrer`
     * and redirects without the slug, and nothing logs it. Read access to this
     * table is also read access to `orders` and `attempts`, so it is not the
     * marginal disclosure it first looks like.
     *
     * ## The DEFAULT is a floor, not the mechanism
     *
     * Slugs are normally minted by `@the-pit/auth`'s `mintCapabilitySlug` — 32
     * bytes from the OS CSPRNG — and passed in. The default below exists so that
     * an account can never be created WITHOUT one, because an account with no
     * capability URL is a customer who cannot reach what they paid for.
     *
     * It builds 43 base64url characters out of two `gen_random_uuid()` values.
     * `gen_random_uuid()` is core Postgres since 13 and draws from
     * `pg_strong_random`, the same OS CSPRNG — deliberately not `random()`, and
     * deliberately not `gen_random_bytes()`, which lives in the `pgcrypto`
     * contrib extension that this schema refuses to depend on for the reason
     * given above about `citext`. Two uuids carry 244 bits of entropy (256 minus
     * six version and variant bits each), comfortably past the 128-bit floor.
     */
    capabilitySlug: text('capability_slug')
      .notNull()
      .default(
        sql`translate(encode(decode(replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''), 'hex'), 'base64'), '+/=', '-_')`,
      ),
  },
  (t) => [
    /** One row per address. Two would be two balances for one payer. */
    unique('accounts_email_uk').on(t.email),

    /**
     * The unique above only holds one identity if the stored form is canonical.
     * Without this, `Payer@Example.com` and `payer@example.com` are distinct
     * values, both pass the unique, and the customer who paid under one cannot
     * spend under the other.
     */
    check('accounts_email_lowercase', sql`${t.email} = lower(${t.email})`),

    /**
     * The minimum that makes a value an address at all: one `@`, something on
     * each side, no whitespace. Deliberately not an RFC 5322 grammar — the real
     * validation is that Dodo collected and verified it, and a stricter pattern
     * here would reject a genuine payer whose money we have already taken. This
     * catches the failure that actually happens, which is a column holding a
     * name, a customer id, or an empty string because a webhook field moved.
     */
    check('accounts_email_shape', sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`),

    /**
     * One account per slug. Without this, a bug in a rotation could hand two
     * customers the same URL and each would sign in as whichever row the
     * planner reached first.
     */
    unique('accounts_capability_slug_uk').on(t.capabilitySlug),

    /**
     * Exactly 43 base64url characters — 256 bits, or 244 from the SQL default.
     *
     * The length is the security property, so the database enforces it rather
     * than trusting every writer. A `text` column with no check would accept
     * `'1'`, and an account addressable at `/a/1` is an account addressable by
     * anyone who can count. The alphabet is checked too: `+`, `/` and `=` are
     * the standard-base64 characters a mis-encoded mint emits, and each of them
     * breaks or changes meaning inside a URL path.
     */
    check('accounts_capability_slug_shape', sql`${t.capabilitySlug} ~ '^[A-Za-z0-9_-]{43}$'`),
  ],
);
