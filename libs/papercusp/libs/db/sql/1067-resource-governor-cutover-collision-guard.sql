-- 1067-resource-governor-cutover-collision-guard.sql
--
-- resource-governor-admission-ledger-2026-09-01 P-004 / D-007.
--
-- Migration 1062's first-writer latch rejected EVERY subsequent legacy
-- work_items admission in a workspace. Staging and green-main operator hosts
-- intentionally overlap while sharing that workspace/database, so the first
-- staging ledger write made the still-supported main tool host fail every
-- testing:run admission with SQLSTATE 23514. That was availability loss, not a
-- duplicate-execution risk.
--
-- Both store generations already take the same sorted advisory identity and
-- coalesce locks. During the bounded overlap, an old writer may therefore keep
-- creating a legacy row when no ledger row conflicts. The trigger must reject
-- only the two shapes the old binary cannot resolve safely:
--   1. the same namespace/idempotency identity already exists in the ledger;
--   2. an active ledger receipt already owns the same coalesce key.
--
-- New-code writers remain ledger-only. The compatibility store finds and
-- settles old WI receipts, and a separate legacy-writers-retired watermark
-- gates terminal deletion after every independently deployed writer is current.

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
  'D-007 rolling-overlap guard: old binaries may write bounded legacy receipts while staging/main coexist, but an insert is rejected when the same ledger identity or an active ledger coalesce peer already exists. New-code writers remain ledger-only; a separate retired-writers watermark gates legacy deletion.';
