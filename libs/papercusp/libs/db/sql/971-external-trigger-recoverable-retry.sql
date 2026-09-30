-- 971-external-trigger-recoverable-retry.sql — EI-21491336217613668
--
-- trigger_runs is already the durable external-event outbox, but its retry
-- cursor is only `attempts < 5`. A required-wake failure explicitly marked
-- recoverable + queuePreserved therefore becomes permanently unclaimable after
-- roughly two minutes when its stable target is absent. Keep the same outbox;
-- add only the due-time field it needs to park those rows without hot-looping.
--
-- Forward-compatible with the deployed writer: every existing INSERT omits
-- this additive column and receives `now()`, preserving today's immediate first
-- attempt. Existing failed rows also become due immediately, so the engine can
-- perform its one guarded legacy rescue claim after this migration lands.

ALTER TABLE harness_shared.trigger_runs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS trigger_runs_ws_due_idx
  ON harness_shared.trigger_runs (workspace_id, next_attempt_at, triggered_at, id)
  WHERE status IN ('pending', 'failed', 'running');

COMMENT ON COLUMN harness_shared.trigger_runs.next_attempt_at IS
  'Earliest time the durable external-trigger dispatcher may reclaim this row. Recoverable required-wake failures remain in the existing outbox beyond the ordinary retry cap at a slow cadence instead of becoming silent terminal loss.';
