-- 958-required-wake-attempt-ledger.sql — EI-21458515135707634
--
-- A required coord wake has two distinct durable outcomes: the await-event
-- engine queued at least one turn, or the completed fire found no matching
-- wake-await.  Keep that evidence separate from event_wake_deliveries so a
-- later presence read can distinguish a deliberate miss from a pending,
-- staged, timed-out, or failed fire.

CREATE TABLE IF NOT EXISTS harness_shared.event_wake_attempts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  subscriber_id TEXT        NOT NULL,
  event_key     TEXT        NOT NULL,
  outcome       TEXT        NOT NULL CHECK (outcome IN ('queued', 'missed')),
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_wake_attempts_subscriber_key_time
  ON harness_shared.event_wake_attempts (workspace_id, subscriber_id, event_key, attempted_at DESC);

GRANT SELECT, INSERT ON harness_shared.event_wake_attempts TO harness_app;

DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.event_wake_attempts TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.event_wake_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_wake_attempts_workspace_isolation ON harness_shared.event_wake_attempts;
CREATE POLICY event_wake_attempts_workspace_isolation ON harness_shared.event_wake_attempts
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

COMMENT ON TABLE harness_shared.event_wake_attempts IS
  'Completed coord wake:required fire outcomes. queued means at least one wake delivery was queued; missed means the fire completed with no queued wake. Staged, timed-out, and failed fires are intentionally absent.';

