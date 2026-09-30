-- 311-pending-wakes-workspace-idx.sql
-- EI-1426: coord:wake-queue repeatedly timed out (60s) on a bloated table
-- because listAllPendingWakes / countAllPendingWakes filter by workspace_id
-- but no index existed for that predicate.  PostgreSQL fell back to a full
-- sequential scan for the WHERE workspace_id = ? predicate, even with LIMIT
-- 500, because the existing pending_wakes_owner_idx (owner_id, id) is useless
-- for workspace-id-filtered reads.
--
-- This composite index covers both the workspace filter (the leading column)
-- AND the ORDER BY owner_id, id sort that follows it, so listAllPendingWakes
-- becomes a single index-range scan instead of a full seqscan + filesort.
-- countAllPendingWakes (the roster badge) benefits from the same index.
--
-- Additive + safe: a non-unique btree index; idempotent (IF NOT EXISTS).
-- Does not lock the table for writes (standard CREATE INDEX during startup/
-- migration apply, not CONCURRENTLY because this runs inside the boot-apply
-- path; tables are idle at that point).

CREATE INDEX IF NOT EXISTS pending_wakes_workspace_idx
    ON harness_shared.pending_wakes (workspace_id, owner_id, id);

COMMENT ON INDEX harness_shared.pending_wakes_workspace_idx IS
  'EI-1426: workspace-scoped board reads (listAllPendingWakes / countAllPendingWakes) — covers WHERE workspace_id = ? ORDER BY owner_id, id to avoid full seqscan on debris-laden queues.';
