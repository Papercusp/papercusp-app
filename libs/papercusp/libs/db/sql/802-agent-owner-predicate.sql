-- 802-agent-owner-predicate.sql
-- FORWARD-COMPAT: additive function/comment only; no existing rows or columns are changed.
-- EI-20202338985443847: coord_owner_id is a mixed principal column. Keep the
-- classification in one database predicate so adoption queries cannot each grow
-- a different exclusion list.

CREATE OR REPLACE FUNCTION harness_shared.is_agent_coord_owner_id(
  p_owner_id text,
  p_role text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN p_owner_id IS NULL OR btrim(p_owner_id) = '' THEN false
    -- These are admitted superuser fallbacks, not an individual agent owner.
    WHEN p_owner_id IN ('su-loopback', 'loopback') THEN false
    -- Principal-backed runtime work is system-owned even when its coarse role
    -- happens to be release-fixer/content-fixer.
    WHEN p_owner_id LIKE 'system:%' THEN false
    -- Individual identities emitted by resolveAgentIdentity().
    WHEN p_owner_id ~ '^(su|s|pus)-' THEN true
    -- Static-client release/content fixers use bare UUID client ids. The role
    -- is the distinguishing evidence; arbitrary UUID UI clients are not agents.
    WHEN p_role IN ('release-fixer', 'content-fixer')
      AND p_owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN true
    ELSE false
  END
$function$;

COMMENT ON FUNCTION harness_shared.is_agent_coord_owner_id(text, text) IS
  'Canonical classifier for agent adoption metrics over tool_invocations.coord_owner_id. True for individual su-/s-/pus- identities and role-backed bare-UUID release-fixer/content-fixer static clients. False for system/UI/test/mcp-call/loopback principals and shared harness: signed-spawn attribution. Metrics must call this predicate instead of grouping raw coord_owner_id.';

COMMENT ON COLUMN harness_shared.tool_invocations.coord_owner_id IS
  'Coordination owner id from resolveAgentIdentity(ctx). The column also contains system, UI, test, mcp-call, and loopback principals; use harness_shared.is_agent_coord_owner_id(coord_owner_id, role) before treating it as an individual agent for adoption metrics.';
