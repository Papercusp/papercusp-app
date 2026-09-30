-- 525-fleet-assignment-work-items-notify.sql
--
-- Migration 374 promoted harness_shared.work_items to the feature/issue base
-- table and left harness_features_consolidated / engineer_issues as compat
-- views. The old fleet-assignment triggers moved with the renamed table, but
-- notify_fleet_assignment() still only recognized the pre-unification table
-- names, so work-item claim notifications emitted source='work_items' with an
-- empty agent. Teach the notifier the unified table and bind the triggers to
-- the current base table explicitly.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION harness_shared.notify_fleet_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
DECLARE
  rec record;
  src text;
  agent text;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'coord_presence' THEN
      src := 'presence';            agent := rec.owner_id;
    WHEN 'plan_item_claims' THEN
      src := 'plan_item_claim';     agent := rec.owner;
    WHEN 'plan_item_assignments' THEN
      src := 'plan_item_assignment';
      -- on release/unassign NEW.assignee_name may be NULL — fall back to OLD's.
      agent := COALESCE(rec.assignee_name, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assignee_name END);
    WHEN 'harness_features_consolidated' THEN
      src := 'work_item_claim';
      agent := COALESCE(rec.taken_by, CASE WHEN TG_OP = 'UPDATE' THEN OLD.taken_by END);
    WHEN 'engineer_issues' THEN
      src := 'work_item_claim';
      agent := COALESCE(rec.assignee, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assignee END);
    WHEN 'work_items' THEN
      src := 'work_item_claim';
      agent := COALESCE(rec.taken_by, CASE WHEN TG_OP = 'UPDATE' THEN OLD.taken_by END);
    ELSE
      src := TG_TABLE_NAME;         agent := NULL;
  END CASE;
  PERFORM pg_notify('fleet_assignment',
    COALESCE(rec.workspace_id, '') || '::' || src || '::' || COALESCE(agent, ''));
  RETURN rec;
END;
$fn$;

DROP TRIGGER IF EXISTS fleet_assignment_features_ins_trg ON harness_shared.work_items;
CREATE TRIGGER fleet_assignment_features_ins_trg
  AFTER INSERT ON harness_shared.work_items
  FOR EACH ROW
  WHEN (NEW.taken_by IS NOT NULL)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

DROP TRIGGER IF EXISTS fleet_assignment_features_upd_trg ON harness_shared.work_items;
CREATE TRIGGER fleet_assignment_features_upd_trg
  AFTER UPDATE ON harness_shared.work_items
  FOR EACH ROW
  WHEN (OLD.taken_by IS DISTINCT FROM NEW.taken_by)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
