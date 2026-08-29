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
  ],
);
