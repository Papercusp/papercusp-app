-- P-004 / WI-10002826: lineage reads need one scalar, not the launch prompt.
-- The stored expression stays synchronized on INSERT and launch_spec UPDATE,
-- including old writers. It preserves the existing ->> and blank semantics.
-- No history is removed and old binaries continue to read launch_spec.
SET LOCAL lock_timeout = '5s';
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS launch_parent_owner text
  GENERATED ALWAYS AS (NULLIF(launch_spec->>'launchedBy', '')) STORED;

COMMENT ON COLUMN harness_shared.adv_sessions.launch_parent_owner IS
  'Database-maintained launch_spec.launchedBy projection for identity lineage; NULL for absent or blank parent. Never write independently.';
