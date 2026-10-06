-- 1279 — require the canonical plan acceptance gate before a shipped status
-- transition can commit. The TypeScript gate remains authoritative; this
-- deferred constraint verifies its transaction-local, plan-specific receipt.

CREATE OR REPLACE FUNCTION harness_shared.require_plan_shipment_acceptance_gate_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  receipt jsonb;
BEGIN
  -- Replays on an already-shipped row do not cross the lifecycle boundary.
  IF NEW.status IS DISTINCT FROM 'shipped'
     OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  BEGIN
    receipt := NULLIF(
      current_setting('papercusp.plan_shipment_acceptance_gate_receipt', true),
      ''
    )::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    receipt := NULL;
  END;

  IF receipt IS NULL
     OR receipt->>'schemaVersion' IS DISTINCT FROM '1'
     OR receipt->>'transactionId' IS DISTINCT FROM txid_current()::text
     OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
     OR receipt->>'harnessSlug' IS DISTINCT FROM NEW.harness_slug
     OR receipt->>'planSlug' IS DISTINCT FROM NEW.plan_slug THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'harness_plans_shipped_acceptance_gate_receipt',
      MESSAGE = 'harness_plans shipped transition requires a matching acceptance gate receipt from plans:set-plan-status';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS harness_plans_require_shipment_acceptance_gate_receipt
  ON harness_shared.harness_plans;
CREATE CONSTRAINT TRIGGER harness_plans_require_shipment_acceptance_gate_receipt
  AFTER UPDATE OF status ON harness_shared.harness_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.require_plan_shipment_acceptance_gate_receipt();

COMMENT ON FUNCTION harness_shared.require_plan_shipment_acceptance_gate_receipt() IS
  'WI-10003602: reject shipped status transitions that lack the matching transaction-local receipt written only after plans:set-plan-status accepts the plan-acceptance gate.';
