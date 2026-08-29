-- Verdicts are append-only.
--
-- `the-pit-build-brief.md` Part 6 makes the verdict page "a public permanent URL,
-- shareable, works logged out", and Part 7 calls the score log "the integrity
-- record if anyone disputes a ranking". `§2.4` then has a re-pitch replace the
-- previous listing, and `DECISIONS.md` S8 is still OPEN on what a shared verdict
-- URL should show afterwards — the new verdict, the frozen original with a
-- banner, or a 404 — and on whether a re-pitched product keeps its old cluster.
--
-- Every one of those readings requires the same thing of storage: a re-pitch
-- writes NEW rows and the old ones stay addressable. An UPDATE in place destroys
-- both the thing a customer shared and the evidence that defends the ranking,
-- and it forecloses three of the four readings before S8 is even decided. So the
-- decision stays open at the call site (`packages/payments/src/repitch.ts`) and
-- the database simply refuses to overwrite.
--
-- Three surfaces carry a verdict, and each is frozen at the point it becomes one:
--
--   jobs      the delivered payload and its permanent URL  -> frozen on delivery
--   snapshots the board a verdict card is stamped against  -> body frozen at insert
--   rankings  the rows of that board                       -> never updated
--   products  the text that was scored                     -> scored identity frozen
--
-- What stays mutable is deliberate and is listed with each trigger. These are
-- triggers rather than column constraints because every one of them compares NEW
-- against OLD, which a CHECK cannot see.

-- 1. A DELIVERED JOB IS FROZEN.
--
-- `brief` §2.3 makes `delivered_at` the money event: it is the precondition the
-- attempt ledger checks before it will accept a decrement. A row that can be
-- re-delivered by an UPDATE could be charged for twice under two different
-- verdicts, and the customer's shared link would silently start showing the
-- second one.
--
-- A re-pitch is a new job. It has its own id, its own versions, and its own URL.
CREATE FUNCTION jobs_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION
      'job % was delivered at % and is frozen: a verdict URL is permanent (brief Part 6). A re-pitch writes a new job.',
      OLD.id, OLD.delivered_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER jobs_delivery_immutable_trg
  BEFORE UPDATE OR DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_delivery_immutable();
--> statement-breakpoint

-- 2. A SNAPSHOT'S BODY IS FROZEN; PUBLISHING IT IS NOT.
--
-- `brief` Part 3: "keep old snapshots permanently addressable at dated URLs so
-- issued verdict cards still resolve." A verdict card is stamped with a timestamp
-- and a product count (`brief` Part 5) precisely because the board moves; editing
-- the board those numbers refer to makes the stamp a lie.
--
-- The one legal transition is publication — `url` and `published_at` going from
-- NULL to a value, once. Un-publishing, re-pointing, or editing the document is
-- refused. A rebuilt board is a new snapshot under a new
-- `category_snapshot_version`, which is what `brief` §1.3's cache key assumes.
CREATE FUNCTION snapshots_body_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.health IS DISTINCT FROM OLD.health
     OR NEW.product_count IS DISTINCT FROM OLD.product_count
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.category_snapshot_version IS DISTINCT FROM OLD.category_snapshot_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.persona_version IS DISTINCT FROM OLD.persona_version
     OR NEW.uniqueness_version IS DISTINCT FROM OLD.uniqueness_version
  THEN
    RAISE EXCEPTION
      'snapshot % is immutable: a published board must stay addressable as issued (brief Part 3). Write a new snapshot under a new category_snapshot_version.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.published_at IS NOT NULL AND (NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.url IS DISTINCT FROM OLD.url) THEN
    RAISE EXCEPTION
      'snapshot % was published at % and its URL cannot move: issued verdict cards resolve through it.',
      OLD.id, OLD.published_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER snapshots_body_immutable_trg
  BEFORE UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION snapshots_body_immutable();
--> statement-breakpoint

-- 3. A RANKING ROW IS NEVER EDITED.
--
-- `rankings` is derived and rebuildable, so DELETE stays legal — a rebuild drops
-- the snapshot and its rows cascade. What is not legal is moving a product's rank
-- on a board that has already been published, which is an edit to history rather
-- than a recomputation.
CREATE FUNCTION rankings_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'rankings rows are not updated: a board is rebuilt as a new snapshot, never edited in place (brief 1.2 — every z-score moves on a placement).'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER rankings_immutable_trg
  BEFORE UPDATE ON rankings
  FOR EACH ROW EXECUTE FUNCTION rankings_immutable();
--> statement-breakpoint

-- 4. THE TEXT THAT WAS SCORED IS FROZEN.
--
-- `score_rows` are keyed to a product, and they are the integrity record. If a
-- re-pitch overwrote `description` in place, every stored deduction would still
-- name that product while the sentence the juror was actually deducting from had
-- been replaced — the ranking would be indefensible in exactly the dispute
-- `brief` Part 7 anticipates. `§2.4` also requires "materially changed
-- description text" on a re-pitch, which is only checkable against an original
-- that still exists.
--
-- So the SCORED IDENTITY is frozen: the text, its hash, the URL and its
-- normalized form, the category, and the engine id every raw row joins on. A
-- re-pitch inserts a new product row.
--
-- The LIFECYCLE stays mutable: `status`, `placed_at`, `opted_out_at` (`brief`
-- Part 7's one-click opt-out for seeded listings), `submitted_by_email` and
-- `updated_at`. Those describe what has happened to the listing, not what was
-- judged.
CREATE FUNCTION products_scored_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.description IS DISTINCT FROM OLD.description
     OR NEW.description_hash IS DISTINCT FROM OLD.description_hash
     OR NEW.url IS DISTINCT FROM OLD.url
     OR NEW.normalized_url IS DISTINCT FROM OLD.normalized_url
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.engine_id IS DISTINCT FROM OLD.engine_id
  THEN
    RAISE EXCEPTION
      'product % has been scored and its pitch is frozen: the score log is the integrity record (brief Part 7). A re-pitch inserts a new product row.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER products_scored_identity_immutable_trg
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_scored_identity_immutable();
