-- 356-operator-txn-timeouts-config.sql — live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
--
-- operator_txn_timeouts_config — one JSONB row per workspace backing db:txn-timeouts.
-- payload = { lockTimeoutMs?, statementTimeoutMs? } — a PARTIAL override of the baked per-workspace
-- transaction timeouts applied in @papercusp/locks' inWorkspaceTxn (in-workspace-txn.ts: lock_timeout +
-- statement_timeout, baked 5s/5s). Read into a D-010 SYNC cache and injected into the locks LocksHost
-- seam (getTxnTimeouts), merged per-field over the defaults at the per-txn SET. Empty row (the default)
-- ⇒ baked 5s/5s ⇒ byte-identical. Gated by papercusp-txn-timeouts-config (default-ON kill-switch).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_txn_timeouts_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_txn_timeouts_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_txn_timeouts_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_txn_timeouts_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_txn_timeouts_config_workspace_isolation ON harness_shared.operator_txn_timeouts_config;
CREATE POLICY operator_txn_timeouts_config_workspace_isolation ON harness_shared.operator_txn_timeouts_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
