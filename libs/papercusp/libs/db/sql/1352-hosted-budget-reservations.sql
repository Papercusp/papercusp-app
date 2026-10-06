-- Monetization P-005: durable commitments on the existing hosted billing seam.
-- Funding, cash movements and entitlement policies keep their existing authority.
-- New append-only table; no existing data/roles are widened or rewritten.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_budget_receipts (
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  customer_workspace_id text NOT NULL,
  reservation_id text NOT NULL,
  event_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  budget_key text NOT NULL,
  maximum_cost_micros bigint NOT NULL CHECK (maximum_cost_micros BETWEEN 0 AND 9007199254740991),
  provider_limit_ref text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  policy_id text NOT NULL,
  policy_revision bigint NOT NULL CHECK (policy_revision BETWEEN 1 AND 9007199254740991),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  cost_source text NOT NULL CHECK (cost_source IN ('unpriced', 'estimate', 'provider-reported', 'provider-billed')),
  cost_micros bigint CHECK (cost_micros BETWEEN 0 AND 9007199254740991),
  provider_final boolean NOT NULL,
  evidence_ref text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, reservation_id, revision),
  UNIQUE (control_workspace_id, organization_id, event_id),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  CHECK ((cost_source = 'unpriced') = (cost_micros IS NULL)),
  CHECK (revision <> 0 OR (cost_source = 'unpriced' AND NOT provider_final)),
  CHECK (reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND budget_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND provider_limit_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND policy_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);
COMMENT ON TABLE papercusp_auth.hosted_budget_receipts IS
  'Immutable admitted-exposure and provider-observation receipts. No credits, payments, content or credentials; open/crashed/unbilled holds never expire financially.';
CREATE INDEX IF NOT EXISTS hosted_budget_receipts_latest_idx
  ON papercusp_auth.hosted_budget_receipts (control_workspace_id, organization_id, reservation_id, revision DESC);
ALTER TABLE papercusp_auth.hosted_budget_receipts OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_budget_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_budget_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.hosted_budget_receipts FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT ON papercusp_auth.hosted_budget_receipts TO hosted_service;
DROP POLICY IF EXISTS hosted_budget_receipts_service ON papercusp_auth.hosted_budget_receipts;
CREATE POLICY hosted_budget_receipts_service ON papercusp_auth.hosted_budget_receipts
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION papercusp_auth.hosted_budget_receipts_guard()
RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE
  prior papercusp_auth.hosted_budget_receipts%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'hosted budget receipts are append-only' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-budget', NEW.control_workspace_id, NEW.organization_id)::text, 0));
  SELECT * INTO prior FROM papercusp_auth.hosted_budget_receipts
    WHERE control_workspace_id = NEW.control_workspace_id AND organization_id = NEW.organization_id
      AND reservation_id = NEW.reservation_id ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 0 THEN
      RAISE EXCEPTION 'budget observation needs an admission' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <= prior.revision OR NEW.observed_at_ms < prior.observed_at_ms
    OR ROW(NEW.customer_workspace_id, NEW.month, NEW.budget_key, NEW.maximum_cost_micros,
           NEW.provider_limit_ref, NEW.request_hash, NEW.policy_id, NEW.policy_revision)
      IS DISTINCT FROM ROW(prior.customer_workspace_id, prior.month, prior.budget_key, prior.maximum_cost_micros,
           prior.provider_limit_ref, prior.request_hash, prior.policy_id, prior.policy_revision)
    OR array_position(ARRAY['unpriced', 'estimate', 'provider-reported', 'provider-billed'], NEW.cost_source)
       < array_position(ARRAY['unpriced', 'estimate', 'provider-reported', 'provider-billed'], prior.cost_source)
    OR (prior.provider_final AND prior.cost_source = 'provider-billed'
        AND (NOT NEW.provider_final OR NEW.cost_source <> 'provider-billed')) THEN
    RAISE EXCEPTION 'budget receipt history conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION papercusp_auth.hosted_budget_receipts_guard() OWNER TO hosted_owner;
DROP TRIGGER IF EXISTS hosted_budget_receipts_guard ON papercusp_auth.hosted_budget_receipts;
CREATE TRIGGER hosted_budget_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON papercusp_auth.hosted_budget_receipts
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.hosted_budget_receipts_guard();
