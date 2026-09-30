-- 013-fts-indexes.sql
--
-- Phase E polish: Postgres full-text search support for the agent-mcp
-- `search:query` tool. Adds tsvector generated columns + GIN indexes on
-- the text-bearing columns of harness_shared.* tables.
--
-- Idempotent — safe to re-run.
--
-- The agent-mcp tool currently uses ILIKE (substring matching). Switching
-- to FTS requires no signature change to the tool — it queries against
-- these `_search` columns when available.
--
-- jsonb columns (audit_log.details) are explicitly excluded; FTS over
-- jsonb requires a generated text-flattened column which is deferred to
-- v1.5 per the spec.

-- ────────────────────────────────────────────────────────────────────────
-- harness_shared.harness_features_consolidated — tasks/features text search
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS _search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(notes, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS hfc_search_idx
  ON harness_shared.harness_features_consolidated USING GIN (_search);

-- ────────────────────────────────────────────────────────────────────────
-- harness_shared.goals — title + body
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS _search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(body, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS goals_search_idx
  ON harness_shared.goals USING GIN (_search);

-- ────────────────────────────────────────────────────────────────────────
-- harness_shared.projects — name + slug
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.projects
  ADD COLUMN IF NOT EXISTS _search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(slug, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS projects_search_idx
  ON harness_shared.projects USING GIN (_search);

-- ────────────────────────────────────────────────────────────────────────
-- harness_shared.audit_log — subject + action (text columns only;
-- payload jsonb deferred to v1.5)
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.audit_log
  ADD COLUMN IF NOT EXISTS _search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', COALESCE(subject, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(action, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(actor, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS audit_search_idx
  ON harness_shared.audit_log USING GIN (_search);
