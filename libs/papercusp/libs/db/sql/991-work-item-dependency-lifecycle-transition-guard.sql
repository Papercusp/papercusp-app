-- 991-work-item-dependency-lifecycle-transition-guard.sql
-- dependency-graph-admission-and-health-2026-08-26 P-011 / INV-19
--
-- A dependency edge changes what work is reachable. The canonical TypeScript
-- mutation boundary now refuses an unresolved blocker added behind an already
-- claimed or progressing dependant. This trigger closes the opposite raw-DML
-- directions at the unified work_items boundary:
--
--   * a dependant may not enter an active status while a live blocker exists;
--   * a settled blocker may not reopen behind a dependant that is claimed,
--     progressed, or terminal.
--
-- Named by-id claim remains the deliberate readiness override (D-008): taking
-- ownership of an already-blocked item is how an operator works its blocker.
-- The claim can therefore set taken_by, but the subsequent active-state
-- transition is refused until the final blocker is settled or removed.
--
-- The TypeScript writer takes ordered FOR SHARE locks on mutation endpoints.
-- UPDATE already owns the transitioning endpoint row before this BEFORE trigger
-- runs, and the trigger key-share-locks the incident edge and opposite endpoint.
-- Thus an edge mutation and lifecycle transition serialize in either order; a
-- contradictory partial post-state never commits.

CREATE OR REPLACE FUNCTION harness_shared.reject_inconsistent_dependency_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $dependency_lifecycle_guard$
DECLARE
  v_kind          text;
  v_ref           text;
  v_old_terminal  boolean;
  v_new_terminal  boolean;
  v_conflict      record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.item_kind = ANY (ARRAY['bug', 'change', 'task']) THEN
    v_kind := 'issue';
    v_ref := OLD.feature_id;
    v_old_terminal := lower(COALESCE(OLD.status, '')) = ANY (ARRAY['resolved', 'closed', 'done', 'dropped']);
  ELSE
    v_kind := 'feature';
    v_ref := OLD.harness_slug || '#' || OLD.feature_id;
    v_old_terminal := lower(COALESCE(OLD.status, '')) = ANY (ARRAY['passed', 'deprecated', 'done', 'dropped']);
  END IF;

  IF NEW.item_kind = ANY (ARRAY['bug', 'change', 'task']) THEN
    v_new_terminal := lower(COALESCE(NEW.status, '')) = ANY (ARRAY['resolved', 'closed', 'done', 'dropped']);
  ELSE
    v_new_terminal := lower(COALESCE(NEW.status, '')) = ANY (ARRAY['passed', 'deprecated', 'done', 'dropped']);
  END IF;

  -- Entering active work is the enforcement point after the intentionally
  -- ungated named claim. Lock both the live edge and blocker row so a concurrent
  -- settle/remove cannot produce a stale decision.
  IF lower(COALESCE(NEW.status, '')) = ANY (ARRAY['wip', 'in_progress', 'validating']) THEN
    SELECT d.blocker_kind, d.blocker_ref, blocker.status AS blocker_status
      INTO v_conflict
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items blocker
        ON blocker.workspace_id = NEW.workspace_id
       AND (
         (
           d.blocker_kind = 'issue'
           AND blocker.item_kind = ANY (ARRAY['bug', 'change', 'task'])
           AND d.blocker_ref = blocker.feature_id
         )
         OR
         (
           d.blocker_kind = 'feature'
           AND blocker.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
           AND d.blocker_ref = blocker.harness_slug || '#' || blocker.feature_id
         )
       )
     WHERE d.dep_type = 'blocks'
       AND d.blocked_kind = v_kind
       AND d.blocked_ref = v_ref
       AND (
         (
           blocker.item_kind = ANY (ARRAY['bug', 'change', 'task'])
           AND lower(COALESCE(blocker.status, '')) <> ALL (ARRAY['resolved', 'closed', 'done', 'dropped'])
         )
         OR
         (
           blocker.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
           AND lower(COALESCE(blocker.status, '')) <> ALL (ARRAY['passed', 'deprecated', 'done', 'dropped'])
         )
       )
     ORDER BY d.workspace_id, d.blocker_kind, d.blocker_ref
     LIMIT 1
     FOR KEY SHARE OF d, blocker;

    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'cannot move dependency dependant %s:%s to status %s while live blocker %s:%s is %s',
          v_kind, v_ref, NEW.status,
          v_conflict.blocker_kind, v_conflict.blocker_ref, v_conflict.blocker_status
        ),
        DETAIL = 'Settle or remove the final live blocker before entering active work. A named by-id claim may remain held while the blocker is worked.',
        CONSTRAINT = 'work_items_dependency_dependant_progress_guard',
        TABLE = 'work_items',
        SCHEMA = 'harness_shared';
    END IF;
  END IF;

  -- Reopening a settled blocker changes every incident edge from satisfied to
  -- live. It is safe only while all dependants are untouched, unclaimed, and
  -- nonterminal. A progressed/terminal dependant needs an explicit disposition,
  -- never an implicit retroactive block.
  IF v_old_terminal AND NOT v_new_terminal THEN
    SELECT d.blocked_kind,
           d.blocked_ref,
           dependant.status AS dependant_status,
           dependant.taken_by AS dependant_taken_by,
           dependant.last_progress_at AS dependant_last_progress_at
      INTO v_conflict
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items dependant
        ON dependant.workspace_id = OLD.workspace_id
       AND (
         (
           d.blocked_kind = 'issue'
           AND dependant.item_kind = ANY (ARRAY['bug', 'change', 'task'])
           AND d.blocked_ref = dependant.feature_id
         )
         OR
         (
           d.blocked_kind = 'feature'
           AND dependant.item_kind <> ALL (ARRAY['bug', 'change', 'task'])
           AND d.blocked_ref = dependant.harness_slug || '#' || dependant.feature_id
         )
       )
     WHERE d.dep_type = 'blocks'
       AND d.blocker_kind = v_kind
       AND d.blocker_ref = v_ref
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
     ORDER BY d.workspace_id, d.blocked_kind, d.blocked_ref
     LIMIT 1
     FOR KEY SHARE OF d, dependant;

    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'cannot reopen dependency blocker %s:%s while dependant %s:%s is claimed, progressed, or terminal',
          v_kind, v_ref, v_conflict.blocked_kind, v_conflict.blocked_ref
        ),
        DETAIL = format(
          'Dependant status=%s, taken_by=%s, last_progress_at=%s. Reconcile or explicitly disposition it in the same owning workflow before reopening the blocker.',
          v_conflict.dependant_status,
          COALESCE(v_conflict.dependant_taken_by, 'null'),
          COALESCE(v_conflict.dependant_last_progress_at::text, 'null')
        ),
        CONSTRAINT = 'work_items_dependency_blocker_reopen_guard',
        TABLE = 'work_items',
        SCHEMA = 'harness_shared';
    END IF;
  END IF;

  RETURN NEW;
END;
$dependency_lifecycle_guard$;

DROP TRIGGER IF EXISTS work_items_dependency_lifecycle_guard_trg
  ON harness_shared.work_items;
CREATE TRIGGER work_items_dependency_lifecycle_guard_trg
BEFORE UPDATE OF status ON harness_shared.work_items
FOR EACH ROW
EXECUTE FUNCTION harness_shared.reject_inconsistent_dependency_lifecycle_transition();

COMMENT ON FUNCTION harness_shared.reject_inconsistent_dependency_lifecycle_transition() IS
  'P-011 / INV-19 dependency lifecycle guard. Preserves named-claim override, refuses active progress behind a live blocker, and refuses reopening a settled blocker behind a claimed, progressed, or terminal dependant.';
