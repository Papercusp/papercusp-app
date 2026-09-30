-- Phase: spec-driven additions for goal-ancestry, atomic checkout,
-- pending_events queue, and routines.
--
-- Adds to harness_shared:
--   - goals             (top-level missions; tasks trace back here)
--   - pending_events    (queue feeding the orchestrator: cron / webhook / api)
--   - routines          (scheduled or triggered event sources)
--   - task_lineage()    (recursive CTE function returning ancestry chain)
--
-- Backfills existing per-harness `harness_features` tables with:
--   - parent_id       TEXT (self-ref)
--   - goal_id         TEXT (cross-schema reference to harness_shared.goals)
--   - taken_by        TEXT (atomic checkout — which worker claimed this row)
--   - taken_at        TIMESTAMPTZ
--   - expires_at      TIMESTAMPTZ (orphan recovery)
--
-- Idempotent — safe to re-run.

-- ── 1. goals ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.goals (
  id            TEXT PRIMARY KEY,
  install_slug  TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  parent_id     TEXT REFERENCES harness_shared.goals(id) ON DELETE SET NULL,
  budget_cents  BIGINT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB
);
CREATE INDEX IF NOT EXISTS goals_install_idx ON harness_shared.goals(install_slug);
CREATE INDEX IF NOT EXISTS goals_parent_idx  ON harness_shared.goals(parent_id);
CREATE INDEX IF NOT EXISTS goals_status_idx  ON harness_shared.goals(status);

-- ── 2. pending_events ───────────────────────────────────────────────────
-- Queue read by the orchestrator on each tick. Inserts come from:
--   - routine ticker (cron-due routines)
--   - webhook handlers
--   - API triggers
--   - completion-delta hooks
--
-- The orchestrator decides whether to dispatch each event's target_role
-- (it can defer or skip). consumed_at marks the event as handled.
CREATE TABLE IF NOT EXISTS harness_shared.pending_events (
  id            TEXT PRIMARY KEY,
  install_slug  TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- 'routine' | 'webhook' | 'api' | 'completion'
  target_role   TEXT NOT NULL,
  payload       JSONB,
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ,
  consumed_by   TEXT,
  source_id     TEXT                   -- e.g. routine.id when kind='routine'
);
CREATE INDEX IF NOT EXISTS pending_events_unconsumed_idx
  ON harness_shared.pending_events(install_slug, due_at)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS pending_events_source_idx
  ON harness_shared.pending_events(source_id);

-- ── 3. routines ─────────────────────────────────────────────────────────
-- Scheduled or triggered event sources. The substrate's "routine ticker"
-- evaluates active cron routines every ~30s; webhook routines insert events
-- on POST receipt; api routines on internal POST.
CREATE TABLE IF NOT EXISTS harness_shared.routines (
  id                TEXT PRIMARY KEY,
  install_slug      TEXT NOT NULL,
  name              TEXT NOT NULL,
  trigger_kind      TEXT NOT NULL,         -- 'cron' | 'webhook' | 'api'
  trigger_config    JSONB NOT NULL,        -- { cron: '0 9 * * MON' } | { webhook_token: '...' }
  target_role       TEXT NOT NULL,
  payload_template  JSONB,
  concurrency       TEXT NOT NULL DEFAULT 'queue',     -- 'queue' | 'skip' | 'cancel-prev'
  catchup           TEXT NOT NULL DEFAULT 'skip-old',  -- 'skip-old' | 'run-all-backlog'
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at     TIMESTAMPTZ,
  next_fire_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB,
  UNIQUE (install_slug, name)
);
CREATE INDEX IF NOT EXISTS routines_active_due_idx
  ON harness_shared.routines(active, next_fire_at)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS routines_install_idx
  ON harness_shared.routines(install_slug);

-- ── 4. Per-harness backfill: add goal-ancestry + atomic-checkout columns ─
-- Iterates over every harness_<slug> schema and ALTERs harness_features.
DO $$
DECLARE
  schema_rec RECORD;
BEGIN
  FOR schema_rec IN
    SELECT n.nspname AS schema_name
    FROM pg_namespace n
    WHERE n.nspname LIKE 'harness\_%' ESCAPE '\'
      AND n.nspname NOT IN ('harness_shared')
      AND EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.relnamespace = n.oid AND c.relname = 'harness_features'
      )
  LOOP
    -- Add columns idempotently. ADD COLUMN IF NOT EXISTS is Postgres 9.6+
    EXECUTE format(
      'ALTER TABLE %I.harness_features
         ADD COLUMN IF NOT EXISTS parent_id  TEXT,
         ADD COLUMN IF NOT EXISTS goal_id    TEXT,
         ADD COLUMN IF NOT EXISTS taken_by   TEXT,
         ADD COLUMN IF NOT EXISTS taken_at   TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
      schema_rec.schema_name
    );

    -- Index names match the 002 per-harness template (bare hf_<name>_idx).
    -- With IF NOT EXISTS this becomes a no-op when 002 already created
    -- them. Earlier versions of this migration used schema-prefixed names
    -- (`<schema>_hf_*_idx`) and produced a duplicate of every index on
    -- every harness_features table — 4 redundant indexes per schema, ~72
    -- across the workspace. Cleaned up 2026-05-05.

    -- Index for atomic checkout: find available work fast
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS hf_available_idx
         ON %I.harness_features(harness_slug, status)
         WHERE taken_by IS NULL',
      schema_rec.schema_name
    );

    -- Index for orphan recovery: find expired checkouts
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS hf_expires_idx
         ON %I.harness_features(expires_at)
         WHERE taken_by IS NOT NULL',
      schema_rec.schema_name
    );

    -- Index for goal-ancestry queries
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS hf_goal_idx
         ON %I.harness_features(goal_id)',
      schema_rec.schema_name
    );

    -- Index for parent-ancestry queries
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS hf_parent_idx
         ON %I.harness_features(harness_slug, parent_id)',
      schema_rec.schema_name
    );
  END LOOP;
END $$;

-- ── 5. task_lineage() — recursive CTE returning ancestry ───────────────
-- Returns: rows for every ancestor task plus the top-level goal.
-- Worker prompts inject this as "## Why this matters" so agents always
-- see the full goal lineage of the task they're working on.
--
-- Args:
--   p_schema_name   TEXT — which harness_<slug> schema to query
--   p_harness_slug  TEXT — value of the harness_slug column
--   p_feature_id    TEXT — starting feature
--
-- Returns: (level int, kind text, id text, title text)
--   level 0 = the feature itself; increasing = ancestors; 99 = goal
CREATE OR REPLACE FUNCTION harness_shared.task_lineage(
  p_schema_name  TEXT,
  p_harness_slug TEXT,
  p_feature_id   TEXT
)
RETURNS TABLE(level INT, kind TEXT, id TEXT, title TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  result_query TEXT;
BEGIN
  result_query := format($q$
    WITH RECURSIVE chain AS (
      SELECT 0::int  AS level,
             'task'::text AS kind,
             feature_id AS id,
             title,
             parent_id,
             goal_id
        FROM %I.harness_features
       WHERE harness_slug = $1 AND feature_id = $2
      UNION ALL
      SELECT c.level + 1,
             'task'::text,
             f.feature_id,
             f.title,
             f.parent_id,
             f.goal_id
        FROM chain c
        JOIN %I.harness_features f
          ON f.harness_slug = $1 AND f.feature_id = c.parent_id
       WHERE c.parent_id IS NOT NULL
    )
    SELECT level, kind, id, title FROM chain
    UNION ALL
    SELECT 99::int AS level,
           'goal'::text AS kind,
           g.id,
           g.title
      FROM harness_shared.goals g
      JOIN (
        SELECT goal_id FROM chain WHERE goal_id IS NOT NULL
        ORDER BY level DESC LIMIT 1
      ) c ON g.id = c.goal_id
    ORDER BY level
  $q$, p_schema_name, p_schema_name);

  RETURN QUERY EXECUTE result_query USING p_harness_slug, p_feature_id;
END $$;

-- ── 6. Permissions ──────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA harness_shared TO harness_app, harness_admin;
GRANT EXECUTE ON FUNCTION harness_shared.task_lineage(TEXT, TEXT, TEXT) TO harness_app, harness_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA harness_shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app, harness_admin;
