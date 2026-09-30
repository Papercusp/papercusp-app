-- Migration 1147 — link durable detached test-run snapshots to task liveness
-- (EI-22628427838600099).
--
-- The task ledger is the durable authority for whether the detached process
-- still exists. Keep this column nullable because older snapshots predate task
-- enrolment and the task row is created asynchronously at launch time.
-- Expand-only and idempotent: older operator releases continue to write and
-- read the existing snapshot columns while this migration is applied.

ALTER TABLE harness_shared.testing_run_snapshots
  ADD COLUMN IF NOT EXISTS task_id TEXT;

COMMENT ON COLUMN harness_shared.testing_run_snapshots.task_id IS
  'EI-22628427838600099: optional task-manager row owning the detached process; terminal task state reconciles orphaned running snapshots.';
