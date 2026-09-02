-- The free first throw, counted somewhere it cannot be forgotten.
--
-- A run is twelve juror calls, a clustering pass and a persona round, and
-- `brief §2.3` prices that at $5 for everyone who is not on this table. A free
-- first throw is only survivable because a person gets exactly one — and "exactly
-- one" is a claim about STATE, which has to be durable or it is not a claim at
-- all.
--
-- `packages/auth`'s `MemoryRateLimiter` already wrote the reason it cannot be a
-- process: on Vercel "every serverless invocation may be a fresh instance and the
-- map is empty again". A per-instance limiter on the free door is not a weak
-- defence, it is no defence, and it fails invisibly — the offer keeps working,
-- the map keeps being empty, and the only signal is the bill.
--
-- ## What is stored, and what deliberately is not
--
-- Every request carries an email and a client address. Both are personal data we
-- have no use for after the check, and what the rules actually need from them is
-- EQUALITY: has this address run before, how many requests from this address in
-- the last hour. Equality survives a keyed hash intact.
--
-- So `email_key_hash` and `ip_hash` are HMAC-SHA256 digests under
-- `SESSION_SECRET`, and the two shape checks below are what makes that a property
-- of the DATABASE rather than a habit of the current caller. `schema/auth.ts`
-- takes the same position about `tokens.token_hash`, in the same words: a table
-- with nowhere to put a raw value cannot leak one in a backup, a log line or a
-- `SELECT *`. 64 lowercase hex characters is what a digest looks like and what an
-- email address, an IPv4 address and an IPv6 address all are not.
--
-- HMAC rather than a bare SHA-256 because the input space is tiny — the whole of
-- IPv4 and any plausible list of addresses are both walkable in minutes against
-- an unkeyed digest, which would make a dump of this table a dump of its people.
-- The key is `SESSION_SECRET` rather than a new secret so a deployment has one
-- fewer thing to fail to configure; `apps/web/src/lib/free/policy.ts` tries every
-- secret in the keyring on read, so a rotation does not amnesty everybody who has
-- already had their throw.
--
-- `normalized_url` is stored PLAIN. It is the public identity of a product on a
-- public board, `products.normalized_url` already holds it in the clear, and
-- hashing it would buy nothing while making "has this product had its free
-- throw" unanswerable by a human reading the table.
--
-- ## Append-only, like the other ledgers
--
-- `0001_ledger_guards.sql` says it about `attempts` and it is exactly as true
-- here: without this the table is a mutable counter with extra steps. One UPDATE
-- to a `created_at` slides the hourly window for free; one DELETE and a URL, an
-- address or the whole daily cap is available again, with nothing left to say it
-- happened. A mistake is corrected by a migration somebody reviewed, not by an
-- UPDATE nobody sees.
--
-- Forward only, per `cli/migrate.ts`.

CREATE TABLE "free_run_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- The draft the throw was granted for. `restrict` on delete because this row
  -- is evidence, and evidence a cascade can remove is not evidence.
  "submission_id" uuid NOT NULL,

  -- HMAC-SHA256 of the FOLDED email key: `a.b+tag@gmail.com` and `ab@gmail.com`
  -- are one inbox, and a rule that treated them as two people would be a rule
  -- anybody could switch off by typing a `+`. The folding lives in
  -- `apps/web/src/lib/free/policy.ts`; this column stores only its answer.
  "email_key_hash" text NOT NULL,

  -- HMAC-SHA256 of the client address, or NULL when there was none to read.
  -- Nullable and not a hash of the string 'unknown': "this request had no
  -- address" is a different fact, and the IP window skips it rather than lumping
  -- every unidentifiable request into one bucket.
  "ip_hash" text,

  -- `brief §2.5`'s key, resolved — the same value `submissions.normalized_url`
  -- and `products.normalized_url` hold, under the same shape rule.
  "normalized_url" text NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "free_run_requests" ADD CONSTRAINT "free_run_requests_submission_id_submissions_id_fk"
  FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id")
  ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint

-- One submission is one throw. `record` inserts `on conflict do nothing`, so a
-- handler whose request was delivered twice writes one row rather than raising.
ALTER TABLE "free_run_requests" ADD CONSTRAINT "free_run_requests_submission_uk"
  UNIQUE ("submission_id");
--> statement-breakpoint

-- THE TWO COLUMNS THAT MAKE THIS TABLE SAFE TO HOLD.
--
-- Not advice to the caller: there is no code path, no fixture and no admin script
-- that can put an address in either of these.
ALTER TABLE "free_run_requests" ADD CONSTRAINT "free_run_requests_email_key_is_hmac_hex"
  CHECK ("email_key_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

ALTER TABLE "free_run_requests" ADD CONSTRAINT "free_run_requests_ip_is_hmac_hex"
  CHECK ("ip_hash" IS NULL OR "ip_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

-- The same shape `submissions_normalized_url_shape` pins: lowercased, and no
-- scheme. A row holding `https://Example.com/` would never match the key the
-- guards compute, and the miss would look exactly like a first-time visitor.
ALTER TABLE "free_run_requests" ADD CONSTRAINT "free_run_requests_normalized_url_shape"
  CHECK ("normalized_url" = lower("normalized_url") AND "normalized_url" !~ '^[a-z][a-z0-9+.-]*:');
--> statement-breakpoint

-- One index per rule, so each of the five questions is answered by a lookup
-- rather than by reading the table. `created_at` rides along on the first three
-- because two of them are windowed and the other two order by it.
CREATE INDEX "free_run_requests_normalized_url_idx"
  ON "free_run_requests" USING btree ("normalized_url","created_at");
--> statement-breakpoint

CREATE INDEX "free_run_requests_email_key_idx"
  ON "free_run_requests" USING btree ("email_key_hash","created_at");
--> statement-breakpoint

CREATE INDEX "free_run_requests_ip_idx"
  ON "free_run_requests" USING btree ("ip_hash","created_at");
--> statement-breakpoint

CREATE INDEX "free_run_requests_created_at_idx"
  ON "free_run_requests" USING btree ("created_at");
--> statement-breakpoint

-- APPEND-ONLY.
--
-- The same guard, and the same argument, as `attempts_immutable` in
-- `0001_ledger_guards.sql`. Every one of the five rules is a count over rows that
-- already exist, so an UPDATE or a DELETE here does not corrupt a record — it
-- hands somebody another free run and leaves nothing behind that says so.
CREATE FUNCTION free_run_requests_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'free_run_requests is append-only: % on free run % is refused. Every rule on the free door is a count over these rows, so editing one hands out a run that nothing records.',
    TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER free_run_requests_immutable_trg
  BEFORE UPDATE OR DELETE ON free_run_requests
  FOR EACH ROW EXECUTE FUNCTION free_run_requests_immutable();
