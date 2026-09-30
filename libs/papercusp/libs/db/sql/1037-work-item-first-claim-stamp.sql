-- work-queue-admission-and-bulk-dedup D-003: give work_items.first_claimed_at a
-- production writer.
--
-- The column landed in 952 WITH readers but with NO writer. Its only setter in
-- the whole tree was a test fixture (work-items-admission-promoter.integration
-- .test.ts), so it was NULL on all 194,025 rows and both readers were
-- structurally dead rather than merely quiet:
--   * readWorkItemAdmissionQueueHealth's p50/p95 promoted-to-first-claim
--     percentiles reported sampleSize 0 on every tick, and
--   * decideWorkItemAdmissionProducerPressure's latency limb could never fire.
-- A metric whose column has no writer reads exactly like a healthy system.
--
-- WHY THE WRITER BELONGS HERE AND NOT AT THE CLAIM CALL SITES.
-- There are four claim sites (work-items.ts x3, scheduler/get-next.ts x1), and
-- three of them write through harness_shared.harness_features_consolidated -- an
-- auto-updatable view that does not even EXPOSE first_claimed_at. So a call-site
-- fix would need the column added to that view AND the same stamp remembered at
-- four separate places. That is precisely the shape that let the column ship
-- dead in the first place: with no shared seam, populating it was N independent
-- acts of remembering, and every one of them was forgotten.
--
-- Migration 806 already detects exactly the event this needs, on the shared base
-- table, with the guards already correct: it fires only on a REAL holder
-- transition, it excludes remote/federated projection churn, and it ignores the
-- legacy 'unassigned' sentinel. Its own header records that every claim/release
-- path mutates taken_by here, "including view-triggered issue writes, stale
-- reaping, and terminal clears" -- which is why one trigger on the base table
-- covers all four call sites including the three view writes. Extending that
-- single writer beats adding a second, parallel trigger whose three guards would
-- be free to drift out of agreement with these.
--
-- SET-ONCE BY CONSTRUCTION. COALESCE preserves the ORIGINAL stamp, so a release
-- and re-claim never overwrites it. That immutability is the entire reason the
-- column exists alongside taken_at, which release/reclaim clears.
--
-- FORWARD-ONLY, DELIBERATELY NOT BACKFILLED.
-- A backfill was available and would have been truthful: worked_by_history[0].at
-- is written by this same trigger on the first holder transition, and 806
-- predates 952, so every admitted row has complete history -- measured, 0 of the
-- 865 admitted rows were created before 806 applied. It would have yielded 505
-- rows passing the readers' own (first_claimed_at >= admitted_at) filter.
-- It is skipped anyway because the UPDATE would drag 865 LIVE work-items through
-- four unconditional BEFORE UPDATE triggers on this table -- including
-- completion_authority_floor_trg, which can downgrade an unproven committed
-- close, and stamp_local_federated_write_trg, which stamps fed_ts and so
-- re-projects each row to peers -- plus capture_work_items_feature_upd_trg,
-- which fires on ANY column change for feature-family rows. Measured claim rate
-- on admitted rows is ~19 holder transitions/hour (188 distinct items in 24h),
-- so the readers populate on their own within the hour. Paying live-row mutation
-- risk to skip a one-hour wait is a bad trade.
--
-- The function keeps its 806 name. The trigger name is load-bearing (same-kind
-- PostgreSQL triggers fire alphabetically, and this one must run BEFORE
-- stamp_local_federated_write_trg so its fed_ts guard sees the pre-stamp value),
-- and migration 1036 exists solely because an earlier rename of it silently
-- failed to re-apply. A cosmetic rename here would risk that again for nothing.

CREATE OR REPLACE FUNCTION harness_shared.record_work_item_worked_by_history()
RETURNS trigger
LANGUAGE plpgsql
AS $worked_history$
DECLARE
  worker text;
BEGIN
  -- Remote rows are owned by their authoring peer. Their projected claim churn
  -- must not become local prior-worker attribution on this node.
  IF NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
     OR COALESCE(NEW.origin, 'local') = 'remote' THEN
    RETURN NEW;
  END IF;

  -- UPDATE OF taken_by also fires for an idempotent same-holder claim; only a
  -- real holder transition is a new piece of work history.
  IF NEW.taken_by IS NOT DISTINCT FROM OLD.taken_by THEN
    RETURN NEW;
  END IF;

  -- On claim use NEW.taken_by; on release NEW is NULL, so use OLD.taken_by.
  -- Ignore the legacy unassigned sentinel rather than attributing work to it.
  worker := NULLIF(btrim(COALESCE(NEW.taken_by, OLD.taken_by)), '');
  IF worker IS NULL OR lower(worker) = 'unassigned' THEN
    RETURN NEW;
  END IF;

  -- D-003: the immutable first-claim stamp, on the same real holder transition
  -- this trigger already isolates.
  --
  -- Test NEW.taken_by directly rather than reusing `worker`: on a RELEASE the
  -- transition is just as real and `worker` falls back to OLD.taken_by, but a
  -- release is not a claim and must not stamp. COALESCE keeps the first value
  -- forever, so a re-claim after release leaves the original stamp intact.
  IF NULLIF(btrim(COALESCE(NEW.taken_by, '')), '') IS NOT NULL THEN
    NEW.first_claimed_at := COALESCE(OLD.first_claimed_at, clock_timestamp());
  END IF;

  -- Keep the parser's durable shape small and stable. Existing malformed/null
  -- values degrade to a fresh array rather than making the claim fail.
  NEW.worked_by_history :=
    CASE WHEN jsonb_typeof(NEW.worked_by_history) = 'array'
      THEN NEW.worked_by_history
      ELSE '[]'::jsonb
    END
    || jsonb_build_array(jsonb_build_object('owner', worker, 'at', clock_timestamp()));

  RETURN NEW;
END;
$worked_history$;

COMMENT ON FUNCTION harness_shared.record_work_item_worked_by_history() IS
  'Records the two durable facts a real work-item holder transition produces: the append-only worked_by_history entry (806) and the immutable first_claimed_at stamp (work-queue-admission-and-bulk-dedup D-003). Lives on the shared base table so it covers every claim path, including writes through the harness_features_consolidated and engineer_issues compatibility views.';

-- The 806/1036 trigger already fires BEFORE UPDATE OF taken_by and needs no
-- change: replacing the function above is by itself enough to make the stamp
-- live, and CREATE OR REPLACE FUNCTION takes no lock on work_items at all.
--
-- So the trigger is re-asserted ONLY when it is genuinely missing. An
-- unconditional DROP+CREATE TRIGGER would take an ACCESS EXCLUSIVE lock on
-- work_items every time this file is applied -- on a table taking ~19 holder
-- transitions an hour under ~100 concurrent agents, that lock is both hard to
-- acquire and harmful to wait for. Measured: the unconditional form failed here
-- with `canceling statement due to lock timeout` against the live database while
-- the function replacement it was guarding needed no table lock whatsoever.
-- The guarded form converges a database that somehow lost the trigger without
-- making every other application of this migration contend for the table.
DO $ensure_history_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'work_items'
       AND t.tgname = 'record_work_item_worked_by_history_trg'
       AND NOT t.tgisinternal
  ) THEN
    DROP TRIGGER IF EXISTS work_items_worked_by_history_trg ON harness_shared.work_items;
    CREATE TRIGGER record_work_item_worked_by_history_trg
      BEFORE UPDATE OF taken_by ON harness_shared.work_items
      FOR EACH ROW
      EXECUTE FUNCTION harness_shared.record_work_item_worked_by_history();
  END IF;
END
$ensure_history_trigger$;
