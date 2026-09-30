-- 1017 — durable PUI SU-session binding and runtime reconciliation (P-004).
--
-- `adv_sessions` already owns the stable numeric launch identity, native
-- backend handle, pid, workspace, and archive lifecycle.  Keep that one row
-- as the source of truth instead of creating a parallel SU-session table.
-- The JSON descriptor is a restart-safe snapshot of the typed SU-session
-- contract; the scalar columns keep duplicate suppression and reconciliation
-- queries indexable.
-- FORWARD-COMPAT: this migration only adds nullable SU-session columns plus a
-- partial unique index over the new `su_agent_chat_id` column. The currently
-- deployed release neither reads nor writes these columns and cannot target
-- this index as an ON CONFLICT arbiter; existing rows therefore remain
-- outside the predicate and no deployed write path is narrowed.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS su_agent_chat_id text,
  ADD COLUMN IF NOT EXISTS su_session_descriptor jsonb,
  ADD COLUMN IF NOT EXISTS su_session_state text,
  ADD COLUMN IF NOT EXISTS su_runtime_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS su_session_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adv_sessions_su_session_state_check'
       AND conrelid = 'harness_shared.adv_sessions'::regclass
  ) THEN
    ALTER TABLE harness_shared.adv_sessions
      ADD CONSTRAINT adv_sessions_su_session_state_check
      CHECK (su_session_state IS NULL OR su_session_state IN
        ('starting', 'ready', 'running', 'waiting-for-owner', 'resuming',
         'compacting', 'interrupted', 'ended', 'failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS adv_sessions_su_agent_chat_idx
  ON harness_shared.adv_sessions (workspace_id, su_agent_chat_id)
  WHERE su_agent_chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS adv_sessions_su_active_idx
  ON harness_shared.adv_sessions (workspace_id, su_session_state, su_session_updated_at DESC)
  WHERE su_agent_chat_id IS NOT NULL AND ended_at IS NULL;

COMMENT ON COLUMN harness_shared.adv_sessions.su_agent_chat_id IS
  'Stable agent-chat id bound to one PUI SU session (P-004); unique per workspace.';
COMMENT ON COLUMN harness_shared.adv_sessions.su_session_descriptor IS
  'Last typed SU-session descriptor snapshot for restart rehydration (P-004).';
COMMENT ON COLUMN harness_shared.adv_sessions.su_session_state IS
  'Persisted SU-session lifecycle state; native resume/reconciliation reads this after PUI restart.';
COMMENT ON COLUMN harness_shared.adv_sessions.su_runtime_generation IS
  'Monotonic runtime incarnation number; increments on replacement, never on ordinary reconnect.';
