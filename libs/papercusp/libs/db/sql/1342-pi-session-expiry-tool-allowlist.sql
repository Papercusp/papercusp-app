-- Bound PI bearers by lifetime and, when supplied, by exact canonical MCP tool
-- names. Existing rows receive a short migration grace period; new sessions
-- always write both fields through startPiSession().
ALTER TABLE harness_shared.pi_sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS allowed_tools jsonb;

UPDATE harness_shared.pi_sessions
   SET expires_at = now() + interval '24 hours'
 WHERE expires_at IS NULL;

-- FORWARD-COMPAT: the deployed release at
-- d740fc3802877d1c8c3b1068768681ee32ef0025 inserts only
-- workspace_id, session_id, bearer_hash, and capabilities into pi_sessions.
-- It omits expires_at and allowed_tools. Existing rows are backfilled above;
-- omitted expires_at gets the default below before NOT NULL is checked, and
-- allowed_tools intentionally remains nullable. Thus the old writer stays
-- valid during rollout while the new writer stores both fields. (WI-10003615)
ALTER TABLE harness_shared.pi_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS pi_sessions_live_expiry_idx
  ON harness_shared.pi_sessions (workspace_id, expires_at)
  WHERE ended_at IS NULL;
