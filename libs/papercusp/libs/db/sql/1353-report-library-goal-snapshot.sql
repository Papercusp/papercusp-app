-- WI-10005949 / P-001: reuse the report row and its exact-ID visibility/lineage.
-- Additive metadata only; legacy reports retain NULL and their original body.
ALTER TABLE harness_shared.report_library
  ADD COLUMN IF NOT EXISTS goal_owner_report jsonb;

CREATE OR REPLACE FUNCTION harness_shared.guard_goal_report_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD.goal_owner_report IS NOT NULL AND (
    NEW.goal_owner_report IS DISTINCT FROM OLD.goal_owner_report OR
    NEW.body_md IS DISTINCT FROM OLD.body_md OR
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.report_id IS DISTINCT FROM OLD.report_id OR
    NEW.subject_kind IS DISTINCT FROM OLD.subject_kind OR
    NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
  ) THEN
    RAISE EXCEPTION 'GOAL report snapshot identity is immutable; publish a successor';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE TRIGGER report_library_goal_snapshot_immutable
BEFORE UPDATE ON harness_shared.report_library
FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_goal_report_snapshot_immutable();
