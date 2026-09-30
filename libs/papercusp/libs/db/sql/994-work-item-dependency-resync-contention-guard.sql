-- 994-work-item-dependency-resync-contention-guard.sql
-- dependency-graph-admission-and-health-2026-08-27 / EI-21593117262092968
--
-- Migration 992 added the satisfaction-aware readiness predicate, but its
-- per-feature DO resync ran in the same runner transaction as ALTER TABLE.
-- PostgreSQL keeps that relation-level lock until the transaction commits, so
-- every scheduler read of work_item_deps queued behind the otherwise harmless
-- backfill.  Migration files are immutable once applied; this forward-only
-- migration repairs databases that already ran 992.
--
-- Keep this migration DML-only.  The runner supplies one transaction per file,
-- and these set-based statements take ordinary row/table DML locks rather than
-- an ACCESS EXCLUSIVE lock on work_item_deps.  A later dependency write can
-- therefore proceed while this reconciliation reads the graph.  The trigger
-- maintainer remains the authoritative incremental writer; this is only an
-- idempotent convergence pass for the existing sidecar.

-- Restore every feature-family key that the current satisfaction-aware oracle
-- says is blocked.  DO NOTHING avoids touching already-correct sidecar rows.
INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id)
SELECT f.workspace_id, f.harness_slug, f.feature_id
  FROM harness_shared.work_items f
 WHERE f.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
   AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id, f.workspace_id)
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

-- Remove stale rows, including rows for deleted or non-feature-family items.
DELETE FROM harness_shared.work_item_blocked wb
 WHERE NOT EXISTS (
   SELECT 1
     FROM harness_shared.work_items f
    WHERE f.workspace_id = wb.workspace_id
      AND f.harness_slug = wb.harness_slug
      AND f.feature_id = wb.feature_id
      AND f.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
      AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id, f.workspace_id)
 );
