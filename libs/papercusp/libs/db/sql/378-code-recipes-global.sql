-- 378: code_recipes -> GLOBAL (data-scoping-audit-2026-06-22, P-001).
--
-- Decision (the owner's tools principle): a RECIPE is a reusable capability, exactly
-- like a tool definition — a good recipe should help every hive, not be siloed per
-- workspace/hive. So drop the workspace_id + hive_slug scope from the recipe
-- DEFINITIONS. code_recipe_runs KEEPS workspace_id + hive_slug — that is USAGE (which
-- hive ran it), the mirror of tool_invocations being scoped while tool definitions
-- are global.
--
-- code_recipes.id is already the PRIMARY KEY (no workspace in the key) and ids are
-- globally unique (verified: 14 rows, 14 distinct ids), so no dedup/backfill is
-- needed (D-006). RLS: global tables in this schema carry no RLS (the
-- model_pricing / users / memory_canonical pattern — RLS disabled, 0 policies), so
-- drop the per-workspace isolation policy and disable RLS. Idempotent.

DO $mig378$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name   = 'code_recipes'
      AND column_name  = 'workspace_id'
  ) THEN
    -- RLS: recipes are global now — drop the per-workspace isolation + disable RLS
    -- (matches model_pricing / users / memory_canonical and the other global tables).
    DROP POLICY IF EXISTS code_recipes_workspace_isolation ON harness_shared.code_recipes;
    ALTER TABLE harness_shared.code_recipes DISABLE ROW LEVEL SECURITY;

    -- the workspace+hive list/search index is meaningless once global
    DROP INDEX IF EXISTS harness_shared.code_recipes_ws_hive_idx;

    -- drop the scope columns. This AUTO-DROPS the workspace_id NOT NULL constraint
    -- AND any index referencing them — including code_recipes_runcount_idx, which
    -- led with (workspace_id, hive_slug) — so it is recreated globally below.
    ALTER TABLE harness_shared.code_recipes DROP COLUMN IF EXISTS hive_slug;
    ALTER TABLE harness_shared.code_recipes DROP COLUMN IF EXISTS workspace_id;

    -- recreate the list/order index globally (matches listRecipes ORDER BY:
    -- last_run_at DESC NULLS LAST, run_count DESC).
    CREATE INDEX IF NOT EXISTS code_recipes_runcount_idx
      ON harness_shared.code_recipes USING btree (last_run_at DESC NULLS LAST, run_count DESC);
  END IF;
END $mig378$;
