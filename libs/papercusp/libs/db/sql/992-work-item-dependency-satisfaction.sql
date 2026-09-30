-- 992-work-item-dependency-satisfaction.sql
-- dependency-graph-admission-and-health-2026-08-26 P-004
-- Expand-only: one canonical edge gains an outcome requirement without changing identity.

ALTER TABLE harness_shared.work_item_deps
  ADD COLUMN IF NOT EXISTS satisfaction text NOT NULL DEFAULT 'settled';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.work_item_deps'::regclass
       AND conname = 'work_item_deps_satisfaction_check'
  ) THEN
    ALTER TABLE harness_shared.work_item_deps
      ADD CONSTRAINT work_item_deps_satisfaction_check
      CHECK (satisfaction IN ('settled', 'success'));
  END IF;
END
$constraint$;

COMMENT ON COLUMN harness_shared.work_item_deps.satisfaction IS
  'Outcome required from the blocker: settled accepts success or abandonment; success accepts only passed/done/resolved. Omission defaults to settled for compatibility.';

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
                (d.satisfaction = 'settled' AND lower(COALESCE(bf.status, '')) <> ALL (ARRAY['passed','deprecated','done','dropped']))
                OR
                (d.satisfaction = 'success' AND lower(COALESCE(bf.status, '')) <> ALL (ARRAY['passed','done']))
              )
         )
         OR EXISTS (
           SELECT 1 FROM harness_shared.work_items bi
            WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
              AND bi.workspace_id = p_workspace
              AND bi.feature_id = d.blocker_ref
              AND (
                (d.satisfaction = 'settled' AND lower(COALESCE(bi.status, '')) <> ALL (ARRAY['resolved','closed','done','dropped']))
                OR
                (d.satisfaction = 'success' AND lower(COALESCE(bi.status, '')) <> ALL (ARRAY['resolved','done']))
              )
         )
       )
  );
$function$;

CREATE OR REPLACE FUNCTION harness_shared.reject_inconsistent_dependency_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_kind text;
  v_ref text;
  v_old_status text := lower(COALESCE(OLD.status, ''));
  v_new_status text := lower(COALESCE(NEW.status, ''));
  v_conflict record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF OLD.item_kind = ANY (ARRAY['bug','change','task']) THEN
    v_kind := 'issue'; v_ref := OLD.feature_id;
  ELSE
    v_kind := 'feature'; v_ref := OLD.harness_slug || '#' || OLD.feature_id;
  END IF;

  IF v_new_status = ANY (ARRAY['wip','in_progress','validating']) THEN
    SELECT d.blocker_kind, d.blocker_ref, blocker.status AS blocker_status, d.satisfaction
      INTO v_conflict
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items blocker
        ON blocker.workspace_id = NEW.workspace_id
       AND ((d.blocker_kind='issue' AND blocker.item_kind=ANY(ARRAY['bug','change','task']) AND d.blocker_ref=blocker.feature_id)
         OR (d.blocker_kind='feature' AND blocker.item_kind<>ALL(ARRAY['bug','change','task']) AND d.blocker_ref=blocker.harness_slug||'#'||blocker.feature_id))
     WHERE d.dep_type='blocks' AND d.blocked_kind=v_kind AND d.blocked_ref=v_ref
       AND CASE
         WHEN d.satisfaction='success' AND blocker.item_kind=ANY(ARRAY['bug','change','task']) THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['resolved','done'])
         WHEN d.satisfaction='success' THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['passed','done'])
         WHEN blocker.item_kind=ANY(ARRAY['bug','change','task']) THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['resolved','closed','done','dropped'])
         ELSE lower(COALESCE(blocker.status,''))<>ALL(ARRAY['passed','deprecated','done','dropped'])
       END
     ORDER BY d.workspace_id,d.blocker_kind,d.blocker_ref LIMIT 1 FOR KEY SHARE OF d,blocker;
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE=format('cannot move dependency dependant %s:%s to status %s while %s blocker %s:%s is %s',v_kind,v_ref,NEW.status,v_conflict.satisfaction,v_conflict.blocker_kind,v_conflict.blocker_ref,v_conflict.blocker_status),
        CONSTRAINT='work_items_dependency_dependant_progress_guard',TABLE='work_items',SCHEMA='harness_shared';
    END IF;
  END IF;

  SELECT d.blocked_kind,d.blocked_ref,dependant.status AS dependant_status
    INTO v_conflict
    FROM harness_shared.work_item_deps d
    JOIN harness_shared.work_items dependant
      ON dependant.workspace_id=OLD.workspace_id
     AND ((d.blocked_kind='issue' AND dependant.item_kind=ANY(ARRAY['bug','change','task']) AND d.blocked_ref=dependant.feature_id)
       OR (d.blocked_kind='feature' AND dependant.item_kind<>ALL(ARRAY['bug','change','task']) AND d.blocked_ref=dependant.harness_slug||'#'||dependant.feature_id))
   WHERE d.dep_type='blocks' AND d.blocker_kind=v_kind AND d.blocker_ref=v_ref
     AND (
       (d.satisfaction='success' AND (
         (NEW.item_kind=ANY(ARRAY['bug','change','task']) AND v_new_status=ANY(ARRAY['closed','dropped']))
         OR (NEW.item_kind<>ALL(ARRAY['bug','change','task']) AND v_new_status=ANY(ARRAY['deprecated','dropped']))
       ))
       OR (
         CASE WHEN d.satisfaction='success'
              THEN CASE WHEN OLD.item_kind=ANY(ARRAY['bug','change','task']) THEN v_old_status=ANY(ARRAY['resolved','done']) ELSE v_old_status=ANY(ARRAY['passed','done']) END
              ELSE CASE WHEN OLD.item_kind=ANY(ARRAY['bug','change','task']) THEN v_old_status=ANY(ARRAY['resolved','closed','done','dropped']) ELSE v_old_status=ANY(ARRAY['passed','deprecated','done','dropped']) END END
         AND NOT CASE WHEN d.satisfaction='success'
              THEN CASE WHEN NEW.item_kind=ANY(ARRAY['bug','change','task']) THEN v_new_status=ANY(ARRAY['resolved','done']) ELSE v_new_status=ANY(ARRAY['passed','done']) END
              ELSE CASE WHEN NEW.item_kind=ANY(ARRAY['bug','change','task']) THEN v_new_status=ANY(ARRAY['resolved','closed','done','dropped']) ELSE v_new_status=ANY(ARRAY['passed','deprecated','done','dropped']) END END
       )
     )
     AND (
       (
         NULLIF(btrim(dependant.taken_by), '') IS NOT NULL
         AND lower(btrim(dependant.taken_by)) <> 'unassigned'
       )
       OR lower(COALESCE(dependant.status, '')) = ANY (ARRAY['wip', 'in_progress', 'validating'])
       OR dependant.last_progress_at IS NOT NULL
       OR (
         dependant.item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND lower(COALESCE(dependant.status, '')) = ANY (ARRAY['resolved', 'closed', 'done', 'dropped'])
       )
       OR (
         dependant.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
         AND lower(COALESCE(dependant.status, '')) = ANY (ARRAY['passed', 'deprecated', 'done', 'dropped'])
       )
     )
   ORDER BY d.workspace_id,d.blocked_kind,d.blocked_ref LIMIT 1 FOR KEY SHARE OF d,dependant;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE=format('cannot make dependency blocker %s:%s unsatisfied while nonterminal dependant %s:%s remains',v_kind,v_ref,v_conflict.blocked_kind,v_conflict.blocked_ref),
      CONSTRAINT='work_items_dependency_blocker_outcome_guard',TABLE='work_items',SCHEMA='harness_shared';
  END IF;
  RETURN NEW;
END;
$guard$;

DO $resync$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT f.workspace_id,f.harness_slug,f.feature_id
    FROM harness_shared.work_item_deps d JOIN harness_shared.work_items f
      ON f.item_kind<>ALL(ARRAY['bug','change','task']) AND f.harness_slug||'#'||f.feature_id=d.blocked_ref
    WHERE d.dep_type='blocks'
  LOOP
    PERFORM harness_shared.sync_work_item_blocked(r.workspace_id,r.harness_slug,r.feature_id);
  END LOOP;
END
$resync$;
