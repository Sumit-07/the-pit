/**
 * `products` — one row per thing in the pit.
 *
 * Two identities live on this row and they are not interchangeable:
 *
 * - `id` (uuid) is the app's identity. Verdict URLs are "public permanent"
 *   (`brief §2.1`), orders and attempts point at it, and it must survive a
 *   re-seed of the category.
 * - `engine_id` (int, 0-based, unique per category) is `Product.id` in
 *   `@the-pit/engine`. Every score row, cluster assignment and demand vote the
 *   panels return is keyed by it, and `src/run/store.ts` in the engine spells out
 *   why it must never be re-derived: "re-deriving it from a sheet that has since
 *   gained or lost a row renumbers every product — and ids are how every stored
 *   score, cluster and vote attaches to a product."
 *
 * The relational tables key on `id`; `engine_id` exists so a category can be
 * marshalled back into the engine's `ProductSet` without inventing a mapping at
 * every call site.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { categories } from './categories.js';
import { productSource, productStatus } from './enums.js';

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** `Product.id` in the engine: a 0-based index into the category's usable rows. */
    engineId: integer('engine_id').notNull(),

    name: text('name').notNull(),

    /** The submitted address, verbatim apart from trimming. Never the key for anything. */
    url: text('url').notNull(),

    /**
     * `url` reduced to an identity by `normalizeUrl` from `@the-pit/engine` —
     * lowercased, protocol and `www.` and trailing slash stripped, every query
     * parameter dropped. `brief §2.5` and `src/products/normalized-url.ts`.
     *
     * INDEXED, and that index is the point of the column: `brief §2.4` caps
     * re-pitching at "One pitch per product per recalibration cycle … per
     * product, not per account", and `§2.5` says to key that cap on the
     * normalized URL. The cap is a lookup on this index in the submission path,
     * so it has to be an indexed column and not a computed expression.
     *
     * NOT unique. `brief §2.5` is explicit that evasion via a genuinely different
     * URL is "flag for review, do not hard-block — a false rejection on a paying
     * customer is worse than an extra run", and `§2.4` has a re-pitch replace a
     * previous listing, which means two rows can legitimately share a normalized
     * URL while one is superseded. A unique index would turn both of those into
     * a 500 on the money path.
     *
     * SHORTENER RESOLUTION IS DEFERRED. `brief §2.5` also asks for link
     * shorteners to be resolved to their target and the target stored. Nothing in
     * this package does that, and `normalizeUrl` performs no I/O by design: doing
     * it needs an SSRF-guarded fetcher (redirect cap, timeout, private-address
     * and link-local blocking, scheme allow-list) because the input is an
     * attacker-supplied URL fetched by our server. Until that exists, a shortened
     * URL normalizes to the shortener's own host and the cap does not catch it.
     * Tracked as Phase 3 work; the column type and index do not change when it
     * lands, only the value written into them.
     */
    normalizedUrl: text('normalized_url').notNull(),

    /** Sanitized to `SANITIZE_LIMIT` (300 chars, `DECISIONS.md` S5) before it is stored. */
    description: text('description').notNull(),

    /**
     * SHA-256 of the description, hex. `02 §8` dedups on it, and `brief §1.3`
     * makes it the first component of the preview cache key. `brief §2.4`
     * requires "materially changed description text" on a re-pitch, and an
     * unchanged hash is the cheap half of that check.
     */
    descriptionHash: text('description_hash').notNull(),

    source: productSource('source').notNull(),
    status: productStatus('status').notNull(),

    /**
     * The payer's email as Dodo collected it (`brief §2.1`). Null for seeded
     * rows, which have no submitter — that is what `source = 'seeded'` means.
     *
     * There is no accounts table in this schema: `brief §2.1` has no login at
     * submission and identifies a returning user only by a magic link to the
     * email the payment carried, so the email IS the account key at this phase.
     * Lowercased by a check so `A@b.com` and `a@b.com` cannot become two people.
     */
    submittedByEmail: text('submitted_by_email'),

    /**
     * `brief` Part 7, on seeded listings: "mark clearly as unclaimed, offer
     * one-click opt-out". Set when a company asks to be removed; the row stays so
     * the boards it appeared on remain reproducible.
     */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),

    /** When the product entered the real ranking. Null while pending or held. */
    placedAt: timestamp('placed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The engine's product id is unique inside its category and meaningless
    // outside it.
    unique('products_category_engine_id_uk').on(t.categoryId, t.engineId),

    /**
     * The target of the composite foreign keys on `score_rows`,
     * `cluster_members` and `demand_votes`. Those tables carry `category_id`
     * alongside `product_id` so a whole category's raw log can be read without a
     * join; this unique is what stops the copy from ever disagreeing with the
     * original, because the FK checks the pair rather than the id.
     */
    unique('products_id_category_uk').on(t.id, t.categoryId),

    // Required by the brief: the per-product submission cap hangs off this.
    index('products_normalized_url_idx').on(t.normalizedUrl),

    // `02 §8`'s dedup-by-content-hash, and the preview cache lookup.
    index('products_description_hash_idx').on(t.categoryId, t.descriptionHash),

    // The board query: everything placed in one category.
    index('products_category_status_idx').on(t.categoryId, t.status),

    // "Balance and history are behind the session" (`brief §2.1`) — a user's
    // products, by the only identity we hold.
    index('products_submitted_by_email_idx').on(t.submittedByEmail),

    check('products_engine_id_non_negative', sql`${t.engineId} >= 0`),

    // `01 §5.1` and the sanitize step: descriptions are truncated to 300 before
    // they reach a prompt, so a longer one in the table means something wrote
    // around `sanitize`.
    check('products_description_limit', sql`char_length(${t.description}) between 1 and 300`),

    // SHA-256, hex, lowercase.
    check('products_description_hash_shape', sql`${t.descriptionHash} ~ '^[0-9a-f]{64}$'`),

    // `normalizeUrl` lowercases its whole output and strips the scheme; a value
    // with a scheme or an upper-case letter did not come from it.
    check('products_normalized_url_shape', sql`${t.normalizedUrl} = lower(${t.normalizedUrl}) and ${t.normalizedUrl} !~ '^[a-z][a-z0-9+.-]*:'`),

    check('products_email_lowercase', sql`${t.submittedByEmail} is null or ${t.submittedByEmail} = lower(${t.submittedByEmail})`),

    // A seeded row has no submitter and a paid one always does. This is what
    // makes `source` load-bearing rather than decorative.
    check(
      'products_source_submitter',
      sql`(${t.source} = 'seeded' and ${t.submittedByEmail} is null) or (${t.source} = 'paid' and ${t.submittedByEmail} is not null)`,
    ),

    // `placed_at` is the fact the board reads; `status` is the label. They cannot
    // disagree, or a product appears on a board with no placement time.
    check('products_placed_at_matches_status', sql`(${t.status} = 'placed') = (${t.placedAt} is not null)`),
  ],
);
