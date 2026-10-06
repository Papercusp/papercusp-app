-- P004/P005: one private generation capture joins one existing admission.
-- FORWARD-COMPAT: older rows/writers leave the new nullable column NULL. No
-- legacy binding is assigned a reservation, account or invoice by inference.
-- Reuses the append-only receipt rails; no financial DML grants are widened.
ALTER TABLE papercusp_auth.hosted_usage_receipts
  ADD COLUMN IF NOT EXISTS openrouter_budget_grant jsonb;

CREATE OR REPLACE FUNCTION papercusp_auth.hosted_openrouter_budget_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, papercusp_auth AS $body$
DECLARE
  admission papercusp_auth.hosted_budget_receipts%ROWTYPE;
  expected jsonb;
BEGIN
  IF NEW.openrouter_budget_grant IS NULL THEN RETURN NEW; END IF;
  IF NEW.openrouter_credential_ref IS NULL OR NEW.payer <> 'consumption'
      OR jsonb_typeof(NEW.openrouter_budget_grant) <> 'object' THEN
    RAISE EXCEPTION 'invalid OpenRouter budget grant' USING ERRCODE = '23514';
  END IF;
  -- Original admissions are append-only. This needs no budget/advisory write
  -- lock, and never joins by amount, rollup ID, key name or providerLimitRef.
  SELECT * INTO admission FROM papercusp_auth.hosted_budget_receipts
    WHERE control_workspace_id = NEW.control_workspace_id
      AND organization_id = NEW.organization_id
      AND customer_workspace_id = NEW.customer_workspace_id
      AND reservation_id = NEW.openrouter_budget_grant->>'reservationId' AND revision = 0;
  IF NOT FOUND OR admission.observed_at_ms > NEW.occurred_at_ms THEN
    RAISE EXCEPTION 'OpenRouter budget admission mismatch' USING ERRCODE = '23514';
  END IF;
  expected := jsonb_build_object('scope', jsonb_build_object('controlWorkspaceId', admission.control_workspace_id,
    'organizationId', admission.organization_id, 'customerWorkspaceId', admission.customer_workspace_id),
    'reservationId', admission.reservation_id, 'month', admission.month, 'budgetKey', admission.budget_key,
    'maximumCostMicros', admission.maximum_cost_micros, 'providerLimitRef', admission.provider_limit_ref,
    'policyId', admission.policy_id, 'policyRevision', admission.policy_revision, 'evidenceRef', admission.evidence_ref);
  IF NEW.openrouter_budget_grant IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'OpenRouter budget grant mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION papercusp_auth.hosted_openrouter_budget_binding_guard() OWNER TO hosted_owner;
DROP TRIGGER IF EXISTS hosted_openrouter_budget_binding_guard ON papercusp_auth.hosted_usage_receipts;
CREATE TRIGGER hosted_openrouter_budget_binding_guard BEFORE INSERT ON papercusp_auth.hosted_usage_receipts
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.hosted_openrouter_budget_binding_guard();
CREATE UNIQUE INDEX IF NOT EXISTS hosted_usage_openrouter_budget_binding_uidx
  ON papercusp_auth.hosted_usage_receipts
    (control_workspace_id, organization_id, (openrouter_budget_grant->>'reservationId'))
  WHERE openrouter_budget_grant IS NOT NULL;
COMMENT ON COLUMN papercusp_auth.hosted_usage_receipts.openrouter_budget_grant IS
  'Private immutable local admission join; excluded from public usage. Not provider account/invoice/finality, enforced maximum, cash or paid authority.';
