-- 101-rls-phase2-batch2b.sql
-- P-062 Phase 2 (RLS rollout) — BATCH 2b, the final 2 app-touched ws-scoped tables.
--   * operator_scans  — reads/INSERT are withWorkspace(realWorkspace)-scoped; its two
--     by-id finalize updates (completeOperatorScan/failOperatorScan) were moved to the
--     admin handle (getOrgPg, rolbypassrls) in apps/operator/lib/operator-scans.ts so a
--     non-default-workspace scan still finalizes under RLS. Now RLS-safe.
--   * harness_tests   — only app reader is agent-tools/plans/get.ts, which reads with
--     withWorkspace(DEFAULT_WORKSPACE_ID) + WHERE workspace_id=DEFAULT — self-consistent
--     under RLS (GUC=DEFAULT matches the policy), so RLS does not change its result.
-- Completes the Phase 2 RLS rollout: 112/112 ws-scoped harness_shared tables. Run as
-- postgres_app (owns the tables). harness_admin/harness_zero (rolbypassrls) unaffected.
DO $$
DECLARE t text;
  batch text[] := ARRAY['operator_scans','harness_tests'];
BEGIN
  FOREACH t IN ARRAY batch LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relnamespace='harness_shared'::regnamespace AND relname=t) THEN
      EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON harness_shared.%I', t||'_workspace_isolation', t);
      EXECUTE format('CREATE POLICY %I ON harness_shared.%I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', t||'_workspace_isolation', t);
    END IF;
  END LOOP;
END $$;
