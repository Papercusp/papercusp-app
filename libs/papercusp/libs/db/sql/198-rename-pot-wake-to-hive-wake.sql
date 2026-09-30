-- 198-rename-pot-wake-to-hive-wake.sql — unify-launch-mechanics-2026-06-09 P-006/P-007.
--
-- The pot→hive rename (D-003): "pot" was the legacy name for the project-level
-- entity now canonically called the **Hive** (the code already uses kind:'hive'
-- + a hive:* namespace). This migration renames the live STATE that carried the
-- old name so launch/resume + the operator-state read path line up with the
-- renamed code:
--   1. the operator-state table `harness_shared.pot_wake` → `hive_wake`
--      (readOperatorState('hive_wake') maps key→table, so the table MUST match);
--   2. the one-shot wake routine rows `pot-wake` → `hive-wake` (the Queen's
--      self-declared TIME wake) + their `system:blueprint-run` payload
--      `blueprintId: 'pot'` → `'hive'` (the renamed launch blueprint id);
--   3. any work_items of kind `pot-wake` → `hive-wake` (0 today; future-proof).
--
-- Safe on the shared box: the wake-rule registration that READS pot_wake is
-- fail-soft ("a missing table pre-migration must never block boot"), and the 3
-- pot-wake routine rows are all inactive, so no live wake cycle is interrupted.
-- Idempotent (guarded renames + conditional updates); fresh-migrate-safe (the
-- table may already be `hive_wake` on a DB built after this migration — the
-- DO-block no-ops then).

-- 1. Rename the operator-state table (RENAME preserves data, RLS, grants).
DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'harness_shared' AND table_name = 'pot_wake'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'harness_shared' AND table_name = 'hive_wake'
  ) THEN
    ALTER TABLE harness_shared.pot_wake RENAME TO hive_wake;
    -- Rename the RLS policy too (cosmetic — the policy follows the table, but the
    -- name should reflect the new table).
    BEGIN
      ALTER POLICY pot_wake_workspace_isolation ON harness_shared.hive_wake
        RENAME TO hive_wake_workspace_isolation;
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END IF;
END
$rename$;

-- 2. Rename the live wake routine rows + repoint their blueprintId payload.
UPDATE harness_shared.routines
   SET name = 'hive-wake',
       payload_template = jsonb_set(
         COALESCE(payload_template, '{}'::jsonb), '{blueprintId}', '"hive"'::jsonb, true)
 WHERE name = 'pot-wake';

-- 3. Rename any work_items of the legacy kind (none expected; future-proof).
--    Guarded: focused test schemas may not have provisioned work_items yet.
DO $wi$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'harness_shared' AND table_name = 'work_items'
  ) THEN
    UPDATE harness_shared.work_items SET kind = 'hive-wake' WHERE kind = 'pot-wake';
  END IF;
END
$wi$;
