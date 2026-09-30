-- 016-harness-admin-bypassrls.sql
--
-- Grant BYPASSRLS to the harness_admin role.
--
-- 010-workspace-scoping-rls.sql commented "harness_admin bypasses RLS via
-- FORCE not being applied + table owner being a superuser", but the
-- table owner is postgres_app (not harness_admin), so harness_admin was
-- in fact subject to RLS. That broke any admin-scope cross-workspace
-- lookup that runs without a workspace GUC set — most importantly
-- packages/agent-mcp/src/auth.ts's resolveBearer(), which queries
-- harness_shared.token_index by token alone (the workspace is what we're
-- trying to *derive*).
--
-- Match the documented intent: harness_admin is the privileged client
-- used by tooling, migrations, and cross-workspace token resolution.
-- harness_app stays subject to RLS (the constrained application path).

ALTER ROLE harness_admin BYPASSRLS;
