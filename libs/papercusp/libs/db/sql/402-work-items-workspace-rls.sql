-- 402-work-items-workspace-rls.sql
-- Restore workspace RLS on the work_items BASE table (work-items-unify / mig-374 follow-up).
--
-- THE GAP
-- Pre-374, harness_features_consolidated was a TABLE that carried workspace RLS
-- (ENABLE ROW LEVEL SECURITY + a workspace-isolation policy) — the tenancy backstop for the
-- federated feature/issue families. mig-374 inverted the schema: work_items became the base
-- table and harness_features_consolidated / engineer_issues became VIEWS over it. The RLS
-- that protected the old table was dropped with it and never re-attached to the new base, so
-- a harness_app read of work_items WITHOUT app.workspace_id set could see EVERY workspace's
-- rows — a silent cross-tenant leak. The rls-coverage guard
-- (packages/operator-core/lib/sync/hyperbee/__tests__/rls-coverage.integration.test.ts)
-- catches exactly this. Restore it on the new base table, mirroring mig-186 (hive_settings).
--
-- SAFE FOR THE RUNNING FLEET
-- The operator connects as harness_admin (BYPASSRLS) via getOrgPg(), so its reads are
-- unaffected. RLS constrains only the harness_app role, which the app reaches through
-- withWorkspace() (route-workspace.ts) — and that path SETS app.workspace_id, so the policy
-- admits its own workspace's rows. The post-374 views (engineer_issues,
-- harness_features_consolidated) are admin-owned (no security_invoker), so they keep working;
-- federated replay (the drain) also runs on the admin conn. Idempotent: ENABLE is a no-op if
-- already on, and the policy is DROP-then-CREATE.

ALTER TABLE harness_shared.work_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_items_workspace_isolation ON harness_shared.work_items;
CREATE POLICY work_items_workspace_isolation ON harness_shared.work_items
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
