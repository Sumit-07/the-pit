-- `products.normalized_url` is a DERIVED KEY, not part of the scored identity.
--
-- `0002_append_only_guards.sql` froze seven columns on a product row under one
-- justification, quoted here in full because this migration narrows it:
--
--   "`score_rows` are keyed to a product, and they are the integrity record. If a
--    re-pitch overwrote `description` in place, every stored deduction would
--    still name that product while the sentence the juror was actually deducting
--    from had been replaced — the ranking would be indefensible in exactly the
--    dispute `brief` Part 7 anticipates."
--
-- That argument is correct, and it does not reach `normalized_url`.
--
-- No juror sees it. Nothing quotes it. `score_rows`, `cluster_members`,
-- `demand_votes` and `rankings` all join on `product_id` and `engine_id`;
-- `verdicts.payload` does not contain it. It is read by exactly one query —
-- `listing-store.ts`'s `findByNormalizedUrl`, over
-- `products_normalized_url_idx` — and that query exists to serve one rule,
-- `brief §2.4`'s per-product submission cap.
--
-- It is also, uniquely among the seven, a value nobody submitted. `url` is what
-- the visitor typed and it stays frozen below; `normalized_url` is a FUNCTION of
-- `url`, and `brief §2.5` changed that function. It now resolves link shorteners
-- to their target before normalizing (`@the-pit/fetch`'s `resolveProductUrl`),
-- which closes the largest known evasion route in the system: before it,
-- `bit.ly/x` and the page it points at were two products, and the cap was one
-- short link from free.
--
-- Rows written before that hold the old function's output. Freezing a derived
-- column at a value its derivation rule no longer produces does not preserve
-- evidence — it preserves a stale index, and it holds the cap open for every row
-- that predates the fix. So `src/backfill/normalized-url.ts` re-resolves them,
-- and this is the migration that lets it.
--
-- WHAT STAYS FROZEN, and why the audit trail is untouched:
--
--   description, description_hash   the scored text and its identity
--   url                             the address that was actually pitched
--   name                            what the product called itself
--   category_id, engine_id          what every raw score row joins on
--
-- `url` staying frozen is what keeps this safe rather than merely convenient.
-- An UPDATE that changed both would still be refused, so `normalized_url` can
-- only ever be re-derived from the same submitted address it was always derived
-- from — never re-pointed at a different site. Anyone auditing a row can take its
-- frozen `url`, run the current rules over it, and see how the key was reached.
-- `products_normalized_url_shape` still holds the result to lowercase and no
-- scheme.
--
-- Forward only, per `cli/migrate.ts`: `CREATE OR REPLACE FUNCTION` keeps the
-- existing trigger binding, so nothing is dropped and a fresh database and an
-- existing one reach the same end state.
CREATE OR REPLACE FUNCTION products_scored_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.description IS DISTINCT FROM OLD.description
     OR NEW.description_hash IS DISTINCT FROM OLD.description_hash
     OR NEW.url IS DISTINCT FROM OLD.url
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
