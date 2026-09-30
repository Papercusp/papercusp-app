-- 883-user-session-workspace-capability-claims.sql
--
-- Remote operator sessions must carry the authorization context they were
-- minted for.  A cookie resolver may not infer either claim from the host's
-- mutable active-workspace state.
--
-- This is deliberately expand-only while the previous release remains live:
-- old session rows keep NULL workspace_id and are therefore rejected by the
-- new resolver (a one-time logout), while the old release can continue to
-- insert rows until the new code deploys.

ALTER TABLE harness_shared.user_sessions
  ADD COLUMN IF NOT EXISTS workspace_id text;

ALTER TABLE harness_shared.user_sessions
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY['*']::text[];

CREATE INDEX IF NOT EXISTS user_sessions_workspace_user_idx
  ON harness_shared.user_sessions (workspace_id, user_id)
  WHERE workspace_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.user_sessions.workspace_id IS
  'Workspace authorization claim fixed when the opaque browser session is minted; NULL legacy rows are invalidated by the resolver.';

COMMENT ON COLUMN harness_shared.user_sessions.capabilities IS
  'Capability claims fixed when the opaque browser session is minted; never inferred from ambient host state.';
