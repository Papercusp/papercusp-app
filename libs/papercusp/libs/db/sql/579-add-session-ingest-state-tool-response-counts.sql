-- Migration 579 — session_ingest_state: real per-session prompt/response/
-- tool-call counts (EI-9970).
--
-- sessions:list's only per-session size signal was `turns` = count(*) of
-- harness_shared.session_turns rows — i.e. INDEXED TEXT TURNS ONLY (user
-- prompts + assistant text replies that passed the ingest filter; tool_use /
-- tool_result / thinking-only content is deliberately excluded from that
-- table by design, session-ingest.ts "TEXT TURNS ONLY (v1)"). Presented
-- bare as "turns" it was misread as a raw transcript-record count, and
-- audits built on it were comparing an apples number to an oranges number
-- across sessions (2026-07-12 fleet retrospective, EI-9970).
--
-- These three columns are accumulated AT INGEST TIME (session-ingest.ts),
-- scanning EVERY raw transcript line (not just the ones that produce a
-- stored session_turns row), so they capture signal that table structurally
-- omits:
--   * prompt_count      — real user-typed prompts (same filter as
--                         session_turns speaker='user'; kept here too so a
--                         session with NO indexed text turns, e.g. fully
--                         tool_use/thinking, still reports a real prompt
--                         count instead of silently reading as 0 traffic).
--   * response_count    — DISTINCT model-inference calls, deduped via each
--                         adapter's own request/message id (Claude:
--                         message.id/requestId; OMP/Codex: the line's own
--                         id) — NOT a raw assistant-line count, because a
--                         single model turn can legitimately be split
--                         across multiple raw JSONL 'assistant' lines
--                         (a thinking-only stub line, one line per
--                         tool_use block, then a text line all sharing one
--                         call) — a naive per-line count reproduces the
--                         exact same "matches nothing intuitive" bug this
--                         migration exists to fix.
--   * tool_call_count   — real tool invocations (Claude tool_use content
--                         blocks; OMP toolCall content items; Codex
--                         function_call / custom_tool_call payloads).
--
-- last_inference_id is ingest-internal bookkeeping (the id of the most
-- recently classified response-bearing line, so the next tick's dedup can
-- tell whether its first response line is a continuation of the previous
-- tick's call or a genuinely new one) — never surfaced to a caller.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own
-- transaction.

ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS prompt_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_inference_id  TEXT;

-- sessions:list aggregates this table GROUPed BY (source_kind, session_id)
-- (a session can, rarely, span >1 file/session_ingest_state row — e.g. a
-- rotated log) — this index makes that lookup + the sum() index-backed
-- instead of a seq scan as the table grows with the corpus (~23k+ files).
CREATE INDEX IF NOT EXISTS session_ingest_state_session_idx
  ON harness_shared.session_ingest_state (source_kind, session_id)
  WHERE session_id IS NOT NULL;
