/**
 * `tokens` — magic links, and nothing else.
 *
 * `brief §2.1` specifies this table field for field: "Table:
 * `tokens(token_hash, email, expires_at, used_at, created_at)`. Store **SHA-256
 * of the token**, never the raw value. 15-minute expiry, single use."
 *
 * The columns are exactly those five and there is deliberately no sixth. In
 * particular there is no `token`, no `secret` and no `value`: a table with
 * nowhere to put a raw token cannot leak one in a backup, a log line or a
 * `SELECT *`, and `test/schema/tokens.test.ts` asserts the column list to keep it
 * that way. `token_hash` is the primary key — it is unique by construction, and
 * a surrogate id would be a second handle on a row that is already addressed by
 * the only value the verifier has.
 *
 * Single use is enforced by the shape of the consuming statement rather than by a
 * constraint, and the shape only works because `used_at` starts null:
 *
 * ```sql
 * UPDATE tokens SET used_at = now()
 *  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
 * ```
 *
 * One row updated means the link was valid and is now spent; zero means expired,
 * already used, or never existed — and the caller cannot tell which apart, which
 * is the same non-enumeration posture `§2.1` requires of `POST /auth/request`
 * ("always respond 'check your inbox' regardless of whether the email exists").
 *
 * Two things `§2.1` requires that are NOT here, because they are not storage:
 * the `GET /auth/verify` page that renders a button so Outlook Safe Links cannot
 * burn a token by prefetching it, and the per-email / per-IP rate limits. Both
 * belong to the auth routes, which another agent owns. The `email` index below is
 * what makes the per-email limit a cheap query when they arrive.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tokens = pgTable(
  'tokens',
  {
    /**
     * SHA-256 of the raw token, lowercase hex. The raw token exists only in the
     * email that carried it and in the request that redeems it.
     *
     * The shape check is not decoration: 64 lowercase hex characters is what
     * `createHash('sha256').digest('hex')` produces and what a base64url token,
     * a JWT or a UUID does not, so storing the raw value is rejected by the
     * database rather than discovered in an audit.
     */
    tokenHash: text('token_hash').primaryKey(),

    /** The address the link was sent to. Lowercased: the account key (`§2.1`). */
    email: text('email').notNull(),

    /** `created_at + 15 minutes`, per `§2.1`. Checked in the redeeming UPDATE. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Null until redeemed. Non-null is what makes the link single use. */
    usedAt: timestamp('used_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The per-email rate limit `§2.1` requires, and "resend my link". */
    index('tokens_email_idx').on(t.email, t.createdAt),

    /** Sweeping expired rows; the table is otherwise unbounded. */
    index('tokens_expires_at_idx').on(t.expiresAt),

    check('tokens_hash_is_sha256_hex', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('tokens_email_lowercase', sql`${t.email} = lower(${t.email})`),

    /** A token that expires before it is issued can never be redeemed. */
    check('tokens_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),

    /** And one cannot have been used before it existed. */
    check('tokens_used_after_creation', sql`${t.usedAt} is null or ${t.usedAt} >= ${t.createdAt}`),
  ],
);
