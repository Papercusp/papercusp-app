-- 213-spawned-agents-outcome-reactivity.sql
-- adv-harness-tab-migration-2026-05-30 P-023.
--
-- The Harnesses-tab DetailPanel's "Recent activity" now projects a run's
-- OUTCOME (status / exit_code / error_message) + native resume session_id by
-- LEFT-JOINing harness_shared.spawned_agents onto agent_runs_consolidated in
-- the agentRunsConsolidated.* sync resolvers. For that projection to update
-- live, spawned_agents writes must emit the `sync_invalidate` NOTIFY the SSE
-- bridge listens on (the migration-107 pattern).
--
-- COLUMN-TARGETED on purpose: spawned_agents takes a heartbeat_at write every
-- few seconds per running bee (spawned_agents_active_heartbeat_idx exists for
-- exactly that traffic). A bare row trigger would re-fire the joined queries
-- on every heartbeat; restricting the UPDATE leg to the outcome columns the
-- projection actually reads keeps the invalidation volume at
-- one-per-lifecycle-transition.
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR DELETE OR UPDATE OF status, exit_code, error_message, session_id
  ON harness_shared.spawned_agents
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
