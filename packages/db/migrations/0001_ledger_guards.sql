-- The four attempt-ledger rules that a column constraint cannot express.
--
-- `the-pit-build-brief.md` §2.3 says an attempt is "consumed only on delivery —
-- decrement in the same transaction that writes the verdict and marks it
-- delivered. Not on job start, not on pipeline completion", and that failures are
-- free retries. `attempts` models that as an append-only ledger, and the table's
-- own CHECK constraints already pin the shape of a single row: the delta is
-- non-zero, `kind` and `delta` agree (a grant adds, a consume takes exactly one),
-- a grant names an order, a consume names a job, an adjustment names a person. A
-- unique `idempotency_key` and two partial unique indexes pin the cardinality:
-- one row per money event, one consume per job, one grant per order.
--
-- What is left needs to look at other rows or other tables, which a CHECK cannot
-- do. Hence four triggers. Each is written so the FAILURE MODE IT PREVENTS is
-- the thing named in the exception message, because the message is what a
-- future maintainer sees at 3am.
--
-- Written by hand rather than generated: drizzle-kit derives DDL from the schema
-- file, and a trigger has no schema-file representation. `test/schema/*.test.ts`
-- applies this file to an in-process Postgres and asserts each rule by trying to
-- break it.

-- 1. APPEND-ONLY.
--
-- Without this the ledger is a mutable counter with extra steps: one UPDATE to a
-- `delta`, or one DELETE of a consume, and the balance is wrong with no trace of
-- how. `brief` Part 7 requires the money-adjacent records to be evidence; evidence
-- that can be edited in place is not evidence.
--
-- A correction is a new compensating row, which is what a ledger is for.
CREATE FUNCTION attempts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'attempts is append-only: % on attempt % is refused. Correct a mistake with a new compensating row.',
    TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER attempts_immutable_trg
  BEFORE UPDATE OR DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_immutable();
--> statement-breakpoint

-- 2. A CONSUME REQUIRES A DELIVERED JOB.
--
-- This is `brief` §2.3 turned into a precondition. The verdict transaction must
-- set `jobs.delivered_at` before it may insert the decrement; a worker that
-- charges on job start, on pipeline completion, or on a failed run that it is
-- about to retry for free, is refused by the database rather than by a code
-- review.
--
-- It is a CONSTRAINT trigger so that a single transaction may write the delivery
-- and the decrement in either statement order — `brief` §2.3 requires them to be
-- in the same transaction, not in a particular sequence within it. INITIALLY
-- DEFERRED moves the check to COMMIT, by which time both rows exist.
CREATE FUNCTION attempts_consume_requires_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivered timestamptz;
BEGIN
  IF NEW.kind <> 'consume' THEN
    RETURN NULL;
  END IF;

  SELECT j.delivered_at INTO delivered FROM jobs j WHERE j.id = NEW.job_id;

  IF delivered IS NULL THEN
    RAISE EXCEPTION
      'attempt % consumes job %, which has not been delivered. An attempt is consumed only on delivery (brief 2.3): set jobs.delivered_at in the same transaction that writes the verdict.',
      NEW.id, NEW.job_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER attempts_consume_requires_delivery_trg
  AFTER INSERT ON attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attempts_consume_requires_delivery();
--> statement-breakpoint

-- 3. A GRANT MATCHES WHAT WAS PAID FOR.
--
-- `brief` §2.3 prices the tiers: "$5 = 1 attempt. $15 = 3 attempts + fit report.
-- Keeps $5 as the atomic unit so 'same five dollars for everyone' stays literally
-- true." The order row records what the payment bought; this refuses a ledger row
-- that hands out anything else.
--
-- The check cannot be a CHECK constraint because it compares a column here
-- against a column on `orders`. Without it, a webhook handler that read the wrong
-- tier would grant four attempts for a three-attempt order and nothing would
-- notice until the balance did not match the receipts.
CREATE FUNCTION attempts_grant_matches_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid_for integer;
BEGIN
  IF NEW.kind <> 'grant' THEN
    RETURN NULL;
  END IF;

  SELECT o.attempts_granted INTO paid_for FROM orders o WHERE o.id = NEW.order_id;

  IF paid_for IS DISTINCT FROM NEW.delta THEN
    RAISE EXCEPTION
      'attempt % grants % but order % paid for %: a grant is worth exactly what the tier bought (brief 2.3).',
      NEW.id, NEW.delta, NEW.order_id, paid_for
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER attempts_grant_matches_order_trg
  AFTER INSERT ON attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attempts_grant_matches_order();
--> statement-breakpoint

-- 4. NO OVERDRAFT.
--
-- The balance is `sum(delta)` over an account's rows, so "never below zero" is a
-- statement about a set and cannot be a CHECK. This trigger recomputes the sum
-- after each insert and refuses a consume that would take it negative.
--
-- HONEST LIMIT: under READ COMMITTED, two concurrent transactions can each see a
-- balance of 1 and each insert a consume, and both commit. This trigger is
-- defence in depth, not a serialization mechanism. The consuming path must take
-- a per-account lock first:
--
--     SELECT pg_advisory_xact_lock(hashtext('attempt:' || $account_email));
--
-- which serializes deliveries for one account and costs nothing for everyone
-- else. The trigger then catches the case where somebody forgot the lock, which
-- is the realistic failure — and it catches it on the row that overdrew, naming
-- the account.
--
-- Deferred for the same reason as (2): a grant and a consume in one transaction
-- must be judged on the transaction's net effect, not on statement order.
CREATE FUNCTION attempts_no_overdraft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance integer;
BEGIN
  SELECT COALESCE(SUM(a.delta), 0) INTO balance FROM attempts a WHERE a.account_email = NEW.account_email;

  IF balance < 0 THEN
    RAISE EXCEPTION
      'attempt ledger for % would go to %, and a balance cannot be negative. An attempt must be granted by a paid order before it can be consumed.',
      NEW.account_email, balance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER attempts_no_overdraft_trg
  AFTER INSERT ON attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attempts_no_overdraft();
--> statement-breakpoint

-- 5. THE BALANCE ITSELF.
--
-- One definition of "attempts remaining", so no caller invents a second one.
-- STABLE, not IMMUTABLE: it reads a table.
CREATE FUNCTION attempt_balance(p_account_email text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(a.delta), 0)::integer FROM attempts a WHERE a.account_email = p_account_email;
$$;
