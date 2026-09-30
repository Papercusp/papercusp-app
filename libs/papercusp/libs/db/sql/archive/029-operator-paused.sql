-- 029-operator-paused.sql
--
-- Round-7 file→PG migration: operator pause sentinel.
--
-- Was previously `<ws>/.papercusp/system/operator/paused.flag` — file
-- existence = "paused", body content `paused-by=<X>\nat=<ISO>\n`.
-- The CLI sets/clears it; the chrome's BackgroundScanner polls
-- `/api/agent-mcp/operator-pause-flag` to honor it.
--
-- Single-row-per-workspace JSONB row matches the operator_state pattern.
-- Payload shape: `{ paused: boolean, by?: string, at?: string }` —
-- `paused: false` is the resumed state (kept rather than deleting the
-- row so the audit trail of last-pause is preserved).
--
-- NOT in zero_harness publication — pause is operator-runtime state,
-- not user-facing data the UI subscribes to via Zero.

CREATE TABLE IF NOT EXISTS harness_shared.operator_paused (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
