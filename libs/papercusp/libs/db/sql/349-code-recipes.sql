-- 349-code-recipes.sql — agent-authored reusable code:run scripts ("recipes")
-- (code-recipes-2026-06-21 Phase 1).
--
-- A RECIPE is a saved code:run script. On a SUCCESSFUL code:run the deterministic
-- handler upserts a recipe (title+description required; no run-without-save). Dedup
-- rides @papercusp/search: title_tsv (BM25 lexical leg) + embedding (pgvector cosine
-- leg, 384-dim to match the operator embedder) + tools_used (structural overlap leg).
-- Recipes are HIVE-scoped (the sharing boundary) — Queen-led graduation reviews them.
--
-- code_recipe_runs is the per-execution side-table: it is the source of truth for the
-- distinct-agent + frequency signals the Phase-3 graduation rubric reads; the counters
-- on code_recipes are denormalized for cheap reads.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe (runs after the
-- 000-baseline `vector` extension + harness_app/harness_zero roles exist).

CREATE TABLE IF NOT EXISTS harness_shared.code_recipes (
  id              TEXT PRIMARY KEY,                  -- stable kebab id (slug)
  workspace_id    TEXT NOT NULL,
  hive_slug       TEXT,                              -- sharing boundary; NULL ⇒ workspace-global
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  script          TEXT NOT NULL,                     -- the code:run body
  author_role     TEXT,
  tools_used      TEXT[] NOT NULL DEFAULT '{}',      -- canonical tool names the script references (structural dedup leg)
  run_count       INTEGER NOT NULL DEFAULT 0,        -- denormalized from code_recipe_runs
  success_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',    -- active | promoted | retired | merged
  promoted_tool   TEXT,                              -- the defineTool name once graduated (status=promoted)
  merged_into     TEXT,                              -- the surviving recipe id once merged (status=merged)
  tags            TEXT[] NOT NULL DEFAULT '{}',
  embedding       VECTOR(384),                       -- title+description embedding (cosine dedup leg); NULL until embedded
  title_tsv       TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('english', COALESCE(title,'') || ' ' || COALESCE(description,''))
                  ) STORED,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_recipes_ws_hive_idx
  ON harness_shared.code_recipes (workspace_id, hive_slug);
CREATE INDEX IF NOT EXISTS code_recipes_title_tsv_idx
  ON harness_shared.code_recipes USING gin (title_tsv);
CREATE INDEX IF NOT EXISTS code_recipes_runcount_idx
  ON harness_shared.code_recipes (workspace_id, hive_slug, run_count DESC);

CREATE TABLE IF NOT EXISTS harness_shared.code_recipe_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id     TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  hive_slug     TEXT,
  agent_owner   TEXT,                                -- the coord ownerId that ran it (distinct-agent signal)
  agent_role    TEXT,
  success       BOOLEAN NOT NULL DEFAULT TRUE,
  reused        BOOLEAN NOT NULL DEFAULT FALSE,      -- TRUE when this was a recipes:run of an existing recipe (vs an authored code:run)
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS code_recipe_runs_recipe_idx
  ON harness_shared.code_recipe_runs (recipe_id, ts DESC);
CREATE INDEX IF NOT EXISTS code_recipe_runs_ws_idx
  ON harness_shared.code_recipe_runs (workspace_id, ts DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.code_recipes TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.code_recipe_runs TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.code_recipes TO harness_zero;
  GRANT SELECT ON harness_shared.code_recipe_runs TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.code_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_recipes_workspace_isolation ON harness_shared.code_recipes;
CREATE POLICY code_recipes_workspace_isolation ON harness_shared.code_recipes
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.code_recipe_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_recipe_runs_workspace_isolation ON harness_shared.code_recipe_runs;
CREATE POLICY code_recipe_runs_workspace_isolation ON harness_shared.code_recipe_runs
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
