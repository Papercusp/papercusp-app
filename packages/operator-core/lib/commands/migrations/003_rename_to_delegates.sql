-- Rename claude_sessions → delegates per Plan v6.
-- The "delegate" model: operator routes any agent-touching work to a
-- delegate — an agent CLI subprocess (omp -p via Meridian by default,
-- or claude -p with AGENT_BACKEND=claude-code) wired to the
-- agent-dispatch MCP surface. Sessions here represent those delegate
-- runs — the user resumes them from the Delegates tab in the operator
-- panel. (The retained `claude_session_id` column name pre-dates the
-- omp/Meridian addition; see migration 008 for the backend column.)
--
-- IDEMPOTENCY: handles three states correctly:
--   1. Fresh DB after 002:        rename claude_sessions → delegates
--   2. Already-migrated:          no-op
--   3. Both tables exist:         drop empty claude_sessions, keep delegates
--      (this state arises if 002 was re-applied after 003 — see the
--      guard in 002 for a permanent fix).

DO $migration$
DECLARE
  has_old BOOLEAN;
  has_new BOOLEAN;
  old_rows BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'harness_shared' AND tablename = 'claude_sessions'
  ) INTO has_old;
  SELECT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'harness_shared' AND tablename = 'delegates'
  ) INTO has_new;

  IF has_new AND NOT has_old THEN
    RAISE NOTICE '[003] already migrated — delegates exists, claude_sessions gone';
    RETURN;
  END IF;

  IF has_new AND has_old THEN
    EXECUTE 'SELECT count(*) FROM harness_shared.claude_sessions' INTO old_rows;
    IF old_rows > 0 THEN
      RAISE EXCEPTION '[003] both claude_sessions (% rows) and delegates exist; manual reconciliation needed (move rows to delegates, then DROP claude_sessions)', old_rows;
    END IF;
    RAISE NOTICE '[003] dropping stale empty claude_sessions (delegates is the live table)';
    DROP TABLE harness_shared.claude_sessions;
    RETURN;
  END IF;

  IF has_old AND NOT has_new THEN
    RAISE NOTICE '[003] renaming claude_sessions → delegates';
    ALTER TABLE harness_shared.claude_sessions RENAME TO delegates;
    ALTER INDEX IF EXISTS harness_shared.claude_sessions_open_ws_idx RENAME TO delegates_open_ws_idx;
    ALTER INDEX IF EXISTS harness_shared.claude_sessions_status_idx RENAME TO delegates_status_idx;
    ALTER SEQUENCE IF EXISTS harness_shared.claude_sessions_id_seq RENAME TO delegates_id_seq;
    BEGIN
      ALTER TABLE harness_shared.delegates RENAME CONSTRAINT claude_sessions_pkey TO delegates_pkey;
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE '[003] pkey constraint already named delegates_pkey, or never existed';
    END;
  END IF;

  -- Ensure grants in all paths.
  GRANT SELECT, INSERT, UPDATE ON harness_shared.delegates TO harness_app;
  GRANT USAGE, SELECT ON SEQUENCE harness_shared.delegates_id_seq TO harness_app;
END
$migration$;
