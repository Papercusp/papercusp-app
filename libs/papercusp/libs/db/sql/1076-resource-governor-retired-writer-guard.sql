-- 1076-resource-governor-retired-writer-guard.sql
--
-- resource-governor-admission-ledger-2026-09-01 P-005 / D-007.
--
-- Migration 1067 permits unrelated legacy admissions while independently
-- deployed writer generations overlap. P-005 needs a distinct, explicit edge
-- after every writer plane is current: once
-- resource_governor_admission_legacy_writers_retired:<workspace> is set to 1,
-- no legacy work_items admission may start. The marker writer takes a table lock
-- before setting it, so the trigger turns the marker into a stable cutover
-- boundary rather than a racy observation.
--
-- This migration is additive and dormant until that explicit marker exists.

CREATE OR REPLACE FUNCTION harness_shared.reject_post_cutover_governor_work_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, harness_shared
AS $function$
DECLARE
  governor_record jsonb;
BEGIN
  IF NOT jsonb_exists(COALESCE(NEW.payload, '{}'::jsonb), 'resource_governor') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM harness_shared.operator_settings AS setting
     WHERE setting.key = 'resource_governor_admission_legacy_writers_retired:' || NEW.workspace_id
       AND setting.workspace_id = NEW.workspace_id
       AND setting.value = '1'
  ) THEN
    RAISE EXCEPTION
      'resource-governor legacy writers are retired for workspace %; work_items admission insertion is disabled',
      NEW.workspace_id
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'work_items_resource_governor_retired_writer_guard';
  END IF;

  governor_record := NEW.payload->'resource_governor';
  IF jsonb_typeof(governor_record) <> 'object' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM harness_shared.resource_governor_admissions AS admission
     WHERE admission.workspace_id = NEW.workspace_id
       AND admission.namespace = governor_record->>'namespace'
       AND admission.idempotency_key = governor_record->>'idempotencyKey'
  ) THEN
    RAISE EXCEPTION
      'resource-governor admission identity already exists in the ledger for workspace %, namespace %, idempotency key %',
      NEW.workspace_id,
      governor_record->>'namespace',
      governor_record->>'idempotencyKey'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'work_items_resource_governor_cross_store_identity_guard';
  END IF;

  IF NULLIF(governor_record->>'coalesceKey', '') IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM harness_shared.resource_governor_admissions AS admission
        WHERE admission.workspace_id = NEW.workspace_id
          AND admission.namespace = governor_record->>'namespace'
          AND admission.coalesce_key = governor_record->>'coalesceKey'
          AND admission.state IN ('queued', 'eligible', 'leased', 'running')
     )
  THEN
    RAISE EXCEPTION
      'resource-governor active coalesce peer already exists in the ledger for workspace %, namespace %, coalesce key %',
      NEW.workspace_id,
      governor_record->>'namespace',
      governor_record->>'coalesceKey'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'work_items_resource_governor_cross_store_coalesce_guard';
  END IF;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION harness_shared.reject_post_cutover_governor_work_item() IS
  'D-007/P-005 rolling guard: unrelated old writers may overlap until the explicit legacy-writers-retired marker is set. After that marker, all legacy inserts reject; before it, ledger identity and active coalesce collisions still reject.';
