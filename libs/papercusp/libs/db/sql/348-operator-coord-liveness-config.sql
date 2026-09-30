-- 348-operator-coord-liveness-config.sql — live-configurability-audit-2026-06-20 P-014 (expose).
--
-- operator_coord_liveness_config — one JSONB row per workspace backing the P-014 coordination
-- liveness/reclaim config tools: work_items:reclaim_config (reclaimGraceMs, reclaimRequeueCap),
-- coord:handoff_config (handoffTtlMs), coord:session_reaper_config (sessionReaperGraceMs). Each field
-- is an OVERRIDE over the consumer's existing default (STALE_MS / staleReclaimRequeueCap() /
-- STALE_HANDOFF_TTL_MS / IDLE_SESSION_GRACE_MS) — absent ⇒ the consumer's default ⇒ byte-identical.
-- JSONB so the three concerns share one row + one migration (added incrementally, no further DDL).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_coord_liveness_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_coord_liveness_config TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_coord_liveness_config TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_coord_liveness_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_coord_liveness_config_workspace_isolation ON harness_shared.operator_coord_liveness_config;
CREATE POLICY operator_coord_liveness_config_workspace_isolation ON harness_shared.operator_coord_liveness_config
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
