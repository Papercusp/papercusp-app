-- P-005: extend hosted budget commitments with durable prepaid partitions.
-- Reuses money-journal/payment-receipt authority; this table never creates cash.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_prepaid_allocations (
  control_workspace_id text NOT NULL,
  stripe_account_id text NOT NULL CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  allocation_id text NOT NULL,
  payment_transaction_id text NOT NULL,
  organization_id text NOT NULL,
  -- Always bind the directory, including an organization-unassigned grant.
  -- FK enforcement needs no directory SELECT grant for the service writer.
  binding_customer_workspace_id text NOT NULL,
  customer_workspace_id text,
  budget_key text NOT NULL,
  micros numeric NOT NULL CHECK (micros >= 0 AND micros <= 9007199254740991 AND scale(micros) <= 324),
  allocation_hash text NOT NULL CHECK (allocation_hash ~ '^[a-f0-9]{64}$'),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  evidence_ref text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stripe_account_id, allocation_id),
  FOREIGN KEY (control_workspace_id, organization_id, binding_customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  CHECK (control_workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND organization_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND payment_transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND budget_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);
COMMENT ON TABLE papercusp_auth.hosted_prepaid_allocations IS
  'Immutable exact partitions of authenticated prepaid payments; all account allocations lock together with reservation authority. No balance, receipt, expiry, reallocation or permission to dispatch.';
CREATE INDEX IF NOT EXISTS hosted_prepaid_allocations_payment_idx
  ON papercusp_auth.hosted_prepaid_allocations (stripe_account_id, payment_transaction_id);
ALTER TABLE papercusp_auth.hosted_prepaid_allocations OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_prepaid_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_prepaid_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.hosted_prepaid_allocations FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT ON papercusp_auth.hosted_prepaid_allocations TO hosted_service;
DROP POLICY IF EXISTS hosted_prepaid_allocations_service ON papercusp_auth.hosted_prepaid_allocations;
CREATE POLICY hosted_prepaid_allocations_service ON papercusp_auth.hosted_prepaid_allocations
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION papercusp_auth.hosted_prepaid_allocations_guard()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'hosted prepaid allocations are append-only' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-prepaid', NEW.stripe_account_id)::text, 0));
  IF EXISTS (SELECT 1 FROM papercusp_auth.hosted_prepaid_allocations
      WHERE stripe_account_id = NEW.stripe_account_id AND control_workspace_id <> NEW.control_workspace_id) THEN
    RAISE EXCEPTION 'prepaid pool control mismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM papercusp_auth.hosted_prepaid_allocations
      WHERE stripe_account_id = NEW.stripe_account_id AND payment_transaction_id = NEW.payment_transaction_id
        AND organization_id <> NEW.organization_id) THEN
    RAISE EXCEPTION 'prepaid payment organization mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION papercusp_auth.hosted_prepaid_allocations_guard() OWNER TO hosted_owner;
DROP TRIGGER IF EXISTS hosted_prepaid_allocations_guard ON papercusp_auth.hosted_prepaid_allocations;
CREATE TRIGGER hosted_prepaid_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON papercusp_auth.hosted_prepaid_allocations
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.hosted_prepaid_allocations_guard();
