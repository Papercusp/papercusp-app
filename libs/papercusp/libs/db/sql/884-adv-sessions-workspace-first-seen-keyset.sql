-- 884 — stable workspace Sessions-history keyset (P-010).
--
-- `started_at` is deliberately bumped when a session resumes; it therefore
-- cannot order a cursor across requests without moving already-seen rows.
-- Migration 707 introduced the immutable `first_seen_at` birth timestamp.
-- The Sessions history row feed now orders by `(first_seen_at, id)` inside one
-- workspace, so this index keeps every cursor page bounded as the ledger grows.

CREATE INDEX IF NOT EXISTS adv_sessions_workspace_first_seen_idx
  ON harness_shared.adv_sessions (workspace_id, first_seen_at DESC, id DESC);
