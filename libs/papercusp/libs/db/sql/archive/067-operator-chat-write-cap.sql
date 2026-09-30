-- 067-operator-chat-write-cap.sql
--
-- Grant `chat:write` to existing system:operator principals on all
-- workspaces. The original OPERATOR_CAPS in
-- apps/operator/app/api/agent-mcp/provision/route.ts omitted
-- `chat:write`, so any workspace that was provisioned before this
-- migration cannot invoke `chat:ask_choice` (returns 403
-- "missing_capability").
--
-- Pass-9 E2E audit (2026-05-13) found this gap when probing the
-- bespoke-card-improvements arc — the operator agent could not call
-- the very tool its UI renders cards for.
--
-- The provision route is also updated to include `chat:write` in
-- OPERATOR_CAPS, so new workspaces will already have it.
--
-- Idempotent: jsonb concat with a uniqueness check.

UPDATE harness_shared.system_principals
   SET capabilities = capabilities || '["chat:write"]'::jsonb
 WHERE name = 'operator'
   AND NOT (capabilities @> '["chat:write"]'::jsonb);
