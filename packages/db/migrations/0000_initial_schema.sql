CREATE TYPE "public"."attempt_kind" AS ENUM('grant', 'consume', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."category_type" AS ENUM('b2b', 'consumer', 'prosumer');--> statement-breakpoint
CREATE TYPE "public"."demand_pick" AS ENUM('first', 'second', 'none');--> statement-breakpoint
CREATE TYPE "public"."demand_status" AS ENUM('scored', 'solo_cluster');--> statement-breakpoint
CREATE TYPE "public"."injection_stage" AS ENUM('input', 'output');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('preview', 'placement', 'full_run', 'recalibration');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'held');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('paid', 'refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."product_source" AS ENUM('seeded', 'paid');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('pending', 'placed', 'held', 'rejected');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_email" text NOT NULL,
	"kind" "attempt_kind" NOT NULL,
	"delta" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid,
	"job_id" uuid,
	"product_id" uuid,
	"note" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_idempotency_key_uk" UNIQUE("idempotency_key"),
	CONSTRAINT "attempts_email_lowercase" CHECK ("attempts"."account_email" = lower("attempts"."account_email")),
	CONSTRAINT "attempts_delta_non_zero" CHECK ("attempts"."delta" <> 0),
	CONSTRAINT "attempts_kind_matches_delta" CHECK (("attempts"."kind" = 'grant' and "attempts"."delta" > 0)
          or ("attempts"."kind" = 'consume' and "attempts"."delta" = -1)
          or "attempts"."kind" = 'adjustment'),
	CONSTRAINT "attempts_grant_has_order" CHECK (("attempts"."kind" = 'grant') = ("attempts"."order_id" is not null)),
	CONSTRAINT "attempts_consume_has_job" CHECK (("attempts"."kind" = 'consume') = ("attempts"."job_id" is not null)),
	CONSTRAINT "attempts_adjustment_has_reason" CHECK (("attempts"."kind" = 'adjustment') = ("attempts"."actor" is not null and "attempts"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "category_type" NOT NULL,
	"prompt_version" text NOT NULL,
	"persona_version" text NOT NULL,
	"category_snapshot_version" text NOT NULL,
	"snapshot_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_uk" UNIQUE("slug"),
	CONSTRAINT "categories_name_uk" UNIQUE("name"),
	CONSTRAINT "categories_slug_shape" CHECK ("categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "cluster_members" (
	"cluster_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"uniqueness_score" integer NOT NULL,
	"reason" text NOT NULL,
	"uniqueness_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_members_pk" PRIMARY KEY("cluster_id","product_id"),
	CONSTRAINT "cluster_members_one_cluster_per_pass_uk" UNIQUE("product_id","uniqueness_version"),
	CONSTRAINT "cluster_members_uniqueness_range" CHECK ("cluster_members"."uniqueness_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"cluster_key" text NOT NULL,
	"label" text NOT NULL,
	"uniqueness_version" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clusters_category_key_uk" UNIQUE("category_id","cluster_key","uniqueness_version"),
	CONSTRAINT "clusters_id_category_uk" UNIQUE("id","category_id"),
	CONSTRAINT "clusters_label_limit" CHECK (char_length("clusters"."label") between 1 and 60),
	CONSTRAINT "clusters_key_limit" CHECK (char_length("clusters"."cluster_key") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "demand_votes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "demand_votes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"product_id" uuid,
	"persona_name" text NOT NULL,
	"pick" "demand_pick" NOT NULL,
	"strength" integer,
	"reason" text NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"persona_version" text NOT NULL,
	"uniqueness_version" text NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_votes_one_per_slot_uk" UNIQUE("cluster_id","persona_name","pick","persona_version"),
	CONSTRAINT "demand_votes_none_has_no_product" CHECK (("demand_votes"."pick" = 'none') = ("demand_votes"."product_id" is null)),
	CONSTRAINT "demand_votes_strength_only_on_first" CHECK ("demand_votes"."pick" = 'first' or "demand_votes"."strength" is null),
	CONSTRAINT "demand_votes_strength_range" CHECK ("demand_votes"."strength" is null or "demand_votes"."strength" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "flagged_injections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "flagged_injections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"stage" "injection_stage" NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"matched" text NOT NULL,
	"category_id" uuid,
	"product_id" uuid,
	"cluster_id" uuid,
	"job_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flagged_injections_reviewer_recorded" CHECK (("flagged_injections"."reviewed_at" is null) = ("flagged_injections"."reviewed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" NOT NULL,
	"category_id" uuid NOT NULL,
	"product_id" uuid,
	"account_email" text,
	"idempotency_key" text,
	"prompt_version" text NOT NULL,
	"persona_version" text NOT NULL,
	"category_snapshot_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"phases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"failure_code" text,
	"retryable" boolean,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "jobs_idempotency_key_uk" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_retry_count_cap" CHECK ("jobs"."retry_count" between 0 and 3),
	CONSTRAINT "jobs_cost_non_negative" CHECK ("jobs"."cost_cents" >= 0),
	CONSTRAINT "jobs_email_lowercase" CHECK ("jobs"."account_email" is null or "jobs"."account_email" = lower("jobs"."account_email")),
	CONSTRAINT "jobs_delivered_only_when_succeeded" CHECK ("jobs"."delivered_at" is null or "jobs"."status" = 'succeeded'),
	CONSTRAINT "jobs_preview_has_no_product" CHECK ("jobs"."kind" <> 'preview' or "jobs"."product_id" is null),
	CONSTRAINT "jobs_placement_has_product_and_account" CHECK ("jobs"."kind" <> 'placement' or ("jobs"."product_id" is not null and "jobs"."account_email" is not null))
);
--> statement-breakpoint
CREATE TABLE "jury_versions" (
	"category_id" uuid NOT NULL,
	"version" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"jurors" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jury_versions_pk" PRIMARY KEY("category_id","version"),
	CONSTRAINT "jury_versions_metrics_count" CHECK (jsonb_array_length("jury_versions"."metrics") between 3 and 6),
	CONSTRAINT "jury_versions_jurors_count" CHECK (jsonb_array_length("jury_versions"."jurors") = 6)
);
--> statement-breakpoint
CREATE TABLE "mob_votes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mob_votes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"product_id" uuid,
	"pick" "demand_pick" NOT NULL,
	"strength" integer,
	"reason" text,
	"voter_id" text NOT NULL,
	"voter_ip_hash" text,
	"uniqueness_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mob_votes_one_per_slot_uk" UNIQUE("cluster_id","voter_id","pick","uniqueness_version"),
	CONSTRAINT "mob_votes_none_has_no_product" CHECK (("mob_votes"."pick" = 'none') = ("mob_votes"."product_id" is null)),
	CONSTRAINT "mob_votes_strength_only_on_first" CHECK ("mob_votes"."pick" = 'first' or "mob_votes"."strength" is null),
	CONSTRAINT "mob_votes_strength_range" CHECK ("mob_votes"."strength" is null or "mob_votes"."strength" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'dodo' NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_payment_id" text,
	"account_email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"attempts_granted" integer NOT NULL,
	"includes_fit_report" boolean DEFAULT false NOT NULL,
	"status" "order_status" NOT NULL,
	"raw_event" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_provider_event_uk" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "orders_amount_positive" CHECK ("orders"."amount_cents" > 0),
	CONSTRAINT "orders_attempts_granted_non_negative" CHECK ("orders"."attempts_granted" >= 0),
	CONSTRAINT "orders_currency_shape" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_email_lowercase" CHECK ("orders"."account_email" = lower("orders"."account_email")),
	CONSTRAINT "orders_grants_only_when_paid" CHECK ("orders"."status" = 'paid' or "orders"."attempts_granted" = 0),
	CONSTRAINT "orders_grant_names_payment" CHECK ("orders"."attempts_granted" = 0 or "orders"."provider_payment_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "persona_versions" (
	"category_id" uuid NOT NULL,
	"version" text NOT NULL,
	"personas" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_versions_pk" PRIMARY KEY("category_id","version"),
	CONSTRAINT "persona_versions_personas_count" CHECK (jsonb_array_length("persona_versions"."personas") between 4 and 8)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"engine_id" integer NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"description" text NOT NULL,
	"description_hash" text NOT NULL,
	"source" "product_source" NOT NULL,
	"status" "product_status" NOT NULL,
	"submitted_by_email" text,
	"opted_out_at" timestamp with time zone,
	"placed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_category_engine_id_uk" UNIQUE("category_id","engine_id"),
	CONSTRAINT "products_id_category_uk" UNIQUE("id","category_id"),
	CONSTRAINT "products_engine_id_non_negative" CHECK ("products"."engine_id" >= 0),
	CONSTRAINT "products_description_limit" CHECK (char_length("products"."description") between 1 and 300),
	CONSTRAINT "products_description_hash_shape" CHECK ("products"."description_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "products_normalized_url_shape" CHECK ("products"."normalized_url" = lower("products"."normalized_url") and "products"."normalized_url" !~ '^[a-z][a-z0-9+.-]*:'),
	CONSTRAINT "products_email_lowercase" CHECK ("products"."submitted_by_email" is null or "products"."submitted_by_email" = lower("products"."submitted_by_email")),
	CONSTRAINT "products_source_submitter" CHECK (("products"."source" = 'seeded' and "products"."submitted_by_email" is null) or ("products"."source" = 'paid' and "products"."submitted_by_email" is not null)),
	CONSTRAINT "products_placed_at_matches_status" CHECK (("products"."status" = 'placed') = ("products"."placed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "rankings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rankings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"snapshot_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"composite" double precision NOT NULL,
	"demand" double precision,
	"demand_status" "demand_status" NOT NULL,
	"core" double precision NOT NULL,
	"tiebroken" boolean NOT NULL,
	"cluster_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rankings_snapshot_product_uk" UNIQUE("snapshot_id","product_id"),
	CONSTRAINT "rankings_snapshot_rank_uk" UNIQUE("snapshot_id","rank"),
	CONSTRAINT "rankings_rank_positive" CHECK ("rankings"."rank" >= 1),
	CONSTRAINT "rankings_demand_matches_status" CHECK (("rankings"."demand_status" = 'scored') = ("rankings"."demand" is not null))
);
--> statement-breakpoint
CREATE TABLE "score_rows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "score_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"juror_role" text NOT NULL,
	"metric" text NOT NULL,
	"score" integer NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_rows_cell_uk" UNIQUE("product_id","juror_role","metric","prompt_version"),
	CONSTRAINT "score_rows_score_range" CHECK ("score_rows"."score" between 0 and 100),
	CONSTRAINT "score_rows_deductions_is_array" CHECK (jsonb_typeof("score_rows"."deductions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"category_snapshot_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"persona_version" text NOT NULL,
	"uniqueness_version" text NOT NULL,
	"product_count" integer NOT NULL,
	"document" jsonb NOT NULL,
	"health" jsonb NOT NULL,
	"url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_category_version_uk" UNIQUE("category_id","category_snapshot_version"),
	CONSTRAINT "snapshots_id_category_uk" UNIQUE("id","category_id"),
	CONSTRAINT "snapshots_product_count_non_negative" CHECK ("snapshots"."product_count" >= 0),
	CONSTRAINT "snapshots_url_only_when_published" CHECK (("snapshots"."url" is null) = ("snapshots"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_hash_is_sha256_hex" CHECK ("tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tokens_email_lowercase" CHECK ("tokens"."email" = lower("tokens"."email")),
	CONSTRAINT "tokens_expiry_after_creation" CHECK ("tokens"."expires_at" > "tokens"."created_at"),
	CONSTRAINT "tokens_used_after_creation" CHECK ("tokens"."used_at" is null or "tokens"."used_at" >= "tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cluster_members" ADD CONSTRAINT "cluster_members_cluster_fk" FOREIGN KEY ("cluster_id","category_id") REFERENCES "public"."clusters"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cluster_members" ADD CONSTRAINT "cluster_members_product_fk" FOREIGN KEY ("product_id","category_id") REFERENCES "public"."products"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "demand_votes" ADD CONSTRAINT "demand_votes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "demand_votes" ADD CONSTRAINT "demand_votes_cluster_fk" FOREIGN KEY ("cluster_id","category_id") REFERENCES "public"."clusters"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "demand_votes" ADD CONSTRAINT "demand_votes_product_fk" FOREIGN KEY ("product_id","category_id") REFERENCES "public"."products"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flagged_injections" ADD CONSTRAINT "flagged_injections_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flagged_injections" ADD CONSTRAINT "flagged_injections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flagged_injections" ADD CONSTRAINT "flagged_injections_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flagged_injections" ADD CONSTRAINT "flagged_injections_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "jury_versions" ADD CONSTRAINT "jury_versions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "mob_votes" ADD CONSTRAINT "mob_votes_cluster_fk" FOREIGN KEY ("cluster_id","category_id") REFERENCES "public"."clusters"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "mob_votes" ADD CONSTRAINT "mob_votes_product_fk" FOREIGN KEY ("product_id","category_id") REFERENCES "public"."products"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "persona_versions" ADD CONSTRAINT "persona_versions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_snapshot_fk" FOREIGN KEY ("snapshot_id","category_id") REFERENCES "public"."snapshots"("id","category_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_product_fk" FOREIGN KEY ("product_id","category_id") REFERENCES "public"."products"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "score_rows" ADD CONSTRAINT "score_rows_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "score_rows" ADD CONSTRAINT "score_rows_product_fk" FOREIGN KEY ("product_id","category_id") REFERENCES "public"."products"("id","category_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_consume_per_job_uk" ON "attempts" USING btree ("job_id") WHERE kind = 'consume';--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_grant_per_order_uk" ON "attempts" USING btree ("order_id") WHERE kind = 'grant';--> statement-breakpoint
CREATE INDEX "attempts_account_idx" ON "attempts" USING btree ("account_email","created_at");--> statement-breakpoint
CREATE INDEX "attempts_order_idx" ON "attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "cluster_members_category_idx" ON "cluster_members" USING btree ("category_id","uniqueness_version");--> statement-breakpoint
CREATE INDEX "clusters_category_idx" ON "clusters" USING btree ("category_id","uniqueness_version");--> statement-breakpoint
CREATE INDEX "demand_votes_category_idx" ON "demand_votes" USING btree ("category_id","persona_version");--> statement-breakpoint
CREATE INDEX "demand_votes_product_idx" ON "demand_votes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "demand_votes_cluster_idx" ON "demand_votes" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "flagged_injections_stage_idx" ON "flagged_injections" USING btree ("stage","reviewed_at","created_at");--> statement-breakpoint
CREATE INDEX "flagged_injections_category_idx" ON "flagged_injections" USING btree ("category_id","created_at");--> statement-breakpoint
CREATE INDEX "flagged_injections_product_idx" ON "flagged_injections" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "jobs_category_status_idx" ON "jobs" USING btree ("category_id","status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_account_email_idx" ON "jobs" USING btree ("account_email","created_at");--> statement-breakpoint
CREATE INDEX "jobs_product_idx" ON "jobs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "mob_votes_cluster_idx" ON "mob_votes" USING btree ("cluster_id","created_at");--> statement-breakpoint
CREATE INDEX "mob_votes_product_idx" ON "mob_votes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "mob_votes_voter_idx" ON "mob_votes" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_grant_uk" ON "orders" USING btree ("provider","provider_payment_id") WHERE attempts_granted > 0;--> statement-breakpoint
CREATE INDEX "orders_account_email_idx" ON "orders" USING btree ("account_email","created_at");--> statement-breakpoint
CREATE INDEX "orders_payment_idx" ON "orders" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "products_normalized_url_idx" ON "products" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX "products_description_hash_idx" ON "products" USING btree ("category_id","description_hash");--> statement-breakpoint
CREATE INDEX "products_category_status_idx" ON "products" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "products_submitted_by_email_idx" ON "products" USING btree ("submitted_by_email");--> statement-breakpoint
CREATE INDEX "rankings_snapshot_rank_idx" ON "rankings" USING btree ("snapshot_id","rank");--> statement-breakpoint
CREATE INDEX "rankings_product_idx" ON "rankings" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "score_rows_category_idx" ON "score_rows" USING btree ("category_id","prompt_version");--> statement-breakpoint
CREATE INDEX "score_rows_product_idx" ON "score_rows" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "snapshots_category_created_idx" ON "snapshots" USING btree ("category_id","created_at");--> statement-breakpoint
CREATE INDEX "snapshots_prompt_version_idx" ON "snapshots" USING btree ("category_id","prompt_version");--> statement-breakpoint
CREATE INDEX "tokens_email_idx" ON "tokens" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "tokens_expires_at_idx" ON "tokens" USING btree ("expires_at");