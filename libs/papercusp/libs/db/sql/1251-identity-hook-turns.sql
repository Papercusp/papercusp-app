-- 1251-identity-hook-turns.sql
-- portable-identity-packages-2026-09-26 P-011 (WI-10003320), plan Decision D-024.
--
-- WHY. A worn identity's synchronous context hooks run at several sinks of ONE turn (turn start,
-- after a tool batch, at stop), and D-023 requires one per-(session, turn) token ceiling across
-- all of them. Each sink is a separate HTTP request, and the operator serves requests from N
-- cluster workers, so the sink evaluator's process-local ledger alone would let each worker spend
-- the whole ceiling again. This row is the shared half: which turn the session is in, and how many
-- tokens its hook sinks have delivered in that turn.
--
-- One row per (workspace, owner). A new turn (turn start, or a fresh context after a compaction)
-- replaces turn_id and zeroes tokens_spent; a sink that settles adds what it delivered, fenced on
-- turn_id so a late sink cannot charge the next turn. A row existing at all also means the owner
-- has taken a turn before, which is how a respawned session's SessionStart is told apart from a
-- first launch (D-024 §3).
--
-- Additive only: a new table and policy. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.identity_hook_turns (
  workspace_id text        NOT NULL,
  owner_id     text        NOT NULL,
  turn_id      text        NOT NULL,
  tokens_spent integer     NOT NULL DEFAULT 0
                           CONSTRAINT identity_hook_turns_tokens_nonnegative CHECK (tokens_spent >= 0),
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id)
);

ALTER TABLE harness_shared.identity_hook_turns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_hook_turns_workspace ON harness_shared.identity_hook_turns;
CREATE POLICY identity_hook_turns_workspace ON harness_shared.identity_hook_turns
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.identity_hook_turns TO harness_app;

COMMENT ON TABLE harness_shared.identity_hook_turns IS
  'Current identity hook turn per session (P-011, D-024): turn_id and the tokens its hook sinks delivered, shared across operator cluster workers so one turn ceiling spans every sink.';
