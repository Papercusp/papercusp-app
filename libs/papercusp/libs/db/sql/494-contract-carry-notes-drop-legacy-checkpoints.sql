-- Migration 494 — contract the carry-note convergence after mig 472.
--
-- Mig 472 introduced harness_shared.carry_notes as the single durable substrate
-- for Queen hive carry notes, bee work-item checkpoints, and su loop notes. It
-- deliberately left the old work_item_checkpoints table and hive_wake payload
-- keys in place while mixed old/new operators could still be running.
--
-- db:check_drift is now in_sync after 472, so finish the contract phase:
--   1. fold any late legacy checkpoint writes into carry_notes,
--   2. remove the dead carryNote/carryJournal mirrors from hive_wake payloads,
--   3. drop the obsolete work_item_checkpoints table.

DO $fold_late_bee_checkpoints$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'harness_shared' AND table_name = 'work_item_checkpoints'
  ) THEN
    INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
    SELECT
      c.workspace_id,
      'workitem:' || c.harness_slug || ':' || c.work_item_id,
      c.checkpoint,
      '[]'::jsonb,
      c.updated_ts
    FROM harness_shared.work_item_checkpoints c
    ON CONFLICT (workspace_id, scope) DO UPDATE
      SET note = EXCLUDED.note,
          updated_ts = GREATEST(harness_shared.carry_notes.updated_ts, EXCLUDED.updated_ts)
      WHERE harness_shared.carry_notes.note IS DISTINCT FROM EXCLUDED.note
         OR harness_shared.carry_notes.updated_ts < EXCLUDED.updated_ts;
  END IF;
END
$fold_late_bee_checkpoints$;

UPDATE harness_shared.hive_wake
   SET payload = payload - 'carryNote' - 'carryJournal'
 WHERE payload ? 'carryNote'
    OR payload ? 'carryJournal';

DROP TABLE IF EXISTS harness_shared.work_item_checkpoints;
