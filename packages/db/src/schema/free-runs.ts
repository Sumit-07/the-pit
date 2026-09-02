/**
 * `free_run_requests` — one row per free first throw, and nothing that could
 * identify the person who took it.
 *
 * ## Why the table exists
 *
 * A free throw spends real money: twelve juror calls, a clustering pass and a
 * persona round, which `brief §2.3` prices at $5 for everybody who is not on this
 * table. The offer is only survivable because a person gets exactly one, and
 * "one" is a claim about state that has to live somewhere durable. It cannot live
 * in a process — `packages/auth`'s `MemoryRateLimiter` says so about itself: on
 * Vercel "every serverless invocation may be a fresh instance and the map is
 * empty again". A per-instance limiter on this path is not a weak defence, it is
 * no defence, and the failure is invisible because the offer keeps working.
 *
 * So it is a table, and it is the same shape as the other ledgers here: rows are
 * written once and never updated or deleted (`free_run_requests_immutable` in
 * `0012_free_run_requests.sql`). The reason is the same one `0001_ledger_guards.sql`
 * gives for `attempts`: a record that can be edited in place is not a record. One
 * UPDATE to a `created_at` and the hourly window slides for free; one DELETE and
 * a URL is available again.
 *
 * ## Why there are hashes here and no addresses
 *
 * Every free-throw request carries an email and an IP, and both are personal data
 * we have no use for after the check. What the rules actually need is EQUALITY —
 * "has this address run before", "how many requests from this address in the last
 * hour" — and equality survives a keyed hash intact.
 *
 * So the columns are HMAC-SHA256 digests under `SESSION_SECRET`, the same posture
 * `schema/auth.ts` takes with `tokens.token_hash`: "a table with nowhere to put a
 * raw token cannot leak one in a backup, a log line or a `SELECT *`". The two
 * shape checks below are the enforcement — 64 lowercase hex characters is what a
 * digest looks like and what an email address, an IPv4 address and an IPv6
 * address all are not, so storing the raw value is refused by the database rather
 * than discovered in an audit.
 *
 * HMAC and not a bare SHA-256, because the input space here is tiny. The set of
 * plausible email addresses and the whole IPv4 space are both walkable in
 * minutes against an unkeyed digest, which would make a leaked dump of this table
 * a leaked dump of its addresses. The key is what removes that, and it is
 * `SESSION_SECRET` rather than a new secret so that a deployment has one fewer
 * thing to fail to configure.
 *
 * `normalized_url` is stored PLAIN and deliberately: it is the public identity of
 * a product on a public board, `products.normalized_url` already holds it in the
 * clear, and hashing it here would buy nothing while making the "has this product
 * had its free throw" question unanswerable by a human reading the table.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { submissions } from './submissions.js';

export const freeRunRequests = pgTable(
  'free_run_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The draft this free throw was granted for.
     *
     * A foreign key and not a loose string: the row it points at is what carries
     * the URL, the category and the pitch, and a free-run record naming a
     * submission that does not exist is a record of nothing. `restrict` on delete
     * for the same reason the rest of the money path uses it — this row is
     * evidence, and evidence that a cascade can remove is not evidence.
     *
     * Unique, because one submission is one throw. `record` inserts with
     * `on conflict do nothing`, so a handler retried by a platform that delivered
     * its request twice writes one row rather than raising.
     */
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * HMAC-SHA256 of the FOLDED email key, lowercase hex.
     *
     * Folded, not raw: `a.b+throwaway@gmail.com` and `ab@gmail.com` are one
     * inbox, and a rule that treated them as two people would be a rule anybody
     * could turn off by typing a `+`. The folding happens in
     * `apps/web/src/lib/free/policy.ts`, which owns the question of what counts
     * as the same person; this column only stores the answer.
     */
    emailKeyHash: text('email_key_hash').notNull(),

    /**
     * HMAC-SHA256 of the client address, lowercase hex, or null when there was
     * none to read.
     *
     * Nullable because `clientIp` can genuinely fail to resolve one, and a null
     * here is honest: it says "this request had no address", which is a different
     * fact from a hash of the string `unknown` and one the IP window skips
     * rather than lumps together.
     */
    ipHash: text('ip_hash'),

    /**
     * `brief §2.5`'s key, resolved. The same value `products.normalized_url` and
     * `submissions.normalized_url` hold, and the same shape rule they enforce.
     */
    normalizedUrl: text('normalized_url').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** "Has this product had its free throw" — the `url_used` rule, ever. */
    index('free_run_requests_normalized_url_idx').on(t.normalizedUrl, t.createdAt),

    /** "Has this person had theirs" — the `email_used` rule, ever. */
    index('free_run_requests_email_key_idx').on(t.emailKeyHash, t.createdAt),

    /** The hourly window: one address, the last hour. */
    index('free_run_requests_ip_idx').on(t.ipHash, t.createdAt),

    /** The global daily cap, which reads time and nothing else. */
    index('free_run_requests_created_at_idx').on(t.createdAt),

    /** One free throw per submission. */
    unique('free_run_requests_submission_uk').on(t.submissionId),

    /**
     * The two columns that make this table safe to hold. 64 lowercase hex
     * characters is a digest; an email address is not, and neither is an IP.
     */
    check('free_run_requests_email_key_is_hmac_hex', sql`${t.emailKeyHash} ~ '^[0-9a-f]{64}$'`),
    check('free_run_requests_ip_is_hmac_hex', sql`${t.ipHash} is null or ${t.ipHash} ~ '^[0-9a-f]{64}$'`),

    /** The same shape `submissions_normalized_url_shape` pins: lowercase, no scheme. */
    check(
      'free_run_requests_normalized_url_shape',
      sql`${t.normalizedUrl} = lower(${t.normalizedUrl}) and ${t.normalizedUrl} !~ '^[a-z][a-z0-9+.-]*:'`,
    ),
  ],
);
