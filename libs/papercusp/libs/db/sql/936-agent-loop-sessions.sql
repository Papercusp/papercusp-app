-- 936-agent-loop-sessions.sql
-- PG-backed session store for the owned agent loop's engine:'loop' agent-chats
-- lane (P-009, own-tui-full-divorce-2026-08-24; wire shape D-011).
--
-- WHY A TABLE: agent_chats.transcript keeps TEXT turns only — the tool detail
-- inside a loop turn (tool_call / tool_result ModelMessage parts) is not
-- reconstructable from it, so a resumed chat previously replayed a lossy
-- text-only history (chat-engine.ts transcriptToMessages). This table holds
-- the FULL ModelMessage[] working set per chat, plus compaction state and the
-- accumulated usage/cost totals — it is also the invocation ledger for loop
-- turns (nothing is spawned, so spawned_agents never sees them).
--
-- One row per (workspace, chat). `messages` is the POST-compaction working
-- set the next turn replays; `summary` covers the `compacted_count` original
-- messages that were folded out. `transcript_turns` anchors the row to the
-- agent_chats.transcript length it was saved against: a mismatch on load
-- means another lane (legacy CLI-spawn) advanced the chat, and the engine
-- falls back to the text rebuild instead of replaying a stale session.
--
-- Cost columns follow @papercusp/model-pricing's honesty rule ("never
-- $0-guess a real model"): a turn whose model has no price row accumulates
-- into unpriced_turn_count instead of adding a fabricated $0 to
-- total_cost_usd.

CREATE TABLE IF NOT EXISTS harness_shared.agent_loop_sessions (
  workspace_id                TEXT        NOT NULL,
  chat_id                     TEXT        NOT NULL,
  messages                    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  message_count               INTEGER     NOT NULL DEFAULT 0,
  summary                     TEXT,
  compacted_count             INTEGER     NOT NULL DEFAULT 0,
  transcript_turns            INTEGER     NOT NULL DEFAULT 0,
  model                       TEXT,
  turn_count                  INTEGER     NOT NULL DEFAULT 0,
  total_input_tokens          BIGINT      NOT NULL DEFAULT 0,
  total_output_tokens         BIGINT      NOT NULL DEFAULT 0,
  total_cache_read_tokens     BIGINT      NOT NULL DEFAULT 0,
  total_cache_creation_tokens BIGINT      NOT NULL DEFAULT 0,
  total_cost_usd              NUMERIC(14, 6) NOT NULL DEFAULT 0,
  unpriced_turn_count         INTEGER     NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_loop_sessions_updated
  ON harness_shared.agent_loop_sessions (workspace_id, updated_at DESC);

COMMENT ON TABLE harness_shared.agent_loop_sessions IS
  'Full ModelMessage session state per engine:''loop'' agent chat (P-009 native session protocol): working-set messages after compaction, summary of folded-out turns, transcript_turns freshness anchor, and accumulated usage/cost totals. See packages/operator-core/lib/agent-loop/session-store.ts.';
