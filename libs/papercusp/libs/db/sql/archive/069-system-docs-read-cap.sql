-- 069-system-docs-read-cap.sql
--
-- Grant `docs:read` to existing system principals (oracle + operator)
-- on all workspaces. The original ORACLE_CAPS / OPERATOR_CAPS lists
-- in apps/operator/app/api/agent-mcp/provision/route.ts predate the
-- docs-retrieval rollout (Phase 1 added `docs:read` as a capability;
-- Phase 2.4 exposes papercusp://docs/* MCP resources gated on it).
--
-- Without this, MCP `resources/list` filters out the new docs
-- resources for every workspace that was provisioned before the docs
-- arc landed.
--
-- The provision route is also updated to include `docs:read` in
-- ORACLE_CAPS, so new workspaces will already have it.
--
-- Idempotent: jsonb concat with a uniqueness check.

UPDATE harness_shared.system_principals
   SET capabilities = capabilities || '["docs:read"]'::jsonb
 WHERE name IN ('oracle', 'operator')
   AND NOT (capabilities @> '["docs:read"]'::jsonb);
