-- 351-operator-release-checkpoint-config.sql — live-configurability-audit-2026-06-20 P-016.
--
-- operator_release_checkpoint_config — one JSONB row per workspace backing release:checkpoint-config:
-- the green-checkpoint / release thresholds (stallReds, stallAgeMs, chronicFlakeCount,
-- flakeNotifyCooldownMs, deployBackoffMs). Each field is an OVERRIDE over the release-actions.ts const
-- default — absent ⇒ the const ⇒ byte-identical. releaseCheckpointConfig() overlays a sync-cached read
-- of this row over the const defaults (the consumers are periodic release routines, but read sync).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_release_checkpoint_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_release_checkpoint_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_release_checkpoint_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_release_checkpoint_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_release_checkpoint_config_workspace_isolation ON harness_shared.operator_release_checkpoint_config;
CREATE POLICY operator_release_checkpoint_config_workspace_isolation ON harness_shared.operator_release_checkpoint_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
