-- 373-sync-trigger-coverage.sql
--
-- caching-layer-tag-eca-2026-06-22 P-005 (trigger-coverage audit + fix).
--
-- AUDIT (su-815e2, via the TABLE_TO_QUERY_NAMES bridge registry × pg_trigger): of the 48
-- synced/cache-backing tables that map to a useSyncQuery name, 34 LACKED the generic
-- harness_shared.emit_change_notify trigger — so a write to them never emitted a
-- `<schema>.<table>.changed` event, and their registered queries never got live invalidation
-- (a pre-existing sync-completeness gap, not introduced by the caching plan).
--
-- FIX: attach the generic trigger to the 28 LOW-CHURN content/config/state tables below, where
-- live invalidation is clearly correct and a per-row notify is cheap. The notify is deduped by the
-- sync bus, so this simply completes the registry's intent.
--
-- DELIBERATELY EXCLUDED — append-heavy ACTIVITY LOGS where a per-row notify would be chatty at
-- production scale (the performance-doc notify-storm anti-pattern); these need a coarser/debounced
-- invalidation, tracked as a follow, NOT a per-row trigger:
--   audit_log, agent_runs_consolidated, user_actions, harness_hook_logs, toast_log,
--   feature_audit_consolidated.
--
-- Idempotent (CREATE OR REPLACE TRIGGER; safe to re-run / re-deploy).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'harness_archives', 'harness_brainstorm', 'harness_checkpoints', 'harness_chunk_plans',
    'harness_decisions', 'harness_escalations', 'harness_feature_debug_notes', 'harness_feature_notes',
    'harness_lanes', 'harness_pending_issues', 'harness_project_files', 'harness_proposals_shared',
    'harness_screenshots', 'harness_skills', 'harness_smoke_test', 'harness_snapshots_consolidated',
    'harness_status', 'harness_tests', 'harness_text_artifacts', 'hive_members', 'hive_settings',
    'operator_budget', 'pending_reviews', 'plan_revisions', 'plan_runs', 'plugin_configs',
    'plugin_enables', 'project_spec_revisions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Only attach where the table actually exists in this DB (defensive; the registry is the
    -- source list but a fresh/partial DB may not have every satellite table yet).
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER emit_change_notify_trg '
        || 'AFTER INSERT OR UPDATE OR DELETE ON harness_shared.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
        t
      );
    END IF;
  END LOOP;
END $$;
