-- claude_sessions — voice picks which conversation a delegation lands in.
-- See /docs/agents/action-registry §5 (delegation) and the design discussion
-- around layered titles + summaries.
--
-- IDEMPOTENCY GUARD: if migration 003 already renamed this table to
-- `delegates`, skip everything below. Wraps the whole migration in a
-- DO block so the conditional actually short-circuits the CREATEs.
-- Makes 002 safe to re-run on a fresh DB OR a migrated DB.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'harness_shared' AND tablename = 'delegates'
  ) THEN
    RAISE NOTICE '[002] delegates table already present — skipping (migration 003 ran)';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS harness_shared.claude_sessions (
    id                BIGSERIAL PRIMARY KEY,
    workspace         TEXT NOT NULL,
    claude_session_id TEXT NOT NULL UNIQUE,        -- the --resume id
    title             TEXT,                        -- auto-generated, ~5-10 words
    summary           TEXT,                        -- auto-generated, ~40-60 words
    status            TEXT NOT NULL DEFAULT 'open', -- 'open' | 'archived'
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    turn_count        INT NOT NULL DEFAULT 0,
    origin            TEXT NOT NULL,               -- 'voice' | 'panel' | 'oracle'
    initiator_msg     TEXT                         -- first user message, fallback for titles
  );

  CREATE INDEX IF NOT EXISTS claude_sessions_open_ws_idx
    ON harness_shared.claude_sessions (workspace, last_active_at DESC)
    WHERE status = 'open';

  CREATE INDEX IF NOT EXISTS claude_sessions_status_idx
    ON harness_shared.claude_sessions (status, last_active_at DESC);

  GRANT SELECT, INSERT, UPDATE ON harness_shared.claude_sessions TO harness_app;
  GRANT USAGE, SELECT ON SEQUENCE harness_shared.claude_sessions_id_seq TO harness_app;
END
$migration$;
