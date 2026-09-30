-- 996-work-item-completion-settlement-readiness.sql
-- A lifecycle-terminal proposed close is not delivery-settled. Keep the SQL
-- readiness oracle and its maintained sidecar aligned with the shared
-- TypeScript isCompletionSettled predicate. NULL authority remains the legacy
-- compatibility close; every explicit authority except committed/validated blocks.

CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(
    p_harness text, p_feature text, p_workspace text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM harness_shared.work_item_deps d
     WHERE d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocked_ref = p_harness || '#' || p_feature
       AND (
         EXISTS (
           SELECT 1 FROM harness_shared.work_items bf
            WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
              AND bf.workspace_id = p_workspace
              AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
              AND (
                (bf.authority IS NOT NULL AND bf.authority NOT IN ('committed', 'validated')
                  AND lower(COALESCE(bf.status, '')) NOT IN ('deprecated', 'dropped'))
                OR (d.satisfaction = 'settled' AND lower(COALESCE(bf.status, '')) <> ALL (ARRAY['passed','deprecated','done','dropped']))
                OR (d.satisfaction = 'success' AND lower(COALESCE(bf.status, '')) <> ALL (ARRAY['passed','done']))
              )
         )
         OR EXISTS (
           SELECT 1 FROM harness_shared.work_items bi
            WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
              AND bi.workspace_id = p_workspace
              AND bi.feature_id = d.blocker_ref
              AND (
                (bi.authority IS NOT NULL AND bi.authority NOT IN ('committed', 'validated')
                  AND lower(COALESCE(bi.status, '')) NOT IN ('closed', 'dropped'))
                OR (d.satisfaction = 'settled' AND lower(COALESCE(bi.status, '')) <> ALL (ARRAY['resolved','closed','done','dropped']))
                OR (d.satisfaction = 'success' AND lower(COALESCE(bi.status, '')) <> ALL (ARRAY['resolved','done']))
              )
         )
       )
  );
$function$;

-- Authority promotion proposed -> committed does not cross a lifecycle-status
-- boundary, so it must independently refresh every dependant's sidecar row.
DROP TRIGGER IF EXISTS wir_status_sync_dependents_trg ON harness_shared.work_items;
CREATE TRIGGER wir_status_sync_dependents_trg
    AFTER UPDATE OF status, authority ON harness_shared.work_items
    FOR EACH ROW
    WHEN (
      ((OLD.status IN ('passed','deprecated','resolved','closed','done','dropped'))
        AND (OLD.status IN ('deprecated','closed','dropped')
          OR COALESCE(OLD.authority IN ('committed','validated'), true)))
      IS DISTINCT FROM
      ((NEW.status IN ('passed','deprecated','resolved','closed','done','dropped'))
        AND (NEW.status IN ('deprecated','closed','dropped')
          OR COALESCE(NEW.authority IN ('committed','validated'), true)))
    )
    EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();

DO $resync$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT workspace_id, harness_slug, feature_id
      FROM harness_shared.work_items
     WHERE item_kind <> ALL (ARRAY['bug','change','task'])
  LOOP
    PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id);
  END LOOP;
END
$resync$;
