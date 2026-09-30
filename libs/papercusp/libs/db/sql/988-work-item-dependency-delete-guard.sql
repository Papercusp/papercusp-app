-- 988-work-item-dependency-delete-guard.sql
-- dependency-graph-admission-and-health-2026-08-26 P-007 / D-001/D-002/D-003
--
-- A work-item endpoint cannot be hard-deleted while a canonical dependency
-- edge still names it.  Without this guard, endpoint deletion can race the
-- serializable dependency writer and leave an edge whose endpoint no longer
-- resolves.  PostgreSQL can serialize that history as "edge insert, then row
-- delete", so SSI alone is not an application-level referential-integrity
-- guarantee.
--
-- The TypeScript mutation boundary takes ordered FOR SHARE locks on every
-- mutation-declared endpoint.  A concurrent DELETE therefore either:
--   1. commits first, after which the mutation retries and rejects the missing
--      endpoint; or
--   2. waits for the mutation, then observes its incident edge here and is
--      refused with SQLSTATE 23503.
-- In both orders exactly one conflicting operation loses and the committed
-- graph remains resolvable.
--
-- This is a REFUSAL guard, not another dependency writer.  Migration 734's
-- repoint_qualified_refs_on_rehome trigger remains the sole raw work_item_deps
-- DML capability: re-home preserves topology and re-points the old identity in
-- the same UPDATE transaction.  Deletion must explicitly remove/disposition
-- incident edges through the canonical mutation seam before retrying.

CREATE OR REPLACE FUNCTION harness_shared.reject_work_item_delete_with_dependencies()
RETURNS trigger
LANGUAGE plpgsql
AS $delete_guard$
DECLARE
  v_canonical_kind text;
  v_canonical_ref  text;
  v_edge           record;
BEGIN
  IF OLD.item_kind = ANY (ARRAY['bug', 'change', 'task']) THEN
    v_canonical_kind := 'issue';
    v_canonical_ref := OLD.feature_id;
  ELSE
    v_canonical_kind := 'feature';
    v_canonical_ref := OLD.harness_slug || '#' || OLD.feature_id;
  END IF;

  SELECT d.blocked_kind, d.blocked_ref, d.blocker_kind, d.blocker_ref
    INTO v_edge
    FROM harness_shared.work_item_deps d
   WHERE d.dep_type = 'blocks'
     AND (
       (d.blocked_kind = v_canonical_kind AND d.blocked_ref = v_canonical_ref)
       OR
       (d.blocker_kind = v_canonical_kind AND d.blocker_ref = v_canonical_ref)
     )
   ORDER BY d.workspace_id, d.blocked_kind, d.blocked_ref,
            d.blocker_kind, d.blocker_ref
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format(
        'cannot delete dependency endpoint %s:%s while incident edge %s:%s -> %s:%s exists',
        v_canonical_kind, v_canonical_ref,
        v_edge.blocked_kind, v_edge.blocked_ref,
        v_edge.blocker_kind, v_edge.blocker_ref
      ),
      DETAIL = 'Remove or disposition every incident dependency through mutateWorkItemDependencies in the same owning workflow, then retry the endpoint deletion.',
      CONSTRAINT = 'work_items_dependency_endpoint_delete_guard',
      TABLE = 'work_items',
      SCHEMA = 'harness_shared';
  END IF;

  RETURN OLD;
END;
$delete_guard$;

DROP TRIGGER IF EXISTS work_items_dependency_endpoint_delete_guard_trg
  ON harness_shared.work_items;
CREATE TRIGGER work_items_dependency_endpoint_delete_guard_trg
BEFORE DELETE ON harness_shared.work_items
FOR EACH ROW
EXECUTE FUNCTION harness_shared.reject_work_item_delete_with_dependencies();

COMMENT ON FUNCTION harness_shared.reject_work_item_delete_with_dependencies() IS
  'P-007 dependency endpoint integrity guard. Refuses hard deletion while a canonical issue/feature blocks edge names the row; callers must remove or disposition incident edges through the canonical dependency mutation transaction first.';
