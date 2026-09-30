-- 1109-close-sync-trigger-coverage-gaps.sql — WI-6182 verification blocker.
--
-- TABLE_TO_QUERY_NAMES already mapped these low-churn relations into the
-- sync-invalidation bridge, but their original feature migrations never
-- attached the producer-side emit_change_notify trigger. That made the map
-- inert for raw-SQL and federated writers. The migrated-database coverage guard
-- found the complete set while verifying WI-6182; attach the established
-- generic producer to close the gap at its source.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'admission_runs',
    'agent_loop_approvals',
    'agent_loop_sessions',
    'goal_pots',
    'goals',
    'plan_spec_clause_revisions',
    'plan_spec_clauses',
    'spec_evidence_bindings',
    'work_item_deps',
    'work_item_spec_revision_edges'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname = t
         AND c.relkind = 'r'
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
