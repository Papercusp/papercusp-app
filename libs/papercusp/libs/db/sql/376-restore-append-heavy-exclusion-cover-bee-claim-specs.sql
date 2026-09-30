-- 376-restore-append-heavy-exclusion-cover-bee-claim-specs.sql
--
-- caching-layer-tag-eca-2026-06-22 P-005 — cleanup follow-up to the trigger-coverage audit.
--
-- BACKGROUND. P-005 was double-placed: two migrations numbered 373 landed for the same
-- task — su-815e2's `373-sync-trigger-coverage.sql` (canonical) AND
-- `373-cache-backing-tables-change-notify-coverage.sql` (a continuation session). The
-- second is a strict SUPERSET that ALSO attached emit_change_notify to six append-heavy
-- ACTIVITY-LOG tables that 373-sync-trigger-coverage DELIBERATELY excluded — a per-row
-- pg_notify on a high-write log is the performance-doc notify-storm anti-pattern
-- (/internal/docs/performance). The duplicate file is removed (it tripped lint:migrations'
-- dup-NNN check); this migration converges every DB that already applied it back to
-- su-815e2's documented intent, and also closes one genuine gap the audit predated.
--
-- (1) RESTORE THE APPEND-HEAVY EXCLUSION — drop emit_change_notify from the six logs.
--     These six are MAPPED in TABLE_TO_QUERY_NAMES but intentionally have NO per-row
--     change-notify producer; their live invalidation is a coarse/debounced follow-up,
--     not a per-row trigger (documented as COVERAGE_EXEMPT in
--     cache-tag-trigger-coverage.integration.test.ts). Idempotent (DROP IF EXISTS).
--
-- (2) COVER bee_claim_specs — a real table (relkind 'r') added by mig-372 AFTER the
--     audit, mapped to scheduler.running. It legitimately needs the generic trigger so
--     a raw-SQL / FEDERATED claim-spec write live-invalidates the running-bee list.
--
-- Idempotent + table-guarded (defensive on a partial/fresh DB). No top-level
-- transaction control — the migration runner wraps the file.

DO $$
DECLARE
  t text;
  -- (1) Append-heavy activity logs: per-row notify is a notify-storm risk; restore the
  --     deliberate exclusion by dropping the trigger the duplicate 373 attached.
  drop_tables text[] := ARRAY[
    'audit_log', 'agent_runs_consolidated', 'user_actions',
    'harness_hook_logs', 'toast_log', 'feature_audit_consolidated'
  ];
BEGIN
  FOREACH t IN ARRAY drop_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.%I', t);
    END IF;
  END LOOP;

  -- (2) bee_claim_specs — close the real-table coverage gap (mig-372 added it post-audit).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'harness_shared' AND c.relname = 'bee_claim_specs' AND c.relkind = 'r'
  ) THEN
    EXECUTE
      'CREATE OR REPLACE TRIGGER emit_change_notify_trg '
      || 'AFTER INSERT OR UPDATE OR DELETE ON harness_shared.bee_claim_specs '
      || 'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()';
  END IF;
END $$;
