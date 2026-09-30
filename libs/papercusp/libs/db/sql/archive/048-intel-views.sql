-- Migration 048 — Intel panel query views over tool_invocations.
--
-- Two read-only views the harness Intel panel queries:
--   1. tool_invocations_spawn_tree: recursive CTE over parent_spawn_id
--      so the UI can render the spawn-of-spawn lineage as a tree.
--      Today every row's parent_spawn_id is null (Phase 9 not yet
--      implemented), so the view's depth column is 0 for every row,
--      but the shape is forward-compatible: when Phase 9's spawn
--      primitive lights up, this view immediately shows real chains.
--
--   2. tool_invocations_artifacts: pack/diff calls that wrote a
--      scratch-dir output (output_ref IS NOT NULL). Used by the
--      Pack/Diff sub-tabs to link back to the on-disk artifact.
--
-- RLS inherits from the underlying table (harness_shared.tool_invocations
-- has workspace-scoped RLS via Migration 046; views observe it).
--
-- Idempotent: CREATE OR REPLACE so re-applying the migration just
-- updates the view definitions.

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE VIEW harness_shared.tool_invocations_spawn_tree AS
WITH RECURSIVE chain AS (
  -- Roots: spawns with no parent (today: every row).
  SELECT
    id, workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, invoked_at, duration_ms, status,
    output_ref, output_size, error_message,
    0 AS depth,
    spawn_id::text AS root_spawn_id
  FROM harness_shared.tool_invocations
  WHERE parent_spawn_id IS NULL OR parent_spawn_id = ''
  UNION ALL
  -- Children: link via parent_spawn_id → ancestor's spawn_id. Depth
  -- bounded at 16 so a malformed cycle can't blow up.
  SELECT
    t.id, t.workspace_id, t.harness_slug, t.plugin_name, t.tool_name, t.role,
    t.feature_id, t.chunk_id, t.run_id, t.spawn_id, t.parent_spawn_id,
    t.window_key, t.invoked_at, t.duration_ms, t.status,
    t.output_ref, t.output_size, t.error_message,
    c.depth + 1,
    c.root_spawn_id
  FROM harness_shared.tool_invocations t
  JOIN chain c
    ON t.parent_spawn_id = c.spawn_id
   AND t.workspace_id = c.workspace_id
   AND c.depth < 16
)
SELECT * FROM chain;

COMMENT ON VIEW harness_shared.tool_invocations_spawn_tree IS
  'Recursive lineage over tool_invocations.parent_spawn_id. depth=0 for
   roots; depth>0 for spawn-of-spawn children (Phase 9). RLS inherits from
   harness_shared.tool_invocations.';

CREATE OR REPLACE VIEW harness_shared.tool_invocations_artifacts AS
SELECT
  id, workspace_id, harness_slug, plugin_name, tool_name, role,
  feature_id, chunk_id, run_id, spawn_id,
  invoked_at, duration_ms, status,
  output_ref, output_size
FROM harness_shared.tool_invocations
WHERE output_ref IS NOT NULL AND output_ref <> ''
  AND status = 'ok';

COMMENT ON VIEW harness_shared.tool_invocations_artifacts IS
  'Successful tool calls that wrote a scratch-dir output (Pack, Diff,
   Repomix). Feeds the Intel panel''s Pack + Diff sub-tabs.';

GRANT SELECT ON harness_shared.tool_invocations_spawn_tree TO harness_app;
GRANT SELECT ON harness_shared.tool_invocations_artifacts TO harness_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
    GRANT SELECT ON harness_shared.tool_invocations_spawn_tree TO harness_admin;
    GRANT SELECT ON harness_shared.tool_invocations_artifacts TO harness_admin;
  END IF;
END $$;

COMMIT;
