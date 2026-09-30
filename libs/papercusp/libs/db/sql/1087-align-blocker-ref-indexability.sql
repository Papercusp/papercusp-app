-- 1087-align-blocker-ref-indexability.sql
-- EI-218628
--
-- The feature-family claim floor and the maintained work_item_blocked sidecar
-- must use the same blocker-resolution predicate. The TypeScript inline floor
-- already has a guarded split form (the same shape as unsatisfiedBlockerSql),
-- but the applied work_item_is_blocked() oracle still concatenates
-- (bf.harness_slug, bf.feature_id) before comparing to blocker_ref.
--
-- That candidate-side concatenation prevents the work_items primary key from
-- serving the blocker lookup. blocker_ref is written as <harness>#<feature>,
-- and harness slugs cannot contain '#', so splitting at the first separator is
-- a lossless inverse. The guard preserves the old behavior for malformed refs
-- with no separator.

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
              -- EI-218628: split the dep-side scalar so the work_items primary
              -- key can serve (harness_slug, feature_id) directly.
              AND position('#' in d.blocker_ref) > 0
              AND bf.harness_slug = split_part(d.blocker_ref, '#', 1)
              AND bf.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1)
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

-- The sidecar is derived from work_item_is_blocked(). Reconcile every
-- feature-family row after replacing the oracle so future maintained-ready
-- reads cannot retain stale membership decisions.
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
