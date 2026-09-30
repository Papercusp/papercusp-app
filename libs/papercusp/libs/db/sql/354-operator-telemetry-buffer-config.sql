-- 354-operator-telemetry-buffer-config.sql — live-configurability-audit-2026-06-20 P-020.
--
-- operator_telemetry_buffer_config — one JSONB row per workspace backing telemetry:set_buffer.
-- payload = { maxPending?, debounceMs?, maxBatch? } — a PARTIAL override of the baked dispatch
-- telemetry-buffer defaults (projected-tool-deps.ts TELEMETRY_MAX_PENDING=5000 /
-- TELEMETRY_FLUSH_DEBOUNCE_MS=10 / TELEMETRY_MAX_BATCH=200), read into a D-010 SYNC cache and
-- merged per-field over the defaults at the deferred-telemetry enqueue/flush sites. Empty row (the
-- default) ⇒ baked defaults ⇒ byte-identical. Gated by papercusp-telemetry-buffer-config (kill-switch).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_telemetry_buffer_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_telemetry_buffer_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_telemetry_buffer_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_telemetry_buffer_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_telemetry_buffer_config_workspace_isolation ON harness_shared.operator_telemetry_buffer_config;
CREATE POLICY operator_telemetry_buffer_config_workspace_isolation ON harness_shared.operator_telemetry_buffer_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
