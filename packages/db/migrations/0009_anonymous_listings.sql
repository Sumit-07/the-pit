-- Anonymous listings: chosen at submission, frozen there, revealed only by consent.
--
-- A product can be published without its name or its URL. It appears as a
-- deterministic robot and a stable designation; every cut, every reason, every
-- juror, the per-metric scores, the cluster and the whole demand picture stay
-- public. Only the identity is withheld — a verdict nobody can check is the
-- opaque leaderboard The Pit exists to replace.
--
-- ## Why the choice is frozen, and why that belongs HERE
--
-- The choice is made at submission, BEFORE the panel scores anything, and it
-- cannot be reversed afterwards. That timing is the entire design.
--
-- If a founder could go anonymous after reading their verdict, the ones who
-- scored well would stay named and the ones who scored badly would hide. The
-- named half of every board would drift toward the flattering, and a reader could
-- no longer treat a name as evidence of anything — the board would still be
-- accurate row by row and would have become useless as a whole. That is exactly
-- the adverse selection `brief §2.4`'s "never keep-the-best" rule already refuses
-- in a different currency: you may buy an evaluation, and you may not buy the
-- right to un-buy the ones that went badly. Paying for an anonymous evaluation UP
-- FRONT has no selection effect at all, because the choice is made in ignorance
-- of the result. Changing your mind afterwards is the whole of the effect.
--
-- Application logic cannot carry that rule. A handler can be bypassed by a second
-- handler, a script, an admin console or a migration written in a hurry, and the
-- damage from any one of those is silent and permanent: a board that has been
-- quietly flattered does not look broken. `0002_append_only_guards.sql` already
-- took this position for the three other things that must not move after delivery
-- — a delivered job, a published snapshot, the text that was scored — and gave
-- the reason: these are triggers rather than CHECK constraints because every one
-- of them compares NEW against OLD, which a CHECK cannot see. Anonymity is the
-- fourth, and it is the same argument.
--
-- ## The one legitimate transition
--
-- Anonymous -> named, when the listing has been CLAIMED.
--
-- `packages/auth` already verifies ownership through GitHub, matching only
-- addresses the provider reports as verified (`DECISIONS.md` S15). A founder who
-- proves a listing is theirs and then chooses to be named is performing an act of
-- consent about their own product. That is a different act from reacting to a
-- score, and the difference is legible in the data rather than in intent:
-- revealing requires a verified claim, and a verified claim cannot be obtained by
-- disliking a number.
--
-- Everything else is refused:
--
--   named -> anonymous          always. This is the hide-a-bad-score move, and
--                               there is no story in which it is honest: a
--                               product that wanted anonymity had its chance
--                               before it knew anything.
--   anonymous -> named,         refused. Without a claim, whoever is flipping it
--     unclaimed                 has not shown they own it, and for a seeded row
--                               that is the exposure this migration exists to
--                               close.
--
-- The reveal is also PROSPECTIVE ONLY, and that falls out of the schema rather
-- than needing a rule. `verdicts` is append-only and `payload` carries the name
-- the listing was delivered under, so a link somebody shared keeps showing the
-- designation it showed on the day. Claiming names the product on FUTURE boards;
-- it cannot reach back and name a verdict that was issued anonymously.
--
-- ## Seeded listings are anonymous, and this closes an open wound
--
-- `DECISIONS.md` has carried S4-source since the beginning: 913 of the 1028
-- seeded descriptions were scraped from a third-party directory and were not
-- written by the companies they describe. `brief` Part 7 requires seeded listings
-- be "marked clearly as unclaimed" with a one-click opt-out, and that was never
-- sufficient — publishing AI criticism of copy a NAMED company never wrote is the
-- largest legal and reputational exposure in the project, and an opt-out only
-- helps the companies that find out.
--
-- Seeding anonymously removes it at the root. The board still demonstrates the
-- method on real market data, every cut and every reason is still public and
-- still checkable, and nobody is named without consent. `products_seeded_is_anonymous`
-- below is that resolution as a constraint: a seeded row may be named only once it
-- has been claimed, which is the same act of consent the trigger recognizes.
--
-- Forward only, per `cli/migrate.ts`.

-- The choice. Immutable after this row exists; see the trigger.
ALTER TABLE "products" ADD COLUMN "anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- When ownership was verified, and by which account.
--
-- Separate from `submitted_by_email`, which is the PAYER and is null on every
-- seeded row by `products_source_submitter`. Claiming is about who owns the
-- product, not who paid for the run: a seeded listing has no payer and can still
-- be claimed by its founder, which is the case `brief` Part 7's opt-out and
-- `DECISIONS.md` S15's "claiming a seeded listing" are both about.
ALTER TABLE "products" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "claimed_by_account_id" uuid;--> statement-breakpoint

ALTER TABLE "products" ADD CONSTRAINT "products_claimed_by_account_id_accounts_id_fk"
  FOREIGN KEY ("claimed_by_account_id") REFERENCES "public"."accounts"("id")
  ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

-- A claim is an instant and an account together, or neither. Half a claim is a
-- row that says ownership was verified without saying whose it is, which is the
-- state the reveal rule would then be reading.
ALTER TABLE "products" ADD CONSTRAINT "products_claim_is_whole"
  CHECK (("claimed_at" IS NULL) = ("claimed_by_account_id" IS NULL));--> statement-breakpoint

-- A seeded listing is anonymous until somebody claims it.
--
-- The constraint rather than a default, because a default is advice and this is
-- the resolution of S4-source: there is no code path, no fixture and no admin
-- script that can insert a named seeded row.
ALTER TABLE "products" ADD CONSTRAINT "products_seeded_is_anonymous"
  CHECK ("source" <> 'seeded' OR "anonymous" OR "claimed_at" IS NOT NULL);--> statement-breakpoint

-- The board query behind a redaction: which rows in this category are anonymous.
CREATE INDEX "products_category_anonymous_idx" ON "products" ("category_id", "anonymous");--> statement-breakpoint

-- ANONYMITY IS FROZEN.
--
-- A separate trigger from `products_scored_identity_immutable` rather than seven
-- more columns inside it, because the two rules have different shapes. That one
-- is "these columns never change"; this one is "this column changes exactly once,
-- in one direction, and only with a verified claim beside it". Folding a
-- conditional transition into a function whose contract is unconditional freezing
-- would make both harder to read and would put the reveal path one careless edit
-- away from the audit trail.
CREATE FUNCTION products_anonymity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.anonymous IS DISTINCT FROM OLD.anonymous THEN
    -- The reveal: an owner who has proved the listing is theirs choosing to be
    -- named. Requires the claim to be present on the row as it will be COMMITTED,
    -- so a single statement cannot flip anonymity and forge the claim that
    -- authorizes it in the other direction — the claim below is append-only, so
    -- `claimed_at` on NEW is either a claim that already existed or one this
    -- statement is establishing for the first time.
    IF OLD.anonymous AND NOT NEW.anonymous AND NEW.claimed_at IS NOT NULL THEN
      NULL;
    ELSE
      RAISE EXCEPTION
        'product % chose % at submission and that choice is frozen: going anonymous after seeing a verdict would let good scores stay named and bad ones hide, which is brief 2.4''s never-keep-the-best rule in another currency. The one legal change is anonymous -> named on a CLAIMED listing.',
        OLD.id,
        CASE WHEN OLD.anonymous THEN 'anonymity' ELSE 'to be named' END
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- A claim is append-only. Without this, anonymity could be revealed by setting
  -- a claim, and the claim then withdrawn, leaving a named row with nothing on it
  -- that says why it was allowed to be named.
  IF OLD.claimed_at IS NOT NULL
     AND (NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
          OR NEW.claimed_by_account_id IS DISTINCT FROM OLD.claimed_by_account_id)
  THEN
    RAISE EXCEPTION
      'product % was claimed at % and the claim is the record that authorizes it to be named: it is not withdrawn or reassigned in place.',
      OLD.id, OLD.claimed_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER products_anonymity_immutable_trg
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_anonymity_immutable();
