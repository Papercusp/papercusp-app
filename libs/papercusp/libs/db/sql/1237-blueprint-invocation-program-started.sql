-- WI-10003631 (P-013 workload C): make the accepted coord-program launch scan
-- O(unstarted receipts) instead of O(all receipts ever accepted).
--
-- findUnstartedAcceptedCoordPrograms previously seq-scanned every
-- blueprint_operation_invocations row (filtered only by target_kind) and paid a
-- work_items index probe plus a dbos.workflow_status anti-join per row, on every
-- launch pass. Receipts are retained indefinitely, so launch cost grew without
-- bound with history.
--
-- program_started_at is a launch-scan WATERMARK, not outcome authority: the
-- scan stamps it only once a receipt's workflow exists AND its target work item
-- is terminal, a state the launch SELECT already excludes. In-flight receipts
-- stay unstamped, so the dbos.workflow_status anti-join remains the correctness
-- guard for them. A NULL value only means "not yet observed as finished".
ALTER TABLE harness_shared.blueprint_operation_invocations
  ADD COLUMN IF NOT EXISTS program_started_at timestamptz;

COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.program_started_at IS
  'Launch-scan watermark: set once the receipt''s coord-program workflow exists AND its target work item is terminal. NULL = still considered by the launch scan. The dbos.workflow_status anti-join remains the correctness guard.';

CREATE INDEX IF NOT EXISTS blueprint_operation_invocations_unstarted_idx
  ON harness_shared.blueprint_operation_invocations (id)
  WHERE target_kind = 'work-item' AND program_started_at IS NULL;
