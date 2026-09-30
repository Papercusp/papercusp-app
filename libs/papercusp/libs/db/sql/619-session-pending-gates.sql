-- 619-session-pending-gates.sql — owner-inbox-single-pane-2026-07-17 P-002.
--
-- session_pending_gates — one row per OPEN (or since-closed) owner-gate: a
-- point where a session is blocked waiting on the human owner (an
-- AskUserQuestion / permission-shaped tool_use with no tool_result yet, a
-- Notification-hook permission-wait, or a hook-mirrored structured ask).
-- Client-agnostic by design (plan Background): fed by TWO producers that both
-- upsert the SAME table —
--   * the ingest tool `attention:ingest-gate-event` (hook push path: P-001
--     Claude Stop/PreToolUse/Notification hooks, P-004 OMP turn_end port);
--   * the transcript watcher (`packages/operator-core/lib/attention/gate-watch.ts`,
--     client-agnostic pull path — tails ~/.claude/projects/**.jsonl looking for
--     an unanswered tool_use on a gate-shaped tool name).
-- `ref_id` is the correlation key: the watcher uses the transcript's own
-- tool_use id; a hook generates its own uuid and repeats it on the matching
-- 'cleared' ingest event. The (workspace_id, session_id, ref_id) unique
-- constraint makes re-ticking idempotent — re-observing the same open ask is
-- a no-op, never a duplicate row.
--
-- This is the NEW attention source P-005 wires into plans/attention.ts
-- (adapters.ts pure-mapper pattern) — this migration + the store/watcher only;
-- attention.ts itself is the P-005 lane (owner-inbox-single-pane Constraints).
--
-- session_gate_watcher_files — per-transcript-file byte watermarks for the
-- watcher, same idempotency shape as harness_shared.interactive_usage_files
-- (210) but kept as its own table: a different consumer/producer, and mixing
-- two unrelated ingesters' watermarks in one shared table would couple two
-- independently-evolving lanes for no benefit.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.session_pending_gates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  session_id    TEXT        NOT NULL,        -- native client session/thread id
  client        TEXT        NOT NULL DEFAULT 'claude' CHECK (client IN ('claude', 'omp', 'codex')),
  kind          TEXT        NOT NULL CHECK (kind IN ('ask', 'permission_wait')),
  ref_id        TEXT        NOT NULL,        -- transcript tool_use id, or a hook-generated uuid
  owner_id      TEXT,                        -- asking agent's coord identity, when known
  question      TEXT,
  options       JSONB,
  source        TEXT        NOT NULL DEFAULT 'watcher' CHECK (source IN ('watcher', 'hook')),
  raw_ref       TEXT,                        -- transcript file path (debugging)
  harness_slug  TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  closed_reason TEXT CHECK (closed_reason IS NULL OR closed_reason IN ('tool_result_observed', 'hook_cleared')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.session_pending_gates IS
  'Client-agnostic owner-gate tracker: one row per ask/permission-wait a session is blocked on, opened by the ingest tool or the transcript watcher and closed when the tool_result/hook-cleared signal lands. The blocked-sessions surface + the new attention source (owner-inbox-single-pane P-002).';

-- Idempotent open: re-observing the same (session, ref_id) is a no-op update,
-- never a duplicate row — both producers (hook push + watcher pull) may
-- observe the same ask.
CREATE UNIQUE INDEX IF NOT EXISTS session_pending_gates_ref_uq
  ON harness_shared.session_pending_gates (workspace_id, session_id, ref_id);

-- The blocked-sessions surface + the attention adapter both list OPEN gates,
-- newest first, scoped by workspace — partial index keeps it small forever
-- (closed rows fall out of this index entirely).
CREATE INDEX IF NOT EXISTS session_pending_gates_open_idx
  ON harness_shared.session_pending_gates (workspace_id, opened_at DESC)
  WHERE closed_at IS NULL;

-- Retention / debugging scans by age.
CREATE INDEX IF NOT EXISTS session_pending_gates_created_idx
  ON harness_shared.session_pending_gates (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_pending_gates TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_pending_gates TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

GRANT USAGE ON SEQUENCE harness_shared.session_pending_gates_id_seq TO harness_app;

CREATE TABLE IF NOT EXISTS harness_shared.session_gate_watcher_files (
  workspace_id TEXT        NOT NULL,
  file_path    TEXT        NOT NULL,
  byte_offset  BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, file_path)
);

COMMENT ON TABLE harness_shared.session_gate_watcher_files IS
  'Ingest watermarks for the client-agnostic session-gate transcript watcher (owner-inbox-single-pane P-002) — byte offset of the end of the last fully-parsed JSONL line per transcript file.';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_gate_watcher_files TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_gate_watcher_files TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
