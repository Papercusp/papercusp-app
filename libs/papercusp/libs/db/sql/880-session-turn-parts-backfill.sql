-- Migration 880 — resumable historical P-001 faithful-part backfill.
--
-- The session-turn-parts writer was added after session_ingest_state rows had
-- already reached EOF. Those rows have indexed turns but part_count=0, and a
-- normal tail sweep skips them because byte_offset is already at the file end.
-- Keep this repair cursor independent from byte_offset: resetting the live
-- cursor would replay session_turns and can only produce turn-index conflicts.

ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS parts_backfill_offset BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parts_backfilled_at TIMESTAMPTZ;

-- Rows that cannot participate in a file-part repair are terminally complete:
-- OMP/agent_chat have no parseParts adapter, offset-zero rows have no bytes,
-- and nonzero part_count rows were already handled by the live writer. The
-- remaining claude/codex rows with bytes and zero parts stay NULL/eligible.
UPDATE harness_shared.session_ingest_state
   SET parts_backfilled_at = COALESCE(parts_backfilled_at, now())
 WHERE parts_backfilled_at IS NULL
   AND (
     file_path = '__hwm__'
     OR source_kind NOT IN ('claude', 'codex')
     OR byte_offset = 0
     OR part_count <> 0
   );

COMMENT ON COLUMN harness_shared.session_ingest_state.parts_backfill_offset IS
  'P-001: byte cursor for the resumable historical session_turn_parts repair; distinct from byte_offset, which owns indexed text turns.';

COMMENT ON COLUMN harness_shared.session_ingest_state.parts_backfilled_at IS
  'P-001: timestamp when the historical faithful-part replay reached EOF (or the source was permanently unavailable). NULL means eligible/in progress.';
