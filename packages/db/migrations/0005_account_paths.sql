-- Two more ways for a returning customer to reach the account they paid for.
--
-- `brief §2.1` reaches them with a magic link, and the magic link is unchanged:
-- `tokens` is untouched, the SHA-256 hashes are untouched, the single-use atomic
-- consume is untouched. What is added is that it is no longer the ONLY way in.
--
-- The magic link depends on email being delivered, which depends on SPF, DKIM
-- and DMARC being live and warmed — a fortnight at `p=none` before anything
-- tightens, plus reputation warm-up on a new sending domain. Until that is done,
-- "check your inbox" is a promise the infrastructure cannot keep, and it fails
-- worst for exactly the corporate mailboxes most likely to have paid. So:
--
--   1. `accounts.capability_slug` — a bearer URL minted by the Dodo webhook and
--      shown on the success page, which removes email from the critical path.
--   2. `account_identities` — a GitHub login attached to an account that already
--      exists, for the customer who would rather press one button.
--
-- Both converge on the same `accounts` row, keyed on the verified payment email.
-- NEITHER can create one. That is the invariant `brief §2.1` actually protects —
-- the payment email is the identity, and an account with no purchase behind it
-- is a fiction that would have to be merged with the real one the day the person
-- paid — and it is enforced by there being no `createAccount` anywhere in
-- `@the-pit/auth`'s store interfaces.
--
-- Additive. `0000`-`0003` are untouched and still run first, so a fresh database
-- and an existing one reach the same end state. Nothing is dropped, nothing is
-- rewritten, and every existing row keeps working.

-- ---------------------------------------------------------------------------
-- 1. THE CAPABILITY SLUG.
--
-- `/a/<capability_slug>` reaches the account with no email, no password and no
-- session. That is the point: it is the path that works while DNS is still
-- warming.
--
-- ## One column, not a table
--
-- A bearer URL cannot be un-shared, so rotation is the only revocation it has —
-- and rotation must mean the old URL STOPS WORKING. A single column gives that
-- for free: the UPDATE that writes a new slug removes the old one in the same
-- statement, with no window in which both resolve. A `capability_slugs` table
-- would permit two live rows per account, which is precisely what rotation
-- exists to prevent.
--
-- ## Stored in the clear, deliberately
--
-- `tokens.token_hash` is a digest because a magic-link token only ever has to be
-- VERIFIED. This one has to be DISPLAYED — on the success page, in the backup
-- email, and again when a customer asks support for it — and a digest cannot be
-- displayed. So this column holds a bearer credential at rest. What bounds it:
-- rotation is one request, the `/a/<slug>` route sends
-- `Referrer-Policy: no-referrer` and redirects without the slug in the URL, and
-- nothing logs it. Read access here is also read access to `orders` and
-- `attempts`, so it is not the marginal disclosure it first looks like.
--
-- ## The DEFAULT is a floor, not the mechanism
--
-- Slugs are normally minted by `@the-pit/auth`'s `mintCapabilitySlug` — 32 bytes
-- from the OS CSPRNG, base64url — and passed in by the webhook. The default
-- exists so an account can never be created WITHOUT one, because an account with
-- no capability URL is a customer who cannot reach what they paid for. It is
-- also what backfills the existing rows below.
--
-- It builds 43 base64url characters from two `gen_random_uuid()` values:
--
--   * `gen_random_uuid()` is core Postgres since 13 and draws from
--     `pg_strong_random`, the same OS CSPRNG. Deliberately NOT `random()`, which
--     is a seeded PRNG, and deliberately NOT `gen_random_bytes()`, which lives
--     in the `pgcrypto` contrib extension — this schema refuses to depend on
--     contrib for the same reason it uses `text` rather than `citext`: an
--     extension that silently is not installed on Neon or in the in-process
--     PGlite the schema tests use would break migration time, not query time.
--   * Two uuids are 32 bytes. Each spends 6 bits on version and variant markers,
--     so the pair carries 244 bits of entropy — comfortably past the 128-bit
--     floor, and within reach of the 256 the application mint provides.
--   * `decode(... , 'hex')` turns the 64 hex characters into those 32 bytes;
--     `encode(..., 'base64')` gives 44 characters with one `=` of padding; and
--     `translate(..., '+/=', '-_')` maps `+`→`-`, `/`→`_` and DELETES `=`
--     (the `to` string is shorter than the `from` string), leaving exactly the
--     43 unpadded base64url characters the check below demands.
--
-- Added with the default in place, so Postgres fills every existing row in the
-- same statement and the column can be NOT NULL immediately. No separate
-- backfill, and no window in which an account exists without a slug.
ALTER TABLE "accounts" ADD COLUMN "capability_slug" text DEFAULT translate(encode(decode(replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''), 'hex'), 'base64'), '+/=', '-_') NOT NULL;--> statement-breakpoint

-- One account per slug. Without this a bug in a rotation could hand two
-- customers the same URL, and each would sign in as whichever row the planner
-- reached first. It is also the index the `/a/<slug>` lookup runs on.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_capability_slug_uk" UNIQUE("capability_slug");--> statement-breakpoint

-- Exactly 43 base64url characters. The LENGTH is the security property, so the
-- database enforces it rather than trusting every writer: a bare `text` column
-- would accept `'1'`, and an account addressable at `/a/1` is addressable by
-- anyone who can count. The alphabet is checked too — `+`, `/` and `=` are the
-- standard-base64 characters a mis-encoded mint emits, and each of them either
-- breaks or changes meaning inside a URL path.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_capability_slug_shape" CHECK ("accounts"."capability_slug" ~ '^[A-Za-z0-9_-]{43}$');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. THE PROVIDER LINK.
--
-- ## Why the row exists rather than matching on the address every time
--
-- Because the address moves. A customer who changes their GitHub email — on a
-- different website, for reasons that have nothing to do with us — would
-- otherwise stop matching and find their account unreachable by that path. The
-- first successful match is recorded against the provider's OWN user id, which
-- does not change when the address does, and every later sign-in resolves
-- through this table before it looks at any address.
--
-- `provider_user_id` is therefore GitHub's numeric `user.id`, never the login.
-- A login is renameable, and a freed-up login can be registered by somebody
-- else, so a link keyed on one hands the account to whoever claims the name.
--
-- ## The security boundary is upstream of this table
--
-- A row only ever gets written for an address GitHub reported as
-- `"verified": true`. `GET /user/emails` returns unverified addresses in the
-- same array, and anyone can ADD any address to their own GitHub account without
-- proving anything — only verifying it requires a click. Matching on an
-- unverified address would mean an attacker types a customer's address into
-- their GitHub settings and walks off with the customer's attempts and their
-- listing. See `@the-pit/auth`'s `oauth/verified-emails.ts`.
--
-- ## The UNIQUE is the control this table itself provides
--
-- `(provider, provider_user_id)` is unique, and the writer's `ON CONFLICT DO
-- UPDATE` sets `linked_email` and `updated_at` and NOTHING ELSE — never
-- `account_id`. If a link could be repointed, anyone who signed in once could
-- later add and verify a customer's address and have their existing link
-- silently transferred to the customer's account. Refusing the move means the
-- second sign-in resolves through the link to the attacker's own account, which
-- is the correct and boring outcome.
--
-- `account_id` is deliberately NOT unique: one account may carry several links
-- (a person with two GitHub accounts, or a second provider later).
CREATE TABLE "account_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"linked_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identities_provider_user_uk" UNIQUE("provider","provider_user_id"),

	-- A SHAPE check rather than an enumeration of known providers.
	-- `provider IN ('github')` was the first instinct and is wrong here: a second
	-- identity provider would then be a migration, and so would a non-GitHub
	-- ownership proof — which is coming, because GitHub proves nothing for most
	-- consumer products (26 of the 44 seeded Health & Fitness listings have no
	-- repository at all). What a check CAN usefully catch is a writer passing a
	-- display name, an empty string, or a mixed-case spelling that quietly opens
	-- a parallel keyspace in which the UNIQUE above protects nothing.
	CONSTRAINT "account_identities_provider_shape" CHECK ("account_identities"."provider" ~ '^[a-z][a-z0-9_]{1,31}$'),

	-- An empty provider id would make the UNIQUE meaningless for that provider.
	CONSTRAINT "account_identities_provider_user_id_present" CHECK (char_length("account_identities"."provider_user_id") between 1 and 255),

	-- Matches `accounts_email_lowercase`, so the two can be compared directly.
	CONSTRAINT "account_identities_email_lowercase" CHECK ("account_identities"."linked_email" = lower("account_identities"."linked_email")),
	CONSTRAINT "account_identities_email_shape" CHECK ("account_identities"."linked_email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')
);
--> statement-breakpoint

-- `restrict`, like every other money-adjacent foreign key in this schema: a
-- customer's records are evidence (`brief` Part 7), and a cascade would take
-- them with the row.
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

-- "Which logins does this account have", for the account page and for support.
CREATE INDEX "account_identities_account_idx" ON "account_identities" USING btree ("account_id","created_at");
