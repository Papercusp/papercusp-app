-- 370-backfill-work-item-deps.sql
--
-- work-item-deps-and-readiness-2026-06-22 — P-003 (cutover, step 1: backfill).
--
-- Copy every EXISTING feature→feature coord_links rel='blocks' edge into the dedicated
-- work_item_deps table, so it starts life as a complete mirror. The TS write-path
-- (syncFeatureBlockEdges) dual-writes from here on (transitional), and the blockersOf() seam
-- will flip its read to work_item_deps once this backfill + dual-write are in place.
--
-- coord_links blocks convention (feature-blockers-edges.ts): src = BLOCKER, dst = BLOCKED.
-- work_item_deps convention: blocked_ref = the dependent, blocker_ref = the prerequisite.
-- So: blocked = coord_links.dst, blocker = coord_links.src.
--
-- Scoped to feature→feature (what the seam reads today); issue→feature is a later follow.
-- Idempotent: ON CONFLICT on the unique edge index does nothing (safe to re-run / re-deploy).

INSERT INTO harness_shared.work_item_deps
  (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by, created_at)
SELECT
  l.workspace_id,
  l.dst_kind  AS blocked_kind,
  l.dst_ref   AS blocked_ref,
  l.src_kind  AS blocker_kind,
  l.src_ref   AS blocker_ref,
  'blocks'    AS dep_type,
  COALESCE(l.created_by, 'mig-370-backfill') AS created_by,
  COALESCE(l.created_at, now())              AS created_at
FROM harness_shared.coord_links l
WHERE l.rel = 'blocks'
  AND l.src_kind = 'feature'
  AND l.dst_kind = 'feature'
  AND NOT (l.src_kind = l.dst_kind AND l.src_ref = l.dst_ref)  -- skip any self-edge
ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type) DO NOTHING;
