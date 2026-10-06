-- Monetization P-004: metadata-only, append-only provider usage/cost receipts.
-- Cash journals and identity markup meters retain their existing contracts.
-- New table; no existing data is rewritten or existing uniqueness narrowed.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_usage_receipts (
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  customer_workspace_id text NOT NULL,
  provider text NOT NULL,
  record_id text NOT NULL,
  usage_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  category text NOT NULL CHECK (category IN ('compute', 'persistent-storage', 'external-ip', 'egress', 'inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees', 'support', 'platform-overhead')),
  payer text NOT NULL CHECK (payer IN ('platform', 'consumption', 'customer-direct')),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN occurred_at_ms AND 9007199254740991),
  quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
  unit text NOT NULL,
  cost_source text NOT NULL CHECK (cost_source IN ('unpriced', 'estimate', 'provider-reported', 'provider-billed')),
  cost_micros bigint CHECK (cost_micros BETWEEN 0 AND 9007199254740991),
  source_ref text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, customer_workspace_id, provider, record_id),
  UNIQUE (control_workspace_id, organization_id, customer_workspace_id, provider, usage_id, revision),
  FOREIGN KEY (control_workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  CHECK ((cost_source = 'unpriced') = (cost_micros IS NULL)),
  CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     AND record_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     AND usage_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     AND unit ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     AND source_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);
CREATE INDEX IF NOT EXISTS hosted_usage_receipts_month_idx
  ON papercusp_auth.hosted_usage_receipts (control_workspace_id, organization_id, occurred_at_ms);
COMMENT ON TABLE papercusp_auth.hosted_usage_receipts IS
  'Versioned provider usage/cost observations; no customer content or credentials. Row presence does not establish collector completeness.';
ALTER TABLE papercusp_auth.hosted_usage_receipts OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_usage_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_usage_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.hosted_usage_receipts FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT ON papercusp_auth.hosted_usage_receipts TO hosted_service;
DROP POLICY IF EXISTS hosted_usage_receipts_service ON papercusp_auth.hosted_usage_receipts;
CREATE POLICY hosted_usage_receipts_service ON papercusp_auth.hosted_usage_receipts
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION papercusp_auth.hosted_usage_receipts_append_only()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'hosted usage receipts are append-only' USING ERRCODE = '23514';
END;
$body$;
ALTER FUNCTION papercusp_auth.hosted_usage_receipts_append_only() OWNER TO hosted_owner;
DROP TRIGGER IF EXISTS hosted_usage_receipts_append_only ON papercusp_auth.hosted_usage_receipts;
CREATE TRIGGER hosted_usage_receipts_append_only BEFORE UPDATE OR DELETE ON papercusp_auth.hosted_usage_receipts
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.hosted_usage_receipts_append_only();
