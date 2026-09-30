-- 235-cross-hive-asks-asked-by.sql
-- Activates the dormant asked_by coord-notify leg (hive-network-surface-2026-06-11
-- P-014, item 4). Adds `asked_by text` to cross_hive_asks so the asking agent's
-- ownerId is stored on OUT rows: when a reply arrives the C-4 event gets
-- `to: [askedBy]` in cross-hive-wiring.ts (persistAndEmitReply already has the
-- seam — `result.row.askedBy ? { to: [result.row.askedBy] }` — but the column was
-- absent, so the field was always undefined). A NULL means the row predates this
-- migration or the tool caller did not supply their identity (graceful degradation
-- to the broadcast path).
\set ON_ERROR_STOP on

ALTER TABLE harness_shared.cross_hive_asks
  ADD COLUMN IF NOT EXISTS asked_by text;

-- Index: most queries that use asked_by filter by (workspace_id, hive_slug) first;
-- the column itself is searched rarely and has high cardinality, so no separate
-- index — the existing listing_idx covers the common list+notify path.
