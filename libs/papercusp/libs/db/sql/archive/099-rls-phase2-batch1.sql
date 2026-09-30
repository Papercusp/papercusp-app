-- 097-rls-phase2-batch1.sql
-- P-062 / agent-tools-workspace-isolation Phase 2 (RLS rollout) — BATCH 1.
--
-- Enable RLS + the standard per-workspace policy on the workspace_id-bearing
-- harness_shared tables that harness_app does NOT access via withWorkspace (the
-- app handle) — so RLS is dormant-safe: harness_admin (operator) + harness_zero
-- (sync) BYPASS RLS (rolbypassrls=t), and harness_app never touches these tables,
-- so nothing changes today; it just enforces isolation once tools run as
-- harness_app (Phase 4). Matches the 23 existing <table>_workspace_isolation
-- policies. Run as postgres_app/superuser (owns many of these).
--
-- EXCLUDES the 9 app-touched tables (separate batch — need per-path verification;
-- e.g. operator_scans has a withWorkspace(DEFAULT_WORKSPACE_ID) update that RLS
-- would break for non-default-workspace scans).
DO $$
DECLARE
  t text;
  touched text[] := ARRAY[
    'autoloop_state','delegate_inbox','harness_escalations','harness_lanes',
    'harness_registry','harness_status','harness_tests','operator_scans',
    'operator_standing_candidates'
  ];
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace='harness_shared'::regnamespace AND c.relkind='r'
      AND NOT c.relrowsecurity
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped)
      AND c.relname <> ALL(touched)
  LOOP
    EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON harness_shared.%I', t||'_workspace_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t||'_workspace_isolation', t);
  END LOOP;
END $$;
