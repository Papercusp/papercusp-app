-- 011-operator-decisions-view.sql
--
-- Phase C of the Agent MCP plan: expose Operator's Decisions log as a
-- SQL view over harness_shared.audit_log filtered by actor='system:operator'.
--
-- Per spec/system-and-pi-principals, system principals' actions appear
-- in audit_log with actor='system:<name>'. Operator's Decisions log is
-- "what did Operator do" — the audit rows where actor='system:operator'.
--
-- The view inherits RLS from audit_log (which is workspace-scoped per 010).
-- Reads against operator_decisions therefore see only the calling
-- workspace's Operator activity.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE VIEW harness_shared.operator_decisions AS
  SELECT
    id,
    ts,
    actor,
    action,
    subject AS target,
    details,
    workspace_id
  FROM harness_shared.audit_log
  WHERE actor = 'system:operator';

GRANT SELECT ON harness_shared.operator_decisions TO harness_app, harness_admin;

-- Convenience view: all system-principal activity (Operator + Oracle
-- + future). Useful for the spend-by-actor UX.
CREATE OR REPLACE VIEW harness_shared.system_principal_activity AS
  SELECT
    id,
    ts,
    actor,
    action,
    subject AS target,
    details,
    workspace_id
  FROM harness_shared.audit_log
  WHERE actor LIKE 'system:%' OR actor LIKE 'pi:%';

GRANT SELECT ON harness_shared.system_principal_activity TO harness_app, harness_admin;
