-- WI-10006171: 1109 added a generic notifier beside 367's semantic producer.
-- Keep one notification with both dependency refs and generic row-routing fields.
-- Reuse the existing producer and trigger; no table or data shape changes.
CREATE OR REPLACE FUNCTION harness_shared.emit_work_item_dep_change_notify()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_jsonb jsonb := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  PERFORM pg_notify('sync_invalidate', jsonb_build_object(
    'name', 'harness_shared.work_item_deps.changed',
    'args', jsonb_build_object(
      'workspace_id', current_setting('app.workspace_id', true),
      'op', TG_OP,
      'id', row_jsonb -> 'id',
      'plan_slug', row_jsonb -> 'plan_slug',
      'harness_slug', row_jsonb -> 'harness_slug',
      'dep_type', row_jsonb -> 'dep_type',
      'blocked_kind', row_jsonb -> 'blocked_kind',
      'blocked_ref', row_jsonb -> 'blocked_ref',
      'blocker_kind', row_jsonb -> 'blocker_kind',
      'blocker_ref', row_jsonb -> 'blocker_ref'
    )
  )::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER emit_work_item_dep_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_item_deps
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_work_item_dep_change_notify();

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.work_item_deps;
