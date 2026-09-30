-- 170-cross-backend-usage-attribution.sql
-- Cross-backend cost capture (cross-backend-cost-capture-2026-06-01 D-005, Brief 46).
--
-- 1. agent_usage_samples (migration 161) gains:
--      model        — the per-run model id (P-002; needed to price codex's tokens and
--                     for attribution; model_class stays the bucketing key)
--      cost_source  — 'provider' (claude total_cost_usd / omp cost.total) vs
--                     'estimated' (tokens × @papercusp/model-pricing list price);
--                     NULL when cost_usd is NULL (unpriceable run)
--      harness_slug / run_id / role — run attribution (NULL on header-path rows).
--                     PG-canonical runs write no log files, so the FS-mirror
--                     agent_runs_consolidated cannot serve per-harness spend; the
--                     samples table becomes the spend source (plan D-004).
-- 2. agent_runs_consolidated gains workspace_id (P-005/D-003 #1 — same slug across
--    workspaces no longer mixes), backend, model, cost_is_estimate (codex rows priced
--    from tokens are labeled, never passed off as billed).
-- 3. Per-harness <schema>.agent_runs views are recreated: they are `SELECT *` snapshots
--    that captured the column set at creation (migration 032/132 pattern), so the new
--    consolidated columns are invisible through them until recreated.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the view loop re-runs safely.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS cost_source text,
  ADD COLUMN IF NOT EXISTS harness_slug text,
  ADD COLUMN IF NOT EXISTS run_id text,
  ADD COLUMN IF NOT EXISTS role text;

-- Existing rows that carried a cost were provider-reported (claude meridian/jsonl).
UPDATE harness_shared.agent_usage_samples
   SET cost_source = 'provider'
 WHERE cost_usd IS NOT NULL
   AND cost_source IS NULL;

-- Per-harness spend window query (SpendCard): workspace + harness + recency.
CREATE INDEX IF NOT EXISTS agent_usage_samples_harness_idx
  ON harness_shared.agent_usage_samples (workspace_id, harness_slug, ts DESC)
  WHERE harness_slug IS NOT NULL;

ALTER TABLE harness_shared.agent_runs_consolidated
  ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS backend text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS cost_is_estimate boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS arc_workspace_ts_idx
  ON harness_shared.agent_runs_consolidated (workspace_id, harness_slug, ts DESC);

-- Recreate every existing per-harness agent_runs view so the new columns project
-- through (SELECT * snapshots columns at view-creation time). Mirrors the
-- 116-consolidate-agent-chats.sql loop pattern.
DO $mig$
DECLARE
  s    TEXT;  -- schema name (harness_<slug>)
  slug TEXT;  -- registry slug (hyphenated)
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');
    IF EXISTS (
      SELECT 1 FROM information_schema.views
       WHERE table_schema = s AND table_name = 'agent_runs'
    ) THEN
      EXECUTE format('DROP VIEW IF EXISTS %I.agent_runs CASCADE', s);
      EXECUTE format($v$
        CREATE VIEW %I.agent_runs AS
          SELECT * FROM harness_shared.agent_runs_consolidated
          WHERE harness_slug = %L
          WITH CHECK OPTION
      $v$, s, slug);
      EXECUTE format('ALTER VIEW %I.agent_runs ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.agent_runs TO harness_app, harness_admin', s);
      BEGIN
        EXECUTE format('GRANT SELECT ON %I.agent_runs TO harness_zero', s);
      EXCEPTION WHEN undefined_object THEN
        NULL; -- harness_zero role absent on some substrates
      END;
    END IF;
  END LOOP;
END
$mig$;

COMMIT;
