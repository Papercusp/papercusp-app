-- 460-tool-invocations-spawn-tree-function.sql
--
-- WI-1671 (follow-up to EI-6801 / migration 457): the durable fix for
-- harness_shared.tool_invocations_spawn_tree doing O(whole-table) work per
-- query regardless of the caller's filter.
--
-- ROOT CAUSE (confirmed 2026-07-02): the view is a `WITH RECURSIVE` query
-- whose non-recursive (base) term has NO filter — Postgres cannot push a
-- caller's outer WHERE (workspace_id/harness_slug/invoked_at/status) into a
-- recursive CTE's base term (no such optimization exists in any current PG
-- version), so EVERY query unconditionally evaluates the base case over the
-- WHOLE tool_invocations table (7.4M rows as of writing, 99.73% of which
-- qualify as "roots") before any filter or LIMIT applies. Migration 457 added
-- a partial index for the recursive term's JOIN, but that does not touch the
-- base case's full scan — this migration is the actual redesign.
--
-- DESIGN (per the WI-1671 investigation): flip the direction of the walk.
-- Both real callers (intel-spawn-tree.ts's HTTP route, intel:spawn_tree's MCP
-- tool) filter the OUTER result by the ROW's OWN workspace_id/harness_slug/
-- invoked_at/status — not the row's root's — so the exact same set of output
-- rows can instead be selected FIRST, directly and indexed
-- (tool_invocations_telemetry_idx: workspace_id, harness_slug, invoked_at
-- DESC), THEN for just that LIMIT-bounded candidate set (<=2000 rows), walk
-- UPWARD via parent_spawn_id to compute depth + root_spawn_id — capped at 16
-- hops, mirroring the view's own `c.depth < 16` cutoff. Since ~99.73% of rows
-- are already roots, the vast majority of candidates resolve in 0 extra hops;
-- the rare true descendant costs at most 16 indexed point-lookups. This is the
-- SAME row-selection predicate as today (so "which rows appear in the
-- output" is unchanged) — only the WAY depth/root_spawn_id are computed
-- changes, from "recurse down through the whole table" to "walk up from a
-- small candidate set".
--
-- KNOWN, ACCEPTED WRINKLE (documented on WI-1671, not newly introduced by this
-- migration): tool_invocations.spawn_id is NOT unique — e.g. many unrelated
-- rows share the literal sentinel spawn_id 'event-reaction'. The ORIGINAL
-- view's downward recursive JOIN (`t.parent_spawn_id = c.spawn_id`) already
-- fans out ambiguously for such duplicates; this upward walk has the exact
-- same ambiguity in the reverse direction (an upward lookup keyed on
-- `spawn_id = <this row's parent_spawn_id>` can match more than one row for a
-- shared sentinel value, same as today). Neither direction is more "correct"
-- for the overloaded case — this migration does not resolve that pre-existing
-- ambiguity, only the performance regression.
--
-- The view stays (nothing currently queries it directly after the call-site
-- migration lands in the same change) — kept for any ad-hoc admin querying,
-- now clearly documented as the slow path.

-- Needed for the upward walk's per-candidate ancestor lookup
-- (`p.spawn_id = a.parent_spawn_id AND p.workspace_id = a.workspace_id`).
-- Every row has a non-null spawn_id (NOT NULL column), so this is a full
-- index — but lookups are always small, bounded point-reads (<=2000
-- candidates x <=16 hops), so index SIZE doesn't matter, only that the
-- equality lookup is indexed at all (today it is a full seq scan).
CREATE INDEX IF NOT EXISTS tool_invocations_spawn_id_ws_idx
  ON harness_shared.tool_invocations USING btree (workspace_id, spawn_id);

CREATE OR REPLACE FUNCTION harness_shared.tool_invocations_spawn_tree_filtered(
  p_harness_slug text,
  p_since timestamp with time zone,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_workspace_id text DEFAULT NULL  -- NULL: rely on the calling role's RLS (ctx.tx path);
                                     -- non-NULL: explicit scope (admin-role callers that
                                     -- bypass RLS, e.g. getOrgPg — P-041).
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

COMMENT ON FUNCTION harness_shared.tool_invocations_spawn_tree_filtered IS
  'WI-1671: indexed replacement for tool_invocations_spawn_tree. Selects the
   filtered candidate rows FIRST (uses tool_invocations_telemetry_idx), then
   walks UPWARD (<=16 hops, tool_invocations_spawn_id_ws_idx) to compute
   depth/root_spawn_id, instead of the view''s unfiltered whole-table
   downward recursion. p_workspace_id NULL relies on the caller''s RLS.';
