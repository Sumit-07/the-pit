/**
 * `verdicts` — the thing a customer paid for, frozen at the moment it was handed
 * over, addressable forever at one public URL.
 *
 * ## Why a verdict is stored and not derived
 *
 * Every ingredient of a verdict page is already in this schema: `score_rows`
 * carries each deduction with its reason and the juror who took it,
 * `cluster_members` carries the cluster the product was judged inside,
 * `demand_votes` carries which Floor personas picked it, and `rankings` carries
 * the rank and the composite. Rendering the page live off those is the obvious
 * design and it is wrong, for one reason:
 *
 *   `DECISIONS.md` §1.2 — every placement shifts every z-score.
 *
 * The board moves by design. A verdict rendered live would therefore show
 * DIFFERENT NUMBERS after the next rebuild than it did when it was delivered,
 * and `brief` Part 6 requires the opposite: "a public permanent URL, shareable,
 * works logged out". A link someone posted has to keep showing what they were
 * talking about. `brief` Part 5 makes the same point from the other side when it
 * stamps the card with a timestamp and a product count — those two numbers exist
 * precisely to say "this is what the board looked like then", which is a lie if
 * the body of the card is recomputed.
 *
 * `brief` Part 7 closes it: the score log "is the integrity record if anyone
 * disputes a ranking". A dispute is about what the customer was shown. If the
 * only stored artifact is the ingredients, the thing under dispute was never
 * saved.
 *
 * So: `payload` is the rendered verdict, frozen at delivery. `score_rows` and
 * friends remain the source of truth for RECOMPUTATION — `02 §7`'s claim is
 * untouched, and `test/seed/real-boards.test.ts` still proves a board rebuilds
 * from the raw rows alone. The two answer different questions. The raw rows
 * answer "is the ranking defensible"; this table answers "what did we actually
 * say to this customer, on this day".
 *
 * ## Append-only, and why that is the whole design
 *
 * `DECISIONS.md` **S8 is OPEN**: after a re-pitch, does the shared verdict URL
 * show the new verdict, freeze at v1 with a superseded banner, redirect, or 404?
 * All four readings are implemented in `packages/payments/src/listing/repitch.ts`
 * behind a `RepitchPolicy` that has no default.
 *
 * This table encodes none of them. It gives every reading the one thing they all
 * need and cannot recover afterwards: the old row, still there, still resolvable
 * by its own slug. A re-pitch INSERTS; nothing ever updates. `migrations/
 * 0003_accounts_and_verdicts.sql` refuses UPDATE and DELETE outright, which is
 * the same posture `attempts` and delivered `jobs` already take.
 *
 * Concretely, under each reading of S8:
 *
 *   archive at permanent URL   old slug serves the old row, banner links to the new
 *   redirect to current        old slug 301s; the row is what makes the target derivable
 *   show the new verdict       the product's newest row is looked up by `product_id`
 *   404                        the route refuses; the row is still the dispute record
 *
 * An UPDATE-in-place design implements exactly one of those and destroys the
 * evidence for the other three. Choosing a policy in the schema would be
 * choosing S8 by accident, in the layer that is hardest to change.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { accounts } from './accounts.js';
import { jobs } from './jobs.js';
import { products } from './products.js';

export const verdicts = pgTable(
  'verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The public URL, and the only handle a shared link has.
     *
     * A separate column rather than the uuid, because the uuid is an internal
     * key and this is a customer-facing address: it appears in a tweet, a
     * screenshot and a support email, and it has to stay stable across every
     * reading of S8. Unique across the whole table, never reused, never moved.
     */
    publicSlug: text('public_slug').notNull(),

    /** The listing this verdict is about. `listingId` in `@the-pit/payments`. */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The delivered run that produced it. `runId` in `@the-pit/payments`.
     *
     * NULL on a seeded verdict: `brief` Part 7's cold-start boards were produced
     * by the engine's CLI before any job row existed, and the listings they
     * describe are "marked clearly as unclaimed". A verdict nobody paid for
     * still has a public page; it just has no run behind it.
     */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * Who paid. NULL on a seeded verdict, for the same reason as `job_id`.
     *
     * This is the column `brief §2.1` needs for "attempt balance and history
     * behind a session": the history page is a scan of this index, and the
     * public page is a lookup on `public_slug` that never touches it.
     */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * Which pitch this is, 1-based. `brief §2.4`: "Show the attempt count
     * publicly" — rendered as "3rd pitch" by `ordinalPitch` in
     * `@the-pit/payments`.
     *
     * Frozen with the rest of the row: the label on a shared card must not
     * change when the founder pitches again.
     *
     * NULL on a verdict that is not a pitch. `ListingSnapshot.attemptNumber` in
     * `@the-pit/payments` is `0` for a seeded listing — "it counts pitches and
     * not runs", and nobody has pitched an unclaimed row — so a seeded board's
     * verdict has no ordinal to show. Storing `1` instead would print "1st
     * pitch" under a listing whose owner has never been here, and would take the
     * ordinal a founder's real first pitch is entitled to.
     */
    attemptNumber: integer('attempt_number'),

    /**
     * The rendered verdict, exactly as it was delivered.
     *
     * `jsonb` and not a set of columns, because `brief` Part 6 enumerates the
     * card's contents — every deduction with its reason and juror, the cluster
     * judged inside, which Floor personas picked it, rank, composite — and
     * pulling those apart into columns would be a second, drifting copy of the
     * engine's `RankedProduct`. The document is the unit that must be
     * byte-stable, so the document is what is stored.
     */
    payload: jsonb('payload').notNull(),

    /**
     * How many products were on the board when this verdict was issued.
     * `brief` Part 5 stamps it on the card beside the timestamp, because a rank
     * of 4 means something different out of 12 than out of 200 — and because the
     * board it refers to has since moved.
     */
    productCount: integer('product_count').notNull(),

    /**
     * The instant it was handed over. `brief §2.3` makes the same instant the
     * money event, and `verdicts_require_delivered_job` ties this row to a job
     * that carries it.
     */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The public URL is one URL. */
    unique('verdicts_public_slug_uk').on(t.publicSlug),

    /**
     * One verdict per delivered run.
     *
     * `@the-pit/payments` keys a consume on the run — `delivery:run:<runId>` —
     * and `attempts_one_consume_per_job_uk` already makes a job chargeable once.
     * This is the same cardinality on the delivered artifact: a job that
     * produced two verdicts would have charged for one of them.
     */
    unique('verdicts_one_per_job_uk').on(t.jobId),

    /**
     * A listing has one 1st pitch, one 2nd pitch, and so on.
     *
     * True under both readings of what a re-pitch does to the product row. If a
     * re-pitch replaces the listing in place (`planRepitch`'s
     * `replace_in_place`), this stops two rows both claiming to be the "3rd
     * pitch" — a contradiction the card shows publicly. If a re-pitch instead
     * inserts a new product row (which `products_scored_identity_immutable`
     * forces when the description changes), each product has one verdict and the
     * constraint is satisfied trivially. Correct either way, so it does not
     * prejudge S8.
     *
     * Seeded verdicts carry a NULL ordinal and are therefore exempt: NULLs are
     * all distinct to a unique constraint, so an unclaimed listing's cold-start
     * page does not occupy the ordinal its founder's first real pitch will use.
     */
    unique('verdicts_product_attempt_uk').on(t.productId, t.attemptNumber),

    /** The listing's verdict history, newest first. */
    index('verdicts_product_idx').on(t.productId, t.deliveredAt),

    /** `brief §2.1`: the account's history page, behind the session. */
    index('verdicts_account_idx').on(t.accountId, t.deliveredAt),

    /**
     * `brief §2.4` counts pitches from one. A zero would render as "0th pitch";
     * a negative one means the counter was read off something that was null.
     * (A row with no ordinal at all says so with NULL — see the column.)
     */
    check('verdicts_attempt_number_positive', sql`${t.attemptNumber} is null or ${t.attemptNumber} >= 1`),

    /**
     * A board a verdict was issued against contains at least the product the
     * verdict is about.
     */
    check('verdicts_product_count_positive', sql`${t.productCount} >= 1`),

    /**
     * The slug appears in URLs, so it is constrained to what survives one: lower
     * case, digits and hyphens, no leading or trailing hyphen. The length floor
     * keeps it from being guessable by hand — the page is public, but "public"
     * means "resolvable by whoever holds the link", not "enumerable".
     */
    check(
      'verdicts_public_slug_shape',
      sql`${t.publicSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${t.publicSlug}) between 12 and 128`,
    ),

    /**
     * The frozen verdict is a document. A scalar or an array here means
     * something serialized the wrong value into the one column the customer's
     * dispute will be argued from.
     */
    check('verdicts_payload_is_document', sql`jsonb_typeof(${t.payload}) = 'object'`),

    /**
     * A verdict that names a payer names the run they paid for, and shows the
     * pitch ordinal `brief §2.4` requires. The converse is allowed: an admin
     * `full_run` delivers a verdict for an unclaimed seeded listing, which has a
     * job, no account, and nothing to count.
     */
    check(
      'verdicts_paid_verdict_is_a_pitch',
      sql`${t.accountId} is null or (${t.jobId} is not null and ${t.attemptNumber} is not null)`,
    ),
  ],
);
