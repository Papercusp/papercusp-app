-- P-005: replayable operation progress uses the existing append-only coord event
-- log. The canonical work_items and plan_runs rows remain the status/result
-- authority; these rows only record edges for bounded cursor replay.

CREATE OR REPLACE FUNCTION harness_shared.record_blueprint_work_item_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior_state text;
BEGIN
  IF NOT (COALESCE(NEW.payload, '{}'::jsonb) ? 'blueprintOperation'
          OR COALESCE(NEW.payload, '{}'::jsonb) ? 'plan_run') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.taken_by IS NOT DISTINCT FROM OLD.taken_by
       AND NEW.payload->'blueprintResult' IS NOT DISTINCT FROM OLD.payload->'blueprintResult'
       AND NEW.payload->'blueprintCancellation' IS NOT DISTINCT FROM OLD.payload->'blueprintCancellation' THEN
      RETURN NEW;
    END IF;
    prior_state := OLD.status;
  END IF;
  INSERT INTO harness_shared.coord_event_log
    (workspace_id, surface, writer_key, msg_id, body)
  VALUES
    (NEW.workspace_id, 'blueprint-operation', 'work-item:' || NEW.feature_id,
     gen_random_uuid()::text,
     jsonb_build_object(
       'kind', 'work-item', 'workItemId', NEW.feature_id,
       'harnessSlug', NEW.harness_slug,
       'runId', NEW.payload #>> '{plan_run,runId}',
       'state', NEW.status, 'prevState', prior_state,
       'assignee', NEW.taken_by,
       'outputStored', NEW.payload ? 'blueprintResult',
       'cancellationRequested', NEW.payload ? 'blueprintCancellation'
     ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blueprint_work_item_event_trg ON harness_shared.work_items;
CREATE TRIGGER blueprint_work_item_event_trg
AFTER INSERT OR UPDATE ON harness_shared.work_items
FOR EACH ROW EXECUTE FUNCTION harness_shared.record_blueprint_work_item_event();

CREATE OR REPLACE FUNCTION harness_shared.record_blueprint_plan_run_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior_status text;
BEGIN
  IF NEW.instance_plan_slug IS NULL THEN RETURN NEW; END IF;
  -- Ordinary scheduled runs share plan_runs. A blueprint plan target uses its
  -- invocation receipt id as the @run-N token even before target_ref is filled.
  IF NOT EXISTS (
    SELECT 1 FROM harness_shared.blueprint_operation_invocations AS receipt
     WHERE receipt.workspace_id = NEW.workspace_id
       AND receipt.harness_slug = NEW.harness_slug
       AND receipt.target_kind = 'plan'
       AND receipt.id = substring(NEW.instance_plan_slug FROM '@run-([0-9]+)$')::bigint
       AND (receipt.target_ref IS NULL OR receipt.target_ref = NEW.instance_plan_slug)
  ) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
       AND NEW.outputs IS NOT DISTINCT FROM OLD.outputs THEN
      RETURN NEW;
    END IF;
    prior_status := OLD.status;
  END IF;
  INSERT INTO harness_shared.coord_event_log
    (workspace_id, surface, writer_key, msg_id, body)
  VALUES
    (NEW.workspace_id, 'blueprint-operation', 'plan-run:' || NEW.id::text,
     gen_random_uuid()::text,
     jsonb_build_object(
       'kind', 'plan-run', 'runId', NEW.id::text,
       'instanceSlug', NEW.instance_plan_slug,
       'harnessSlug', NEW.harness_slug,
       'status', NEW.status, 'prevStatus', prior_status,
       'outcome', NEW.outcome, 'outputStored', NEW.outputs IS NOT NULL
     ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blueprint_plan_run_event_trg ON harness_shared.plan_runs;
CREATE TRIGGER blueprint_plan_run_event_trg
AFTER INSERT OR UPDATE ON harness_shared.plan_runs
FOR EACH ROW EXECUTE FUNCTION harness_shared.record_blueprint_plan_run_event();

CREATE INDEX IF NOT EXISTS coord_blueprint_work_item_events_idx
  ON harness_shared.coord_event_log (workspace_id, (body->>'workItemId'), id)
  WHERE surface = 'blueprint-operation' AND body->>'workItemId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS coord_blueprint_plan_run_events_idx
  ON harness_shared.coord_event_log (workspace_id, (body->>'runId'), id)
  WHERE surface = 'blueprint-operation' AND body->>'runId' IS NOT NULL;

-- Client input receipts use deterministic msg_id values. The same append-only
-- log thus rejects concurrent duplicate signal/resume/cancel admission without
-- creating a second task or operation-state table.
-- FORWARD-COMPAT: This partial uniqueness fence is scoped to the new
-- `blueprint-operation` surface. The reviewed green release has no writer for
-- this surface; the staging receipt writer uses untargeted `ON CONFLICT DO NOTHING`,
-- which does not need to infer this partial arbiter. Existing shared-workspace rows
-- for this surface were measured at zero before this migration.
CREATE UNIQUE INDEX IF NOT EXISTS coord_blueprint_operation_msg_uq
  ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
  WHERE surface = 'blueprint-operation';

CREATE INDEX IF NOT EXISTS coord_blueprint_operation_receipt_events_idx
  ON harness_shared.coord_event_log (workspace_id, writer_key, id DESC)
  WHERE surface = 'blueprint-operation';
