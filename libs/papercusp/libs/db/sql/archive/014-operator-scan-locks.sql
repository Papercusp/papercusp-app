-- 014-operator-scan-locks.sql
--
-- Operator multi-tab scan-lock (Phase 1d of the v5 operator plan).
-- One workspace = at most one active scan at a time. Holders renew
-- via UPDATE; the route returns 429 with Retry-After if a fresh lock
-- (within `expires_at`) is held by a different `holder_id`.
--
-- RLS-scoped to the active workspace — same pattern as the other
-- harness_shared tables. The route always reads/writes via
-- withWorkspace(); RLS forbids cross-workspace lock observation.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS harness_shared.operator_scan_locks (
  workspace_id TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  holder_id    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id)
);

CREATE INDEX IF NOT EXISTS operator_scan_locks_expires_idx
  ON harness_shared.operator_scan_locks(expires_at);

ALTER TABLE harness_shared.operator_scan_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_scan_locks_workspace_iso ON harness_shared.operator_scan_locks;
CREATE POLICY operator_scan_locks_workspace_iso ON harness_shared.operator_scan_locks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.operator_scan_locks
  TO harness_app, harness_admin;
