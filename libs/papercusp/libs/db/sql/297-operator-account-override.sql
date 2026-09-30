-- 297-operator-account-override.sql — accounts-pool-tab-2026-06-15 P-004 (D-015).
--
-- operator_account_override — the owner's session-now steer over WHICH pool accounts
-- the fleet may spawn/deploy on: { forcedAccounts[], excludeAccounts[] }. forced is an
-- allow-list (use ONLY these); exclude skips some (e.g. a flaky/rate-limited account).
-- Both empty ⇒ no restriction (today's behaviour) — applied as a fail-soft precedence
-- layer BEFORE the headroom/drain selectors (account-pool-store.ts).
--
-- WORKSPACE-LEVEL, not per-hive: the original P-004 design keyed it to the home hive's
-- hive_settings, which broke when no home hive was configured ("no_home_harness") and
-- split the write key from the read key. This is its own single-row-per-workspace JSONB
-- table — the operator-state idiom (migration 020 / account pool 190 / rate config 161) —
-- so it works with zero hives and write/read always agree. It lives apart from
-- operator_account_pool (190) so the owner's intent is never clobbered by the pool's
-- high-churn rate-projection writes.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe. Holds only account
-- ids (references), never a secret — plaintext JSONB like its operator-state siblings.

CREATE TABLE IF NOT EXISTS harness_shared.operator_account_override (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_account_override TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_account_override TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_account_override ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_account_override_workspace_isolation ON harness_shared.operator_account_override;
CREATE POLICY operator_account_override_workspace_isolation ON harness_shared.operator_account_override
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
