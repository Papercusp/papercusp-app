-- 337-operator-migrate-policy.sql — live-configurability-audit-2026-06-20 P-003.
--
-- operator_migrate_policy — the runtime-settable deploy-migration connection knobs backing
-- db:migrate-policy: `lockTimeoutMs` (the DDL lock_timeout the deploy migrator opens its client
-- with — default 15000, the exact value implicated in two multi-hour deploy outages) + an
-- optional `statementTimeoutMs`. Single-row-per-workspace JSONB, the operator-state idiom
-- (migration 020 / rate-limit-config 161). Empty/missing → code falls back to
-- MIGRATE_POLICY_DEFAULTS (lock_timeout 15000, no statement_timeout), and migrate.ts reads it
-- FAIL-SAFE (defaults on any read error — the table may not exist yet on a fresh DB / CLI path),
-- so an empty (or absent) table is safe.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_migrate_policy (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_migrate_policy TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_migrate_policy TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_migrate_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_migrate_policy_workspace_isolation ON harness_shared.operator_migrate_policy;
CREATE POLICY operator_migrate_policy_workspace_isolation ON harness_shared.operator_migrate_policy
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
