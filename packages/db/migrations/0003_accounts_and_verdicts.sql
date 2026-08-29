-- Two tables the money path was missing, and the identity that ties them together.
--
-- Phase 2 and Phase 3 were built in parallel and disagreed about what an account
-- is. `packages/payments` types its ledger on `accountId` / `runId` / `verdictId`
-- / `listingId`; this schema had `account_email` / `job_id` / `product_id`, no
-- `accounts` table and no `verdicts` table. Both were internally consistent and
-- neither was complete. This migration settles it:
--
--   runId      -> jobs.id
--   listingId  -> products.id
--   verdictId  -> verdicts.id
--   accountId  -> accounts.id
--
-- Additive: `0000`-`0002` are untouched and still run first, so a fresh database
-- reaches the same end state as an existing one.
--
-- ## 1. `accounts`
--
-- `brief §2.1` describes an account without using the word: guest checkout, the
-- Dodo webhook hands the server a VERIFIED email, the server creates the account
-- from it server-side, and "attempt balance and history sit behind a session
-- while verdict URLs stay public". A thing with a balance, a history, a session
-- and a login link is an account.
--
-- The email is still the identity — UNIQUE below, because it is what Dodo
-- verifies and what the magic link targets — but it stops being the FOREIGN KEY.
-- A lowercased address copied onto `orders` and `attempts` is a key with no
-- referent: nothing stopped the ledger holding a balance for an address `orders`
-- had never seen, the magic-link flow had no row to hang a session on, and a
-- support-requested address change had to be applied atomically to every table
-- that had copied it or the balance split in two.
--
-- `text` with a lowercase CHECK rather than `citext`: `citext` is a contrib
-- extension, so every environment running these migrations — Neon, and the
-- in-process PGlite the schema tests use — would have to have it installed, and
-- an extension that silently is not there yields a table where `A@b.com` and
-- `a@b.com` are two accounts. The CHECK is enforced by the same Postgres
-- everywhere and matches `tokens_email_lowercase` and `products_email_lowercase`,
-- which are unchanged.
--
-- ## 2. `verdicts`
--
-- `brief` Part 6 requires "a public permanent URL, shareable, works logged out",
-- carrying every deduction with its reason and juror, the cluster the product was
-- judged inside, which Floor personas picked it, and a timestamp plus a product
-- count. Part 7 makes the score log "the integrity record if anyone disputes a
-- ranking".
--
-- Every ingredient is already here in `score_rows`, `cluster_members`,
-- `demand_votes` and `rankings`, and rendering the page live off them is wrong
-- for one reason: `DECISIONS.md` §1.2 — every placement shifts every z-score. A
-- live-rendered verdict shows DIFFERENT NUMBERS after the next rebuild than it
-- did when it was delivered, so a link someone posted stops showing what they
-- were talking about, and the timestamp and product count `brief` Part 5 stamps
-- on the card — which exist precisely to say "this is what the board looked like
-- then" — become a lie. So the render is frozen at delivery, in `payload`.
--
-- This does NOT displace the raw rows. They stay the source of truth for
-- recomputation (`02 §7`), and `test/seed/real-boards.test.ts` still rebuilds
-- both boards from them alone. The two answer different questions: the raw rows
-- answer "is this ranking defensible", `verdicts` answers "what did we actually
-- say to this customer, on this day".
--
-- APPEND-ONLY, and that is the point. `DECISIONS.md` S8 is still OPEN — after a
-- re-pitch, does the shared URL show the new verdict, freeze at v1, redirect, or
-- 404? All four are implemented in `packages/payments/src/listing/repitch.ts`
-- behind a policy with no default. This table encodes none of them; it gives all
-- four the one thing they need and cannot recover later — the old row, still
-- there, still resolvable at its own slug. Trigger 5 below refuses UPDATE and
-- DELETE outright, the same posture `attempts` and delivered `jobs` already take.

-- 1. THE IDENTITY TABLE.
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_uk" UNIQUE("email"),
	CONSTRAINT "accounts_email_lowercase" CHECK ("accounts"."email" = lower("accounts"."email")),
	CONSTRAINT "accounts_email_shape" CHECK ("accounts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')
);
--> statement-breakpoint

-- 2. THE DELIVERED VERDICT.
CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_slug" text NOT NULL,
	"product_id" uuid NOT NULL,
	"job_id" uuid,
	"account_id" uuid,
	"attempt_number" integer,
	"payload" jsonb NOT NULL,
	"product_count" integer NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdicts_public_slug_uk" UNIQUE("public_slug"),
	CONSTRAINT "verdicts_one_per_job_uk" UNIQUE("job_id"),
	CONSTRAINT "verdicts_product_attempt_uk" UNIQUE("product_id","attempt_number"),
	CONSTRAINT "verdicts_attempt_number_positive" CHECK ("verdicts"."attempt_number" is null or "verdicts"."attempt_number" >= 1),
	CONSTRAINT "verdicts_product_count_positive" CHECK ("verdicts"."product_count" >= 1),
	CONSTRAINT "verdicts_public_slug_shape" CHECK ("verdicts"."public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("verdicts"."public_slug") between 12 and 128),
	CONSTRAINT "verdicts_payload_is_document" CHECK (jsonb_typeof("verdicts"."payload") = 'object'),
	CONSTRAINT "verdicts_paid_verdict_is_a_pitch" CHECK ("verdicts"."account_id" is null or ("verdicts"."job_id" is not null and "verdicts"."attempt_number" is not null))
);
--> statement-breakpoint

ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "verdicts_product_idx" ON "verdicts" USING btree ("product_id","delivered_at");--> statement-breakpoint
CREATE INDEX "verdicts_account_idx" ON "verdicts" USING btree ("account_id","delivered_at");--> statement-breakpoint

-- 3. `orders.account_email` AND `attempts.account_email` BECOME `account_id`.
--
-- Written as add / backfill / constrain / drop rather than as a bare drop-and-add
-- so it is correct on a database that already holds rows as well as on a fresh
-- one. On a fresh database every backfill statement selects nothing and the net
-- effect is the same two columns.
--
-- The account rows are created from the addresses the existing tables already
-- hold. `jobs.account_email` and `products.submitted_by_email` are included as
-- sources — they are NOT converted here, and are deliberately left alone (a job's
-- and a listing's payer are the submission surface's concern, not the ledger's) —
-- but an address that appears only on a job must still resolve to the same
-- account when that job's delivery is charged for.
ALTER TABLE "attempts" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "account_id" uuid;--> statement-breakpoint

INSERT INTO "accounts" ("email")
SELECT DISTINCT lower(email) FROM (
  SELECT account_email AS email FROM orders
  UNION SELECT account_email FROM attempts
  UNION SELECT account_email FROM jobs
  UNION SELECT submitted_by_email FROM products
) AS every_address
WHERE email IS NOT NULL
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint

UPDATE "orders" o SET account_id = a.id FROM "accounts" a WHERE a.email = o.account_email;--> statement-breakpoint

-- `attempts` is append-only: `attempts_immutable_trg` from `0001` refuses every
-- UPDATE, including this one. Disabling it for the length of the backfill is the
-- honest way to say what is happening — a schema change is rewriting the storage
-- of a row's identity, not editing its history. `delta`, `kind`, `idempotency_key`
-- and every foreign key stay exactly as they were, so no balance moves.
ALTER TABLE "attempts" DISABLE TRIGGER "attempts_immutable_trg";--> statement-breakpoint
UPDATE "attempts" t SET account_id = a.id FROM "accounts" a WHERE a.email = t.account_email;--> statement-breakpoint
ALTER TABLE "attempts" ENABLE TRIGGER "attempts_immutable_trg";--> statement-breakpoint

ALTER TABLE "attempts" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

-- 4. THE LEDGER'S OWN GUARDS FOLLOW THE KEY.
--
-- `attempts_no_overdraft` and `attempt_balance` from `0001` both fold the ledger
-- with `WHERE account_email = ...`. Left as they were, they would keep summing a
-- column that is about to be dropped. `CREATE OR REPLACE` keeps the trigger that
-- already points at the function; only the predicate changes.
CREATE OR REPLACE FUNCTION attempts_no_overdraft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance integer;
BEGIN
  SELECT COALESCE(SUM(a.delta), 0) INTO balance FROM attempts a WHERE a.account_id = NEW.account_id;

  IF balance < 0 THEN
    RAISE EXCEPTION
      'attempt ledger for account % would go to %, and a balance cannot be negative. An attempt must be granted by a paid order before it can be consumed.',
      NEW.account_id, balance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- One definition of "attempts remaining", now keyed on the account. The old
-- `attempt_balance(text)` is dropped rather than kept as an email-taking
-- overload: two functions that both claim to compute the balance is exactly the
-- second definition `0001` created this one to prevent.
DROP FUNCTION IF EXISTS attempt_balance(text);--> statement-breakpoint

CREATE FUNCTION attempt_balance(p_account_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(a.delta), 0)::integer FROM attempts a WHERE a.account_id = p_account_id;
$$;
--> statement-breakpoint

-- The old columns go last, so every statement above could still read them. The
-- indexes and CHECKs that named them (`orders_account_email_idx`,
-- `attempts_account_idx`, `orders_email_lowercase`, `attempts_email_lowercase`)
-- are dropped with them by Postgres; the replacements are created below.
ALTER TABLE "attempts" DROP COLUMN "account_email";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "account_email";--> statement-breakpoint
CREATE INDEX "orders_account_idx" ON "orders" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_account_idx" ON "attempts" USING btree ("account_id","created_at");--> statement-breakpoint

-- 5. A VERDICT IS NEVER REWRITTEN AND NEVER REMOVED.
--
-- UPDATE is refused because `brief` Part 6's URL is permanent: a shared link that
-- silently starts showing a different verdict is the failure `brief` Part 5 warns
-- about when it says never to promise a rank in copy, and it destroys the only
-- record of what the customer was actually shown.
--
-- DELETE is refused for the same sentence read the other way. "Permanent" is not
-- satisfied by a row that can be swept: three of `DECISIONS.md` S8's four
-- readings need the superseded row to survive — `archive` serves it, `redirect`
-- derives its target from it, and even `404` needs it as the dispute record — and
-- `planRepitch` states outright that BOTH of its arms retain the row. A schema
-- that allowed the delete would let a re-pitch quietly choose the one reading
-- that has not been decided on.
--
-- A re-pitch INSERTS. The old slug keeps resolving.
CREATE FUNCTION verdicts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'verdicts is append-only: % on verdict % is refused. A verdict is frozen at delivery because the board moves under it (DECISIONS.md 1.2) and its URL is permanent (brief Part 6). A re-pitch inserts a new row; the old slug keeps resolving.',
    TG_OP, COALESCE(OLD.public_slug, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER verdicts_immutable_trg
  BEFORE UPDATE OR DELETE ON verdicts
  FOR EACH ROW EXECUTE FUNCTION verdicts_immutable();
--> statement-breakpoint

-- 6. A VERDICT THAT NAMES A RUN NAMES A DELIVERED ONE.
--
-- The mirror of `attempts_consume_requires_delivery`. `brief §2.3` puts the
-- verdict write, the delivered flag and the attempt decrement in one transaction;
-- this is the same precondition applied to the first of the three, so a worker
-- cannot publish a permanent public page for a run that failed and is about to be
-- retried for free.
--
-- A CONSTRAINT trigger, DEFERRABLE INITIALLY DEFERRED, for the reason `0001`
-- gives and for one more that is specific to this table: `AttemptsLedger.deliver`
-- in `@the-pit/payments` deliberately calls `writeVerdict` BEFORE `markDelivered`
-- ("so an implementation that silently loses its transaction fails in the
-- direction that gives the customer a verdict they were not charged for"). An
-- immediate trigger would reject that ordering and force the payments package to
-- invert a sequence it chose on purpose. Judged at COMMIT, both rows exist.
--
-- `job_id IS NULL` is exempt: `brief` Part 7's cold-start boards were produced by
-- the engine's CLI before any job row existed, and their listings are "marked
-- clearly as unclaimed". Such a verdict has a public page and no run behind it.
CREATE FUNCTION verdicts_require_delivered_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivered timestamptz;
BEGIN
  IF NEW.job_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT j.delivered_at INTO delivered FROM jobs j WHERE j.id = NEW.job_id;

  IF delivered IS NULL THEN
    RAISE EXCEPTION
      'verdict % names job %, which has not been delivered. A verdict page is permanent and public (brief Part 6): set jobs.delivered_at in the same transaction that writes it.',
      NEW.public_slug, NEW.job_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER verdicts_require_delivered_job_trg
  AFTER INSERT ON verdicts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verdicts_require_delivered_job();
