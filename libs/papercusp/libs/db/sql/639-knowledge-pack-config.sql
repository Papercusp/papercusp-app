-- 639-knowledge-pack-config.sql — knowledge-pack-settings-2026-07-19 P-001.
--
-- Single-row-per-workspace JSONB config for the knowledge-pack loop's
-- runtime-tunable settings (cadence presets, adoption policy, hygiene/delivery
-- knobs), surfaced on the memory settings page. The operator-state idiom
-- (migration 020; exact sibling of operator_rate_limit_config, migration 161).
-- Default empty → code falls back to env vars → baked defaults, so the table
-- being empty (or the migration not yet applied) is safe.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.knowledge_pack_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.knowledge_pack_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.knowledge_pack_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.knowledge_pack_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_pack_config_workspace_isolation ON harness_shared.knowledge_pack_config;
CREATE POLICY knowledge_pack_config_workspace_isolation ON harness_shared.knowledge_pack_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
