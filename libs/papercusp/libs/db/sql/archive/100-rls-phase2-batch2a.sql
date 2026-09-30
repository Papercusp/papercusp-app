-- 100-rls-phase2-batch2a.sql
-- P-062 Phase 2 (RLS rollout) — BATCH 2a. The 7 app-touched ws-scoped tables whose
-- withWorkspace reads/writes are correctly workspace-scoped (verified): they read
-- per the request/device workspace + delegate_inbox's writes set workspace_id.
-- EXCLUDES harness_tests + operator_scans (Batch 2b) — those use
-- withWorkspace(DEFAULT_WORKSPACE_ID) and need a code fix (use the real workspace)
-- before RLS, else their non-default-workspace access breaks. Run as postgres_app.
DO $$
DECLARE t text;
  batch text[] := ARRAY['autoloop_state','delegate_inbox','harness_escalations','harness_lanes','harness_registry','harness_status','operator_standing_candidates'];
BEGIN
  FOREACH t IN ARRAY batch LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relnamespace='harness_shared'::regnamespace AND relname=t) THEN
      EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON harness_shared.%I', t||'_workspace_isolation', t);
      EXECUTE format('CREATE POLICY %I ON harness_shared.%I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', t||'_workspace_isolation', t);
    END IF;
  END LOOP;
END $$;
