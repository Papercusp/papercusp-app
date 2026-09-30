-- 190-operator-account-pool.sql — cloud-deployment-layer-2026-06-06 Phase 7 (P-019).
--
-- operator_account_pool — the Queen's pool of N Claude accounts to draw from. Each
-- account is { id, credentialRef, label?, addedAt, boundTo[], rate } where `rate` is
-- the per-account rate-limit projection (pausedUntil / penaltyCount / window) the
-- Queen maintains from the rate governor's pause signals. Deploy-time selection
-- (P-020) binds the most-available account per Swarm; auto-scale-out (P-021) moves a
-- sustainedly-limited account's members onto a fresh one.
--
-- Single-row-per-workspace JSONB, the operator-state idiom (migration 020 / rate-limit
-- config 161). Default empty → code falls back to an empty pool (no accounts), so the
-- table being absent/empty is safe (deploys use the frame's env/default credential).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe. credentialRef is
-- a REFERENCE (token:/file: path), never a secret — so this table is plaintext JSONB
-- like its operator-state siblings (the actual credential files live on disk).

CREATE TABLE IF NOT EXISTS harness_shared.operator_account_pool (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_account_pool TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_account_pool TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_account_pool ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_account_pool_workspace_isolation ON harness_shared.operator_account_pool;
CREATE POLICY operator_account_pool_workspace_isolation ON harness_shared.operator_account_pool
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
