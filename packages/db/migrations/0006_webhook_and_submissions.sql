-- The two rows the Dodo webhook needs that no existing table can hold.
--
-- `brief §2.2` puts every attempt in the product behind one signed webhook, and
-- `packages/payments` implements the whole of that handler. Wiring it up found
-- two gaps in this schema, and neither is a preference:
--
--   1. `handleDodoWebhook` calls `WebhookStore.recordEvent` for every event it is
--      NOT going to grant on — a refund, a dispute, a failed payment, an amount
--      we refuse to price — and it calls it BEFORE `ensureAccount`, because
--      resolving an account for a payment that did not succeed would be creating
--      an account for a payment that did not succeed. `orders.account_id` is NOT
--      NULL. There is nowhere to put those events. -> `webhook_events`.
--
--   2. `pit/placement.requested` carries a `Product`, which needs a name and a
--      300-character description. Dodo's metadata is a small string map, and
--      `@the-pit/payments`' `checkout/session.ts` already says the draft must be
--      written to our own storage before checkout opens with only its id
--      crossing. `products` cannot hold it: `products_source_submitter` requires
--      a paid row to name its submitter, and under guest checkout (`brief §2.1`)
--      the payer's address does not exist until the webhook arrives.
--      -> `submissions`.
--
-- Additive. `0000`-`0005` are untouched, nothing is dropped and nothing is
-- rewritten, so a fresh database and an existing one reach the same end state.

-- ---------------------------------------------------------------------------
-- 1. WEBHOOK EVENTS — the log behind the endpoint that creates money.
--
-- `orders` records every payment event that GRANTS and its
-- `(provider, provider_event_id)` unique is the idempotency constraint
-- `brief §2.2` names. This records every event we merely SAW, keyed to nothing
-- but the provider's own event id, and it exists for three things in ascending
-- order of what getting them wrong costs:
--
--   * Not filing the same ticket twice. `brief §2.2` prices a dispute at $30 and
--     Dodo retries. `handleDodoWebhook` calls `queueForReview` only when
--     `recordEvent` answered `recorded`, so the UNIQUE below is the entire reason
--     a redelivered dispute is silent.
--   * Arguing a dispute. `payload` is the verified event; `orders.raw_event`
--     holds the same for events that granted, and a chargeback argument is about
--     the ones that did not.
--   * Explaining a balance. `outcome` records what the handler decided, so "why
--     did this $5 not become an attempt" is one row rather than a log search.
--
-- IT IS NOT THE IDEMPOTENCY GUARD FOR GRANTS. `packages/payments`'
-- `checkout/webhook.ts` is explicit: if it were, a crash between recording the
-- event and appending the grant would lose a customer's attempts permanently,
-- because the retry would see the recorded id and skip. The guard is
-- `attempts_idempotency_key_uk` plus `orders_provider_event_uk` and
-- `orders_payment_grant_uk`. This table is written last and is allowed to fail.
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'dodo' NOT NULL,
	"provider_event_id" text NOT NULL,

	-- `text`, not an enum, and deliberately. This column records what a THIRD
	-- PARTY sent us. An event type we have never seen is exactly what the log
	-- needs to be able to hold; an enum would turn a stranger's new vocabulary
	-- into a failed INSERT on the money path.
	"type" text NOT NULL,

	-- What the handler decided: granted / duplicate / unpriced / not_a_grant.
	"outcome" text NOT NULL,

	-- Why a human has to look. Set by `queueForReview`, which runs at most once
	-- per event because `recordEvent` reports `duplicate` on every retry.
	"review_reason" text,
	"reviewed_at" timestamp with time zone,

	-- The verified event as parsed. Null until something asks for a review.
	"payload" jsonb,

	"received_at" timestamp with time zone DEFAULT now() NOT NULL,

	-- One row per provider event. This is what makes a retried dispute file one
	-- ticket instead of one per delivery.
	CONSTRAINT "webhook_events_provider_event_uk" UNIQUE("provider","provider_event_id"),

	-- Matches `account_identities_provider_shape`, so the two spellings of
	-- "dodo" can never diverge into two keyspaces.
	CONSTRAINT "webhook_events_provider_shape" CHECK ("webhook_events"."provider" ~ '^[a-z][a-z0-9_]{1,31}$'),

	-- An empty event id would make the UNIQUE above protect nothing.
	CONSTRAINT "webhook_events_event_id_present" CHECK (char_length("webhook_events"."provider_event_id") between 1 and 255),

	-- A resolved row must say what it was resolved FROM, or a row marked reviewed
	-- that was never queued reads later as a dispute somebody handled.
	CONSTRAINT "webhook_events_reviewed_implies_queued" CHECK ("webhook_events"."reviewed_at" is null or "webhook_events"."review_reason" is not null)
);
--> statement-breakpoint

-- "What is waiting for a human" — the only query the review queue makes.
CREATE INDEX "webhook_events_review_idx" ON "webhook_events" USING btree ("reviewed_at","received_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. SUBMISSIONS — the pitch, written down before the buyer leaves for Dodo.
--
-- Guest checkout (`brief §2.1`) means the buyer types a URL, a name and a
-- description and pays, with nothing in between. The description is up to 300
-- characters (`DECISIONS.md` S5) and Dodo's metadata is a small string map, so
-- the draft stays on our side and only this row's id makes the round trip.
--
-- Nothing in this table is authoritative. Every column is attacker-supplied text
-- that passed `checkSubmission` once, before payment; `brief §2.4` requires the
-- same check again before enqueue, because the board moves in between — a
-- nightly rebuild may have closed the cycle, another pitch may have landed. So
-- the row stores what was typed and the values the second check re-derives, and
-- never a clearance: `SubmissionClearance` is branded in `@the-pit/payments`
-- precisely so it cannot be persisted and read back as proof of anything.
CREATE TABLE "submissions" (
	-- A uuid and not a sequence: this id is handed to a third party and returned
	-- by a client, so it must be unguessable and must not count our sales.
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

	-- By SLUG rather than by `categories.id`, and not because a foreign key would
	-- be hard. `DECISIONS.md` S12 runs the classifier before payment and may
	-- reject the chosen category, and a draft whose category was later retired
	-- must still be readable for support. The slug is also what
	-- `pit/placement.requested` carries and what the pipeline resolves.
	"category_slug" text NOT NULL,

	"name" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"description" text NOT NULL,
	"description_hash" text NOT NULL,

	-- The recalibration cycle the pre-payment check ran in. `jobIdempotencyKey`
	-- includes it, which is what makes an identical re-pitch after the next
	-- rebuild a genuinely different submission rather than a silent no-op
	-- resolving to the first job (`brief §2.4`).
	"cycle_id" text NOT NULL,

	"tier" text NOT NULL,
	"attempt_number" integer NOT NULL,

	-- The listing this pitch replaces, or null on a first pitch.
	"repitch_of" uuid,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,

	-- The same limits `products` enforces, applied to the row that becomes one,
	-- so a draft cannot be accepted here and rejected there after the money moved.
	CONSTRAINT "submissions_description_limit" CHECK (char_length("submissions"."description") between 1 and 300),
	CONSTRAINT "submissions_name_present" CHECK (char_length("submissions"."name") between 1 and 200),
	CONSTRAINT "submissions_description_hash_shape" CHECK ("submissions"."description_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submissions_normalized_url_shape" CHECK ("submissions"."normalized_url" = lower("submissions"."normalized_url") and "submissions"."normalized_url" !~ '^[a-z][a-z0-9+.-]*:'),

	-- `brief §2.3` closes the tier table at two, and gives the reason: $5 stays
	-- the atomic unit so "same five dollars for everyone" is literally true. A
	-- third tier is a pricing decision and should arrive as a reviewed migration,
	-- not as a string nothing recognises.
	CONSTRAINT "submissions_tier_known" CHECK ("submissions"."tier" in ('single', 'triple')),

	CONSTRAINT "submissions_attempt_number_positive" CHECK ("submissions"."attempt_number" >= 1)
);
--> statement-breakpoint

-- `restrict`, like every other product-adjacent foreign key here: the draft is
-- part of the record of what someone bought, and a cascade would take it with the
-- listing it replaced.
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_repitch_of_products_id_fk" FOREIGN KEY ("repitch_of") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

-- Support's query: "what was submitted for this URL, and when".
CREATE INDEX "submissions_normalized_url_idx" ON "submissions" USING btree ("normalized_url","created_at");
