/**
 * `account_identities` — a provider login attached to an account that already
 * exists.
 *
 * ## It attaches, it never creates
 *
 * Every row here points at an `accounts` row that a payment made. There is no
 * path in the codebase that inserts here and into `accounts` together, and
 * `@the-pit/auth`'s stores have no `createAccount` at all: a GitHub identity
 * whose verified addresses match no purchase gets told so and offered the
 * capability URL from their receipt. `brief §2.1`'s design is that the payment
 * email is the identity; an account with no purchase behind it is a fiction that
 * would have to be merged with the real one the day the person actually paid.
 *
 * `brief §2.1` also says "No GitHub, no Google", and it says it as the answer to
 * *what identifies the payer*. That answer is unchanged. GitHub matches AGAINST
 * the payment email and never replaces it, cannot mint an account, and is never
 * on the buying path — guest checkout stays the default on every device, because
 * on a phone without the GitHub app installed, OAuth for a $5 impulse purchase
 * is where the funnel dies.
 *
 * ## Why the row exists rather than matching on the address every time
 *
 * Because the address moves. A customer who changes their GitHub email — on a
 * different website, for reasons that have nothing to do with us — would
 * otherwise stop matching and find their account unreachable by that path. So
 * the first successful match is recorded against the provider's OWN user id,
 * which does not change when the address does, and every later sign-in resolves
 * through this table first.
 *
 * `provider_user_id` must therefore be the provider's immutable id — GitHub's
 * numeric `user.id`, never the login. A login is renameable, and a freed-up
 * login can be registered by somebody else, so a link keyed on one hands the
 * account to whoever claims the name next.
 *
 * ## The UNIQUE is the security control
 *
 * `(provider, provider_user_id)` is unique, and the writer's `ON CONFLICT DO
 * UPDATE` sets `linked_email` and nothing else — in particular never
 * `account_id`. If a link could be repointed, anyone who signed in with GitHub
 * once could later add a customer's address to their GitHub, verify it, sign in
 * again, and have their existing link silently transferred. Refusing the move
 * means the second sign-in resolves through the link to the attacker's own
 * account, which is the correct and boring outcome.
 *
 * Note what is NOT unique: `account_id`. One account may carry several links —
 * a person with two GitHub accounts, or a second provider later — and that is
 * deliberate. See the provider check below.
 *
 * ## What this table is not
 *
 * It is not an ownership record. The approved perks include proving that a
 * product URL belongs to the person pitching it, and GitHub proves nothing for
 * most consumer products — 26 of the 44 seeded Health & Fitness listings have no
 * repository at all. Ownership will need a second proof that is not GitHub (a
 * DNS `TXT` record, or `/.well-known/thepit.txt` on the product's own domain),
 * and it will need its own table, keyed on the thing being owned rather than on
 * the person. Nothing here should be extended to carry it.
 *
 * It is also not a source of anything the Mob sees. A verified-builder marker
 * belongs on the board and the verdict page only: the Mob's value is that real
 * visitors make the IDENTICAL forced choice the Floor personas made, so the two
 * demand datasets are comparable per cluster. A badge that real voters see and
 * synthetic personas never saw would make the divergence marker measure the
 * badge instead of the disagreement.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { accounts } from './accounts.js';

export const accountIdentities = pgTable(
  'account_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The account this login reaches. `restrict` on delete, like every other
     * money-adjacent foreign key: a customer's records are evidence, and a
     * cascade would take them with the row.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** `github` today. Lowercase; see the shape check below. */
    provider: text('provider').notNull(),

    /** GitHub's numeric `user.id`, as text. Never the login. */
    providerUserId: text('provider_user_id').notNull(),

    /**
     * The verified provider address this link came in on, lowercased.
     *
     * Audit and support only — "which address brought them in" — and refreshed
     * on each sign-in. It is deliberately NOT unique and NOT the key: making it
     * either would reintroduce exactly the orphaning this table exists to
     * prevent the moment the customer changes it.
     */
    linkedEmail: text('linked_email').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Moves when `linked_email` is refreshed. The evidence of a re-sign-in. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** THE control. See the header: a link is never moved to another account. */
    unique('account_identities_provider_user_uk').on(t.provider, t.providerUserId),

    /** "Which logins does this account have", for the account page and support. */
    index('account_identities_account_idx').on(t.accountId, t.createdAt),

    /**
     * A shape check rather than an enumeration of known providers.
     *
     * `provider IN ('github')` was the first instinct and is wrong for this
     * table: a second identity provider would then be a migration, and so would
     * anything else that wants to live here. The realistic failure a check can
     * actually catch is a writer passing a display name, an empty string, or a
     * mixed-case spelling that quietly opens a parallel keyspace where the
     * UNIQUE above no longer protects anything — and a lowercase-identifier
     * pattern catches all three.
     */
    check('account_identities_provider_shape', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,31}$'`),

    /** An empty provider id would make the UNIQUE meaningless for that provider. */
    check('account_identities_provider_user_id_present', sql`char_length(${t.providerUserId}) between 1 and 255`),

    /** Matches `accounts_email_lowercase`, so the two can be compared directly. */
    check('account_identities_email_lowercase', sql`${t.linkedEmail} = lower(${t.linkedEmail})`),

    /** The same minimal address shape `accounts` uses. */
    check(
      'account_identities_email_shape',
      sql`${t.linkedEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`,
    ),
  ],
);
