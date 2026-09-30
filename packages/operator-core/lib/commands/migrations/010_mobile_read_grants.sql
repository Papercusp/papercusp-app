-- 010: Grant SELECT on harness_shared tables that mobile reads via withWorkspace.
--
-- Mobile reads these via `harness_app` role (default for @restart/db-org).
-- Without these grants, /api/mobile/running, /api/mobile/harnesses,
-- /api/mobile/harnesses/:slug, /api/mobile/actions/recent,
-- /api/mobile/notifications/recent all 500 with
-- "permission denied for table <name>". RLS policies are workspace-scoped
-- but PG checks table ACL first, so the policy never gets a chance.
GRANT SELECT ON harness_shared.harness_status      TO harness_app;
GRANT SELECT ON harness_shared.harness_lanes       TO harness_app;
GRANT SELECT ON harness_shared.harness_escalations TO harness_app;
GRANT SELECT ON harness_shared.harness_smoke_test  TO harness_app;
GRANT SELECT ON harness_shared.harness_plan_review TO harness_app;
GRANT SELECT ON harness_shared.operator_scans      TO harness_app;
GRANT SELECT ON harness_shared.toast_log           TO harness_app;
GRANT SELECT ON harness_shared.audit_log           TO harness_app;
GRANT SELECT ON harness_shared.harness_registry  TO harness_app;
