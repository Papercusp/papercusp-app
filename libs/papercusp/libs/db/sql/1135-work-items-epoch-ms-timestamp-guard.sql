-- 1135-work-items-epoch-ms-timestamp-guard.sql
--
-- EI-22466530310361606 — work_items.created_ts and updated_ts are BIGINT epoch-ms
-- columns. A positive ten-digit value is an epoch-seconds stamp (the current
-- epoch-ms values are thirteen digits), and the compatibility reader interprets
-- it as milliseconds, rendering a false 1970 activity time.
--
-- Keep this CHECK NOT VALID for the rollout: legacy rows can already contain the
-- wrong unit, and a full-table validation would make the migration fail before
-- those rows can be repaired. PostgreSQL still enforces a NOT VALID CHECK for
-- every new INSERT and every UPDATE, so the bad unit cannot recur. After the
-- existing rows are repaired, a later migration can validate the constraint.
-- The migration runner supplies the transaction; do not add BEGIN/COMMIT here.

LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

DO $work_items_epoch_ms_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.work_items'::regclass
       AND conname = 'work_items_epoch_ms_timestamp_units_chk'
  ) THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_epoch_ms_timestamp_units_chk
      CHECK (
        (
          created_ts IS NULL
          OR created_ts < 1000000000::bigint
          OR created_ts >= 10000000000::bigint
        )
        AND (
          updated_ts IS NULL
          OR updated_ts < 1000000000::bigint
          OR updated_ts >= 10000000000::bigint
        )
      )
      NOT VALID;
  END IF;
END
$work_items_epoch_ms_guard$;

COMMENT ON CONSTRAINT work_items_epoch_ms_timestamp_units_chk
  ON harness_shared.work_items IS
  'EI-22466530310361606: created_ts and updated_ts are epoch-ms; reject positive ten-digit epoch-seconds values. NOT VALID preserves legacy rows for guarded repair.';

DO $work_items_epoch_ms_guard_verify$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO definition
    FROM pg_constraint
   WHERE conrelid = 'harness_shared.work_items'::regclass
     AND conname = 'work_items_epoch_ms_timestamp_units_chk';

  IF definition IS NULL
     OR definition NOT LIKE '%created_ts%'
     OR definition NOT LIKE '%updated_ts%'
     OR definition NOT LIKE '%1000000000%'
     OR definition NOT LIKE '%10000000000%' THEN
    RAISE EXCEPTION
      '1135: work_items_epoch_ms_timestamp_units_chk is missing or has an unexpected definition: %',
      COALESCE(definition, '<missing>');
  END IF;
END
$work_items_epoch_ms_guard_verify$;
