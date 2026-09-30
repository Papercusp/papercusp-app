-- 433-coord-presence-context-tokens.sql — cached per-session context-size estimate.
-- Adds coord_presence.context_tokens (int) + context_estimated_at (timestamptz):
-- the compaction-compliance watchdog estimates each session's current context tokens
-- on a cadence (OFF the per-turn hot path) and caches them here; the per-turn usage
-- signal (coord:inbox injection) reads context_tokens vs compaction_limit to render
-- `context: N/L (X%)`. agent-managed-compaction-2026-07-01 (P-007 / P-009).
--
-- The migration runner wraps each file in its own txn — NO top-level BEGIN;/COMMIT;
-- (lint:migrations, files >= 215).

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS context_tokens       integer,
  ADD COLUMN IF NOT EXISTS context_estimated_at timestamptz;
