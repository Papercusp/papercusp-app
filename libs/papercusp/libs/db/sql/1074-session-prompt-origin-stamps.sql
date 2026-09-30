-- 1074: hook-authenticated interactive prompt provenance.
-- The UserPromptSubmit hook knows whether a prompt was typed by the owner, but
-- that fact is otherwise lost before transcript ingest. Keep a short-lived,
-- hash-keyed stamp that ingest can consume without trusting transcript text.
CREATE TABLE IF NOT EXISTS harness_shared.session_prompt_origin_stamps (
  workspace_id text NOT NULL,
  source_kind text NOT NULL,
  session_id text NOT NULL,
  prompt_hash text NOT NULL,
  submitted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id, prompt_hash, submitted_at)
);

CREATE INDEX IF NOT EXISTS session_prompt_origin_stamps_lookup_idx
  ON harness_shared.session_prompt_origin_stamps
    (workspace_id, source_kind, session_id, prompt_hash, submitted_at);

COMMENT ON TABLE harness_shared.session_prompt_origin_stamps IS
  'Short-lived, hook-authenticated OWNER (interactive) prompt stamps. Ingest may upgrade only a matching v5 unenrolled user row; absence never changes the existing fallback.';

CREATE INDEX IF NOT EXISTS session_prompt_origin_stamps_expiry_idx
  ON harness_shared.session_prompt_origin_stamps (expires_at);
