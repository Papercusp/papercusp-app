-- 611-session-ports.sql — durable cross-backend PSU session-port lifecycle.
--
-- A port creates a FRESH target identity. This table records the copy lineage
-- and delivery state; operational authority (coord owner, claims, locks,
-- fleet/loop/mode state) never crosses the boundary. `adv_sessions` carries a
-- small target-side projection so session history can explain where a fresh
-- session came from without treating the source as its identity.

CREATE TABLE IF NOT EXISTS harness_shared.session_ports (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          TEXT        NOT NULL,
  idempotency_key       TEXT        NOT NULL,
  protocol_version      INTEGER     NOT NULL,
  source_adv_session_id BIGINT      NOT NULL,
  target_adv_session_id BIGINT,
  source_backend        TEXT        NOT NULL,
  target_backend        TEXT        NOT NULL,
  target_model          TEXT,
  status                TEXT        NOT NULL DEFAULT 'prepared',
  source_hash           TEXT        NOT NULL,
  normalized_hash       TEXT        NOT NULL,
  rendered_hash         TEXT        NOT NULL,
  token_hash            TEXT        NOT NULL,
  artifact_path         TEXT        NOT NULL,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error                 TEXT,
  prepared_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_at            TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT session_ports_status_check CHECK
    (status IN ('prepared', 'pending', 'delivered', 'failed', 'expired')),
  CONSTRAINT session_ports_backend_check CHECK
    (source_backend IN ('claude', 'codex', 'omp') AND target_backend IN ('claude', 'codex', 'omp'))
);

CREATE INDEX IF NOT EXISTS session_ports_source_idx
  ON harness_shared.session_ports (workspace_id, source_adv_session_id, prepared_at DESC);
CREATE INDEX IF NOT EXISTS session_ports_target_idx
  ON harness_shared.session_ports (target_adv_session_id)
  WHERE target_adv_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_ports_pending_idx
  ON harness_shared.session_ports (expires_at)
  WHERE status IN ('prepared', 'pending');

ALTER TABLE harness_shared.session_ports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_ports_workspace_isolation ON harness_shared.session_ports;
CREATE POLICY session_ports_workspace_isolation ON harness_shared.session_ports
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS port_id UUID,
  ADD COLUMN IF NOT EXISTS port_source_adv_session_id BIGINT,
  ADD COLUMN IF NOT EXISTS port_status TEXT,
  ADD COLUMN IF NOT EXISTS port_metadata JSONB;

CREATE INDEX IF NOT EXISTS adv_sessions_port_source_idx
  ON harness_shared.adv_sessions (port_source_adv_session_id)
  WHERE port_source_adv_session_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.session_ports TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.session_ports TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END
$grant$;
