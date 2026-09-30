-- 014_rename_claude_session_id.sql
--
-- Rename `claude_session_id` column → `agent_session_id` everywhere it
-- appears. The old name dates back to when claude-code was the only
-- agent backend; the abstraction has been backend-agnostic for a while
-- (omp by default, claude-code when settings opt in) and the
-- claude-prefix leaks into agent prompts, API payloads, and SSE event
-- shapes in a confusing way.
--
-- Tables touched:
--   harness_shared.delegates           (the session row — see migration 002 + 003)
--   harness_shared.operator_scans      (cross-scan resume key)
--   harness_shared.delegate_inbox      (delivered-message row — kind=delegate-complete)
--
-- Pre-alpha policy: no users, no production. Drop the old column name
-- in one migration instead of carrying compat aliases.
--
-- IDEMPOTENCY: each ALTER TABLE checks information_schema first so
-- re-running the migration on an already-renamed DB is a no-op.

DO $migration$
BEGIN
  -- 1. delegates.claude_session_id → delegates.agent_session_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name = 'delegates'
      AND column_name = 'claude_session_id'
  ) THEN
    EXECUTE 'ALTER TABLE harness_shared.delegates RENAME COLUMN claude_session_id TO agent_session_id';
    RAISE NOTICE '[014] renamed delegates.claude_session_id → agent_session_id';
  END IF;

  -- 2. operator_scans.claude_session_id → operator_scans.agent_session_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name = 'operator_scans'
      AND column_name = 'claude_session_id'
  ) THEN
    EXECUTE 'ALTER TABLE harness_shared.operator_scans RENAME COLUMN claude_session_id TO agent_session_id';
    RAISE NOTICE '[014] renamed operator_scans.claude_session_id → agent_session_id';
  END IF;

  -- 3. delegate_inbox.claude_session_id → delegate_inbox.agent_session_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name = 'delegate_inbox'
      AND column_name = 'claude_session_id'
  ) THEN
    EXECUTE 'ALTER TABLE harness_shared.delegate_inbox RENAME COLUMN claude_session_id TO agent_session_id';
    RAISE NOTICE '[014] renamed delegate_inbox.claude_session_id → agent_session_id';
  END IF;

  -- 4. Indexes referencing the old column name. Postgres preserves the
  --    column rename in the existing index definition automatically;
  --    only the index NAME needs to change for readability.
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'operator_scans_claude_session_idx') THEN
    EXECUTE 'ALTER INDEX harness_shared.operator_scans_claude_session_idx RENAME TO operator_scans_agent_session_idx';
  END IF;

  -- 5. The unique constraint on delegates (formerly named claude_sessions;
  --    table was renamed earlier but constraints kept the historical
  --    prefix). Rename just the one constraint that references the
  --    renamed column name. Other claude_sessions_* not-null constraints
  --    are cosmetic and left alone — schema reflection regenerates names
  --    when we re-pull anyway.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'claude_sessions_claude_session_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE harness_shared.delegates RENAME CONSTRAINT claude_sessions_claude_session_id_key TO claude_sessions_agent_session_id_key';
    RAISE NOTICE '[014] renamed delegates unique constraint claude_session_id → agent_session_id';
  END IF;
END
$migration$;
