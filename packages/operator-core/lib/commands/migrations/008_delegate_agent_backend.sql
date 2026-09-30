-- Track which agent backend handled each delegate session. New rows
-- record the backend at creation time; old rows are assumed to be
-- 'claude-code' (the only thing the operator could spawn before the
-- omp-routing migration).
--
-- Why a column and not a refactor of `claude_session_id`: omp's
-- session-id semantics are similar enough that we keep the existing
-- column name to avoid touching every read site. Backend-specific
-- resume behaviour (claude `--session-id <uuid>` vs omp `-r <prefix>`)
-- is dispatched in claude-chat-stream based on this column.

ALTER TABLE harness_shared.delegates
  ADD COLUMN IF NOT EXISTS agent_backend TEXT NOT NULL DEFAULT 'claude-code'
    CHECK (agent_backend IN ('claude-code', 'omp'));

CREATE INDEX IF NOT EXISTS delegates_agent_backend_idx
  ON harness_shared.delegates (agent_backend);
