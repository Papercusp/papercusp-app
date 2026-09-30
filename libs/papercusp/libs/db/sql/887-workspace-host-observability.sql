-- 887-workspace-host-observability.sql — WI-40483 / P-023.
--
-- First durable state beneath the provider-neutral workspace-host workflow.
-- The workflow already defines stable operation, host, and logical-resource
-- identities; these tables persist those identities before dependent provider
-- work and expose a redacted, push-refreshed operator projection.
--
-- Additive, expand-only, idempotent, and safe while the previous release runs.

CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_connections (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invalid'
    CHECK (status IN ('connected', 'degraded', 'invalid')),
  status_detail TEXT,
  last_validated_at TIMESTAMPTZ,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scopes) = 'array'),
  regions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(regions) = 'array'),
  sizes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sizes) = 'array'),
  images JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(images) = 'array'),
  networks JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(networks) = 'array'),
  disk_price_per_gib_month NUMERIC(12, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_hosts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  target TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  region TEXT NOT NULL,
  size TEXT NOT NULL,
  image TEXT NOT NULL,
  disk_gib INTEGER NOT NULL CHECK (disk_gib > 0),
  network TEXT NOT NULL,
  estimated_monthly_usd NUMERIC(12, 4),
  desired_state TEXT NOT NULL
    CHECK (desired_state IN ('provisioning', 'running', 'stopped', 'degraded', 'repairing', 'destroying', 'absent')),
  observed_state TEXT NOT NULL
    CHECK (observed_state IN ('provisioning', 'running', 'stopped', 'degraded', 'repairing', 'destroying', 'absent')),
  observed_at TIMESTAMPTZ,
  endpoint TEXT,
  recoverability_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (recoverability_kind IN ('snapshot', 'backup', 'none')),
  recoverability_label TEXT NOT NULL DEFAULT 'No recovery point recorded',
  recoverability_updated_at TIMESTAMPTZ,
  health_status TEXT CHECK (health_status IS NULL OR health_status IN ('healthy', 'degraded', 'unreachable')),
  health_attested_at TIMESTAMPTZ,
  health_checks JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(health_checks) = 'array'),
  bootstrap_version TEXT,
  version_drift JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(version_drift) = 'array'),
  tunnel_status JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tunnel_status) = 'object'),
  cost_signals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cost_signals) = 'array'),
  quota_signals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quota_signals) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_hosts_connection_fk FOREIGN KEY (workspace_id, connection_id)
    REFERENCES harness_shared.workspace_host_connections (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_operations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('provision', 'start', 'stop', 'restart', 'snapshot', 'restore', 'upgrade', 'repair', 'destroy')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  request JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_host_operations_host_fk FOREIGN KEY (workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_resources (
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('planned', 'applying', 'reconciling', 'retry-wait', 'applied', 'unchanged', 'compensating', 'compensated', 'absent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_class TEXT CHECK (retry_class IS NULL OR retry_class IN ('transient', 'throttled', 'ambiguous', 'terminal')),
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  target TEXT,
  kind TEXT,
  provider_id TEXT,
  parent_provider_id TEXT,
  region TEXT,
  zone TEXT,
  provider_request_id TEXT,
  deletion_confirmation JSONB,
  error JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, host_id, logical_key),
  CONSTRAINT workspace_host_resources_host_fk FOREIGN KEY (workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_host_resources_operation_fk FOREIGN KEY (workspace_id, operation_id)
    REFERENCES harness_shared.workspace_host_operations (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  source TEXT NOT NULL DEFAULT 'controller',
  message TEXT NOT NULL,
  details JSONB,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_host_events_host_fk FOREIGN KEY (workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_host_events_operation_fk FOREIGN KEY (workspace_id, operation_id)
    REFERENCES harness_shared.workspace_host_operations (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_logs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  operation_id TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stream TEXT NOT NULL CHECK (stream IN ('cloud-init', 'systemd', 'controller')),
  unit TEXT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  metadata JSONB,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_host_logs_host_fk FOREIGN KEY (workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_host_logs_operation_fk FOREIGN KEY (workspace_id, operation_id)
    REFERENCES harness_shared.workspace_host_operations (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_hosts_workspace_updated_idx
  ON harness_shared.workspace_hosts (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS workspace_host_operations_host_updated_idx
  ON harness_shared.workspace_host_operations (workspace_id, host_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS workspace_host_resources_host_idx
  ON harness_shared.workspace_host_resources (workspace_id, host_id, logical_key);
CREATE INDEX IF NOT EXISTS workspace_host_events_operation_time_idx
  ON harness_shared.workspace_host_events (workspace_id, operation_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS workspace_host_logs_host_time_idx
  ON harness_shared.workspace_host_logs (workspace_id, host_id, observed_at DESC, id);

DO $workspace_host_security$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_host_connections', 'workspace_hosts', 'workspace_host_operations',
    'workspace_host_resources', 'workspace_host_events', 'workspace_host_logs'
  ] LOOP
    policy_name := table_name || '_workspace_isolation';
    EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'harness_shared' AND tablename = table_name AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON harness_shared.%I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
        policy_name, table_name
      );
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.%I TO harness_app', table_name);
    BEGIN
      EXECUTE format('GRANT SELECT ON harness_shared.%I TO harness_zero', table_name);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END
$workspace_host_security$;

-- Row triggers cover low-volume control state and durable progress events.
-- workspace_host_logs is deliberately excluded: cloud-init/systemd ingestion can
-- append many rows at once, and its store publishes one scoped invalidation after
-- a batch instead of producing one PG notification per line.
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.workspace_host_connections FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.workspace_hosts FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.workspace_host_operations FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.workspace_host_resources FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.workspace_host_events FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();

COMMENT ON TABLE harness_shared.workspace_host_operations IS
  'Stable workspace-host lifecycle operations. request/error JSON is redacted before insert by observability-store.ts.';
COMMENT ON TABLE harness_shared.workspace_host_resources IS
  'Per-logical-resource durable checkpoints and provider identities, recorded before dependent provider work.';
COMMENT ON TABLE harness_shared.workspace_host_events IS
  'User-visible operation timeline. details JSON is redacted before insert.';
COMMENT ON TABLE harness_shared.workspace_host_logs IS
  'Redacted cloud-init, systemd, and controller diagnostics. Explicit batch invalidation avoids a row-trigger notification storm.';
