-- 935-canonical-work-item-blocking-edges.sql
--
-- WI-41166 / fleet-leader-bottleneck-observability-2026-08-24 P-004.
-- Make work_item_deps the sole source of truth for work-item -> work-item
-- `blocks` edges. coord_links remains canonical for every other relation and
-- for blocking edges whose endpoint is not a work item (plan_item, event, ...).
--
-- coord_links stores blocker(src) -> blocked(dst); work_item_deps stores the
-- same edge in blocked -> blocker columns. Historical coord rows exist under
-- several workspace ids, while every scheduler floor reads the coordination
-- workspace (`default`), so the backfill deliberately converges all tenants
-- into DEFAULT_COORD_WORKSPACE rather than preserving the stranded tenant key.

WITH canonical_coord_edges AS (
  SELECT DISTINCT ON (l.dst_kind, l.dst_ref, l.src_kind, l.src_ref)
         l.dst_kind AS blocked_kind,
         l.dst_ref AS blocked_ref,
         l.src_kind AS blocker_kind,
         l.src_ref AS blocker_ref,
         l.created_by,
         l.created_at
    FROM harness_shared.coord_links l
   WHERE l.rel = 'blocks'
     AND l.src_kind IN ('issue', 'feature')
     AND l.dst_kind IN ('issue', 'feature')
     AND NOT (l.src_kind = l.dst_kind AND l.src_ref = l.dst_ref)
   ORDER BY l.dst_kind, l.dst_ref, l.src_kind, l.src_ref, l.created_at ASC, l.id ASC
)
INSERT INTO harness_shared.work_item_deps AS existing
  (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref,
   dep_type, created_by, created_at)
SELECT 'default', blocked_kind, blocked_ref, blocker_kind, blocker_ref,
       'blocks', created_by, created_at
  FROM canonical_coord_edges
ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
DO UPDATE SET
  created_by = CASE
    WHEN EXCLUDED.created_at < existing.created_at THEN EXCLUDED.created_by
    ELSE COALESCE(existing.created_by, EXCLUDED.created_by)
  END,
  created_at = LEAST(existing.created_at, EXCLUDED.created_at);

DELETE FROM harness_shared.coord_links
 WHERE rel = 'blocks'
   AND src_kind IN ('issue', 'feature')
   AND dst_kind IN ('issue', 'feature');
