-- 875 — preserve existing payload keys on partial engineer_issues view updates.
--
-- EI-19478945486999152
--
-- The issue-family compatibility view's INSTEAD OF UPDATE trigger normalizes the
-- caller's NEW.payload, then writes it as the complete stored payload (apart from
-- the rebuilt `_ei` metadata). A caller that sends a natural partial object can
-- therefore erase scheduler/lease control state such as `_claimHold`,
-- `claim_hold_by`, and `held_open_by` without an audit row. The direct merge
-- helpers already patch the base row; this closes the same class at the view
-- boundary.
--
-- Preserve the view's existing `_ei` rebuild semantics while merging the
-- caller-supplied payload over the stored object. Explicit key removal remains
-- available through the base-table merge helpers' `unset` path; a partial view
-- update is no longer interpreted as an unreviewable whole-object replacement.
--
-- Idempotent: a second application sees the patched assignment and does nothing.

DO $mig875$
DECLARE
  def text;
  patched text;
  old_assignment CONSTANT text := 'payload = (v_payload - ''_ei'') || jsonb_build_object(''_ei'', v_ei),';
  new_assignment CONSTANT text := 'payload = COALESCE(payload, ''{}''::jsonb) || (v_payload - ''_ei'') || jsonb_build_object(''_ei'', v_ei),';
  n_old integer;
  n_new integer;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '875: harness_shared.engineer_issues_view_dml() not found';
  END IF;

  n_new := (length(def) - length(replace(def, new_assignment, ''))) / length(new_assignment);
  IF n_new = 1 THEN
    RAISE NOTICE '875: engineer_issues_view_dml already merges stored payload keys — no-op';
    RETURN;
  ELSIF n_new <> 0 THEN
    RAISE EXCEPTION '875: expected at most one already-patched payload assignment, found %', n_new;
  END IF;

  n_old := (length(def) - length(replace(def, old_assignment, ''))) / length(old_assignment);
  IF n_old <> 1 THEN
    RAISE EXCEPTION
      '875: expected exactly one unpatched payload assignment in engineer_issues_view_dml, found %; re-derive the migration anchor instead of forcing it',
      n_old;
  END IF;

  patched := replace(def, old_assignment, new_assignment);
  EXECUTE patched;

  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  n_new := (length(def) - length(replace(def, new_assignment, ''))) / length(new_assignment);
  n_old := (length(def) - length(replace(def, old_assignment, ''))) / length(old_assignment);
  IF n_new <> 1 OR n_old <> 0 THEN
    RAISE EXCEPTION
      '875: post-condition failed — patched assignments=% unpatched assignments=%',
      n_new, n_old;
  END IF;

  RAISE NOTICE '875: engineer_issues_view_dml now preserves existing payload keys on partial updates';
END
$mig875$;
