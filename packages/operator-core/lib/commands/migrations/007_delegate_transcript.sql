-- Persistent transcript per delegate. Each row in the JSONB array is
--   { ts: 'YYYY-MM-DDTHH:MM:SSZ', request: '...', response: '...' }
-- appended by /api/agent-mcp/delegate-chat on every `done` event.
--
-- JSONB instead of a side table because (a) we always read it together
-- with the delegate row, (b) typical session is <50 turns × ~3KB ≈ 150KB
-- per row which fits comfortably in JSONB, (c) keeps the snapshot
-- export simple — one row per delegate dumps cleanly to JSON.

ALTER TABLE harness_shared.delegates
  ADD COLUMN IF NOT EXISTS transcript JSONB NOT NULL DEFAULT '[]'::jsonb;
