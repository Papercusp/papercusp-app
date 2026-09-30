-- 215-engineer-issues-reactivity.sql
--
-- Attach harness_shared.emit_change_notify() (the SSE `sync_invalidate` producer,
-- see 107-dogfood-reactivity-triggers.sql) to harness_shared.engineer_issues.
--
-- Why: the unified work-items read (`workItems.byHarness` sync query —
-- blueprint-aware-harness-ui-2026-06-09 P-010 live-updates polish) merges the
-- feature family (harness_features_consolidated — already triggered, 107) with
-- the issue family (engineer_issues — until now NOT triggered). Without this
-- trigger an issue-family write (issues:create/claim/close, work_items:set_state
-- on a bug/change/task) never pushes an invalidation, so the WorkItemsPanel
-- only refreshes manually for half its rows.
--
-- Trigger-name convention + idempotence (CREATE OR REPLACE TRIGGER, PG 14+)
-- match 107/213. The sync-sse dedupe window (90s per identical name+args)
-- keeps heavy write bursts cheap.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.engineer_issues
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
