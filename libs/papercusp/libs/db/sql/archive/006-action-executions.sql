-- Action execution audit log (spec §14.7 P4.5).
--
-- Every server-runtime action invocation writes one row at start (status='running')
-- and updates it on completion. Idempotency_key is unique so a re-trigger of the
-- same source returns the prior result without re-running the handler.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.action_executions (
  id                  BIGSERIAL PRIMARY KEY,
  harness_slug        TEXT NOT NULL,
  plugin_name         TEXT NOT NULL,
  action_name         TEXT NOT NULL,
  trigger_source      TEXT NOT NULL,                              -- 'ui' | 'routine' | 'webhook' | 'api' | 'cli'
  idempotency_key     TEXT NOT NULL UNIQUE,
  params_json         JSONB,
  status              TEXT NOT NULL DEFAULT 'running',            -- 'running' | 'ok' | 'error' | 'timeout'
  error_msg           TEXT,
  result_json         JSONB,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  webhook_emitted_at  TIMESTAMPTZ,                                -- set by marketplace-api action-event scanner; NULL ⇒ pending
  CHECK (status IN ('running', 'ok', 'error', 'timeout'))
);
-- Allow re-applying the migration on existing tables that pre-date
-- webhook_emitted_at — IF NOT EXISTS keeps the second-run clean.
ALTER TABLE audit.action_executions ADD COLUMN IF NOT EXISTS webhook_emitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS action_executions_harness_idx        ON audit.action_executions(harness_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS action_executions_plugin_action_idx  ON audit.action_executions(plugin_name, action_name, started_at DESC);
CREATE INDEX IF NOT EXISTS action_executions_status_idx         ON audit.action_executions(status) WHERE status <> 'ok';
-- Action-event scanner index: cheap lookup of un-emitted failures.
CREATE INDEX IF NOT EXISTS action_executions_pending_webhook_idx
  ON audit.action_executions(id)
  WHERE status IN ('error', 'timeout') AND webhook_emitted_at IS NULL;

GRANT USAGE ON SCHEMA audit TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE ON audit.action_executions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE audit.action_executions_id_seq TO harness_app, harness_admin;
