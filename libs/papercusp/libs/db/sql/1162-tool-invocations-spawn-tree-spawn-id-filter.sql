-- 1162-tool-invocations-spawn-tree-spawn-id-filter.sql
--
-- EI-21990784921297347: intel:spawn_tree's spawn-specific lookup intent was
-- not representable. The tool accepted harness/since/status/limit only, so a
-- caller with one spawn id had to scan the raw invocation ledger itself.
--
-- Reuse the indexed candidate-first function introduced by migration 460. Add
-- the exact spawn predicate to that candidate selection, BEFORE ORDER BY/LIMIT;
-- filtering after the bounded candidate page would silently miss a requested
-- spawn whenever newer unrelated invocations fill the page.
--
-- The old five-argument function is replaced by a six-argument form with both
-- trailing arguments defaulted. Existing callers that omit p_spawn_id remain
-- source-compatible, while the MCP tool can bind an exact value. Dropping the
-- old signature avoids an overload ambiguity for named calls that provide
-- p_workspace_id but omit p_spawn_id.

DROP FUNCTION IF EXISTS harness_shared.tool_invocations_spawn_tree_filtered(
  text,
  timestamp with time zone,
  text,
  integer,
  text
);

CREATE OR REPLACE FUNCTION harness_shared.tool_invocations_spawn_tree_filtered(
  p_harness_slug text,
  p_since timestamp with time zone,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_workspace_id text DEFAULT NULL,
  p_spawn_id text DEFAULT NULL
) RETURNS TABLE (
  id bigint,
  workspace_id text,
  harness_slug text,
  plugin_name text,
  tool_name text,
  role text,
  feature_id text,
  chunk_id text,
  run_id text,
  spawn_id text,
  parent_spawn_id text,
  window_key text,
  invoked_at timestamp with time zone,
  duration_ms integer,
  status text,
  output_ref text,
  output_size bigint,
  error_message text,
  depth integer,
  root_spawn_id text
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE candidates AS (
    SELECT t.*
      FROM harness_shared.tool_invocations t
     WHERE t.harness_slug = p_harness_slug
       AND t.invoked_at >= p_since
       AND (p_status IS NULL OR t.status = p_status)
       AND (p_workspace_id IS NULL OR t.workspace_id = p_workspace_id)
       AND (p_spawn_id IS NULL OR t.spawn_id = p_spawn_id)
     ORDER BY t.invoked_at DESC
     LIMIT p_limit
  ),
  ancestry AS (
    SELECT c.id AS candidate_id, c.spawn_id AS cur_spawn_id, c.parent_spawn_id AS cur_parent_spawn_id,
           c.workspace_id AS cur_workspace_id, 0 AS depth, c.spawn_id AS root_spawn_id
      FROM candidates c
    UNION ALL
    SELECT a.candidate_id, p.spawn_id, p.parent_spawn_id, a.cur_workspace_id, a.depth + 1, p.spawn_id
      FROM ancestry a
      JOIN harness_shared.tool_invocations p
        ON p.spawn_id = a.cur_parent_spawn_id AND p.workspace_id = a.cur_workspace_id
     WHERE a.cur_parent_spawn_id IS NOT NULL AND a.cur_parent_spawn_id <> '' AND a.depth < 16
  ),
  resolved AS (
    SELECT DISTINCT ON (candidate_id) candidate_id, depth, root_spawn_id
      FROM ancestry
     ORDER BY candidate_id, depth DESC
  )
  SELECT c.id, c.workspace_id, c.harness_slug, c.plugin_name, c.tool_name, c.role,
         c.feature_id, c.chunk_id, c.run_id, c.spawn_id, c.parent_spawn_id, c.window_key,
         c.invoked_at, c.duration_ms, c.status, c.output_ref, c.output_size, c.error_message,
         r.depth, r.root_spawn_id
    FROM candidates c
    JOIN resolved r ON r.candidate_id = c.id
   ORDER BY c.invoked_at DESC;
$$;

COMMENT ON FUNCTION harness_shared.tool_invocations_spawn_tree_filtered(
  text,
  timestamp with time zone,
  text,
  integer,
  text,
  text
) IS
  'WI-1671/EI-21990784921297347: indexed candidate-first spawn tree read. Filters workspace, harness, time, status, and optional exact spawn id before the result limit, then walks upward at most 16 hops to compute depth/root_spawn_id.';
