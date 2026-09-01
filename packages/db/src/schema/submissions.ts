/**
 * `submissions` — the pitch, written down before the buyer leaves for Dodo.
 *
 * ## The row `createCheckoutSession` already required
 *
 * `@the-pit/payments`' `checkout/session.ts` takes a `submissionId` and says
 * exactly what it is:
 *
 * > "The draft has to survive the round trip through Dodo, and Dodo metadata is
 * > a small string map — a 300-character description does not reliably fit and
 * > has no business travelling through a third party and back as authoritative
 * > input. So the draft is written to our own storage before checkout opens and
 * > only its id crosses. The webhook reads the row back and re-runs
 * > `checkSubmission` against it before enqueueing."
 *
 * This is that storage. Until it existed the webhook could resolve an account
 * and grant an attempt and then had nothing to enqueue: `pit/placement.requested`
 * carries a `Product`, and a `Product` needs a name and a description, neither of
 * which fits in Dodo's metadata map.
 *
 * ## Why it is not `products`
 *
 * `products_source_submitter` requires a paid row to name its submitter, and at
 * the moment this row is written there is no payer — `brief §2.1` is guest
 * checkout, so the email arrives with the webhook and not before. A draft parked
 * in `products` would have to be `source = 'seeded'`, which is a lie the board
 * would read, or would need the check relaxed, which would let a real paid row
 * exist with no payer on it. It is a different thing at a different stage of its
 * life, so it is a different table, and it graduates into `products` when the
 * placement lands.
 *
 * ## Nothing here is authoritative
 *
 * Every column is attacker-supplied text that has passed `checkSubmission` once,
 * before payment. `brief §2.4` requires the same check again before enqueue —
 * "Check before payment (client, fast feedback) and before enqueue (server,
 * authoritative)" — because the board moves in between: a nightly rebuild may
 * have closed the cycle, another pitch may have landed. So this table stores what
 * was typed and the derived values the second check will RE-derive, not a
 * clearance. `SubmissionClearance` is branded in `@the-pit/payments` precisely so
 * that it cannot be persisted and read back as proof of anything.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { products } from './products.js';

export const submissions = pgTable(
  'submissions',
  {
    /**
     * The id that crosses Dodo and comes back in `metadata.submission_id`.
     *
     * A uuid and not a sequence: it is handed to a third party and returned by a
     * client, so it must not be guessable and must not reveal how many
     * submissions exist.
     */
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The category the submitter chose, by slug rather than by `categories.id`.
     *
     * A foreign key would be tighter and is wrong here: `DECISIONS.md` S12 runs
     * the category classifier before payment and may REJECT a chosen category,
     * and a draft whose category was later renamed or retired must still be
     * readable for support. The slug is what the placement event carries
     * (`PlacementRequestedData.slug`) and what the pipeline resolves.
     */
    categorySlug: text('category_slug').notNull(),

    name: text('name').notNull(),

    /** The address as typed, trimmed. Never the key for anything. */
    url: text('url').notNull(),

    /** `normalizeUrl`'s output — `brief §2.5`, and the same value `products` stores. */
    normalizedUrl: text('normalized_url').notNull(),

    /** Sanitized to `SANITIZE_LIMIT` (300, `DECISIONS.md` S5) before it is stored. */
    description: text('description').notNull(),

    /** SHA-256 of the NORMALIZED description, hex — `descriptionHash` in `@the-pit/payments`. */
    descriptionHash: text('description_hash').notNull(),

    /**
     * What the founder claims, in their own words — kept apart from what their
     * site says.
     *
     * `description` above is the SITE's copy: pre-filled from the product's own
     * `<meta name="description">` by `POST /api/site-metadata`, and for 913 of
     * the 1028 seeded rows it was scraped from a third-party directory rather
     * than written by anybody at the company. Scoring that alone means partly
     * scoring a directory's house style. This column is the other signal, and
     * its value comes from being SEPARATE: a juror comparing "what the site
     * says" against "what they claim" is doing something a single merged blob
     * cannot express.
     *
     * Nullable, because it is optional on the form and because every row written
     * before this column existed has no answer — a backfilled empty string would
     * be a claim nobody made. `submissions_pitch_limit` below allows NULL and
     * bounds anything that is not.
     *
     * **Nothing reads it into a juror prompt yet.** Wiring it into scoring is an
     * engine change with its own calibration cost; see the phase report. It is
     * stored now so that when that change lands there is a corpus to calibrate
     * against instead of an empty column.
     */
    pitch: text('pitch'),

    /**
     * The buyer asked to be published without their name or their URL.
     *
     * The one column on this table that is not "what was typed" and is not a
     * derived value the second check will re-derive — it is a DECISION, and it is
     * the only decision on the buying path that cannot be made again later.
     *
     * `products.anonymous` is the source of truth and is frozen there by
     * `products_anonymity_immutable` (`0009_anonymous_listings.sql`). This column
     * is how the choice reaches it: the form writes it here before checkout opens,
     * the webhook reads it back with the rest of the draft, and the placement
     * carries it onto the `products` row it creates. Nothing between those points
     * asks the buyer again, and nothing after them can.
     *
     * **It has to be here rather than anywhere later**, and the reason is
     * mechanical before it is ethical. `lib/pipeline/pg-catalog.ts` marshals an
     * anonymous listing into the engine already wearing its designation, because a
     * juror who is shown a real name can write that name into a reason and a
     * reason is published as free text. The choice therefore has to exist before
     * the first prompt is built — before the run, before settlement, on the draft.
     * `brief §2.4`'s never-keep-the-best argument (see `0009`'s header) says the
     * same timing is also the only honest one; the two agree, which is why the
     * rule is cheap to keep.
     *
     * NOT NULL, defaulting to `false`, which is the same default `products`
     * carries: a named listing is the ordinary case. The default is what a caller
     * that says nothing gets — the form itself always says something, because it
     * renders the choice as two radios with "under your name" pre-checked rather
     * than as an unchecked box.
     */
    anonymous: boolean('anonymous').notNull().default(false),

    /**
     * The recalibration cycle the pre-payment check ran in. `brief §2.4` ties the
     * per-product cap to the rebuild, and `jobIdempotencyKey` includes this value
     * — which is what makes an identical re-pitch after the next rebuild a
     * genuinely different submission rather than a silent no-op.
     */
    cycleId: text('cycle_id').notNull(),

    /** `single` or `triple`. `PriceTierId` in `@the-pit/payments`. */
    tier: text('tier').notNull(),

    /** Which pitch this will be, 1-based. `brief §2.4`: shown publicly as "3rd pitch". */
    attemptNumber: integer('attempt_number').notNull(),

    /** The listing this pitch replaces, or null on a product's first pitch. */
    repitchOf: uuid('repitch_of').references(() => products.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Support's query: "what was submitted for this URL, and when". */
    index('submissions_normalized_url_idx').on(t.normalizedUrl, t.createdAt),

    /** The same limits `products` enforces, on the row that becomes one. */
    check('submissions_description_limit', sql`char_length(${t.description}) between 1 and 300`),
    check('submissions_name_present', sql`char_length(${t.name}) between 1 and 200`),
    check('submissions_description_hash_shape', sql`${t.descriptionHash} ~ '^[0-9a-f]{64}$'`),

    /**
     * The pitch cap, in the database and not only in the browser.
     *
     * 800 characters — roughly 130 words. The number is a scoring-cost decision
     * before it is a UX one: the recalibration prompt carries every product in a
     * category, and recalibration already runs 16–21× over its inference budget,
     * so every character here is multiplied by the roster. It is also what
     * `Capability Substance`'s own anchors reward — "turns an OpenAPI spec into
     * a typed Python client" scores 100 in nine words — so a longer field would
     * buy noise rather than signal.
     *
     * NULL passes: the field is optional, and rows written before it existed
     * have no answer. `apps/web`'s `lib/checkout/pitch.ts` holds the same number
     * for the form and refuses a longer one before the buyer is charged; this is
     * the floor under that, for every writer that is not that handler.
     */
    check('submissions_pitch_limit', sql`${t.pitch} is null or char_length(${t.pitch}) between 1 and 800`),
    check(
      'submissions_normalized_url_shape',
      sql`${t.normalizedUrl} = lower(${t.normalizedUrl}) and ${t.normalizedUrl} !~ '^[a-z][a-z0-9+.-]*:'`,
    ),

    /**
     * `brief §2.3` closes the tier table at two: "$5 = 1 attempt, $15 = 3
     * attempts + fit report. Keeps $5 as the atomic unit so 'same five dollars
     * for everyone' stays literally true." A third tier is a pricing decision,
     * and it should reach this table as a migration somebody reviewed rather than
     * as a string nothing here recognises.
     */
    check('submissions_tier_known', sql`${t.tier} in ('single', 'triple')`),

    check('submissions_attempt_number_positive', sql`${t.attemptNumber} >= 1`),
  ],
);
