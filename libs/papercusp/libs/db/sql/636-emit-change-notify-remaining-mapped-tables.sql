-- 636-emit-change-notify-remaining-mapped-tables.sql
--
-- WI-5374 — close the remaining sync-invalidation trigger-coverage gap
-- (caching-layer-tag-eca-2026-06-22 P-005, follow-up to mig-373/376).
--
-- FOUND (cache-tag-trigger-coverage.integration.test.ts, 2026-07-18): 21 tables
-- mapped in TABLE_TO_QUERY_NAMES lacked the generic harness_shared.emit_change_notify
-- trigger and were neither covered by an earlier attach migration nor documented in
-- the test's COVERAGE_EXEMPT allow-list — undocumented drift (new query names got
-- mapped onto these tables after mig-373's audit without wiring the trigger).
--
-- CONSEQUENCE: a raw-SQL or FEDERATED write to any of them silently left
-- caches/sync stale on every node (D-005) — app-code writes via
-- notifySyncInvalidate still worked, so this was a latent gap, not a proven live
-- incident.
--
-- PER-TABLE JUDGMENT (mirrors mig-373's split):
--
--   (1) ATTACH the generic trigger to the 20 tables below — all are low-to-moderate
--       churn, UI-facing state/content tables backing a real sync query a user
--       actively views (operator chat turns/conversations, coordination threads/
--       conversations/subscriptions, bench-run live monitors, dock layouts, plan
--       assertions, preferences, projects/KPIs, …). Verified against live row
--       counts (dev:pg_query, 2026-07-19): all bounded in the thousands total /
--       tens-to-hundreds per day — nothing like an audit-log firehose.
--
--   (2) EXEMPT `agent_usage_samples` (added to COVERAGE_EXEMPT in the test file,
--       NOT here) — one row per governed agent LLM call, fleet-wide. Live row
--       counts confirm audit-log-scale volume (810 rows/24h, ~26k accumulated —
--       matching audit_log's 2156/24h, ~25.6k accumulated). A per-row notify here
--       is the performance-doc notify-storm anti-pattern that mig-373/376 already
--       carved out for audit_log/user_actions/etc; its `evals.benchRunLive` need
--       wants a debounced follow-up, not a per-row trigger (same TODO as the other
--       exempt logs).
--
-- Idempotent (CREATE OR REPLACE TRIGGER; safe to re-run / re-deploy).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'adaptive_telemetry', 'autoloop_state', 'bench_run_tasks', 'bench_runs',
    'coord_conversations', 'coord_entity_subscriptions', 'coord_thread_posts',
    'coord_threads', 'harness_dock_layouts', 'harness_plan_assertions',
    'messages_consolidated', 'operator_account_override', 'operator_conversations',
    'operator_preferences', 'operator_prompt_user', 'operator_standing_candidates',
    'operator_turns', 'operator_voice_prefs', 'projects', 'user_preferences'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Only attach where the table actually exists in this DB (defensive; a
    -- fresh/partial DB may not have every satellite table yet).
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
