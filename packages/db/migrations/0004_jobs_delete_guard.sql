-- `jobs_delivery_immutable` cancelled EVERY delete, not just a delivered one.
--
-- `0002_append_only_guards.sql` wrote the guard as one `BEFORE UPDATE OR DELETE`
-- trigger ending in `RETURN NEW;`. That is correct on an update. On a delete
-- `NEW` is NULL, and a BEFORE-row trigger that returns NULL tells Postgres to
-- SKIP the operation — silently, with no error and no rows affected. So the
-- trigger did what it was written to do (refuse to delete a delivered job) and
-- also something nobody asked for: it refused to delete an undelivered one, and
-- said nothing about it.
--
-- The trigger was one keyword wrong. What let it stay wrong is that
-- `test/schema/append-only.test.ts` only ever deleted a DELIVERED job, and that
-- test passes either way — a cancelled delete and a raised exception both leave
-- the row in place, and only one of them is what the rule says. The undelivered
-- case is now asserted alongside it.
--
-- Nothing in production deletes a job, so this was harmless there. It is not
-- harmless in a test fixture or an admin cleanup: `DELETE FROM jobs WHERE ...`
-- reported success and removed nothing, which is why the suite reaches for
-- `TRUNCATE`.
--
-- The rule is unchanged and is restated here in full, because a `CREATE OR
-- REPLACE` of a two-branch function is easier to audit than a diff against a
-- migration four files back:
--
--   a job with `delivered_at` set is frozen — no UPDATE, no DELETE;
--   a job without one may be updated and may be deleted.
--
-- `RETURN OLD` on a delete is what lets the delete proceed; `RETURN NEW` on an
-- update is what lets the update proceed with the row as written.
CREATE OR REPLACE FUNCTION jobs_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION
      'job % was delivered at % and is frozen: a verdict URL is permanent (brief Part 6). A re-pitch writes a new job.',
      OLD.id, OLD.delivered_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The fix. On DELETE, `NEW` is NULL and returning it would cancel the delete
  -- the branch above just decided to allow.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
