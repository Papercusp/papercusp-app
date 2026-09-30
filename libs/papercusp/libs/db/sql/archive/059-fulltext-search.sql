-- 059-fulltext-search.sql
--
-- BM25-style full-text search over unstructured prose. Postgres
-- tsvector + GIN index — zero extensions, zero new infra.
--
-- Plan 2A: ship this first; observe for 1-2 weeks before adding
-- pgvector/embeddings (Plan 2B+C). BM25 alone is often enough for
-- the recall use case (user references "remember when we decided…").
--
-- Indexed prose surfaces (initial):
--   - harness_escalations.escalation + supervisor_notes  (per-harness)
--   - harness_brainstorm.content                         (per-harness)
--   - operator_turns.text — all roles, all turns (per-workspace)
--
-- The tsvector column is computed live via a trigger so writers
-- never need to update it. Indexed via GIN for fast match.
--
-- Tool surface: `search:fulltext` (search/fulltext.ts) — agent-callable
-- via the agent-mcp catalog. See operator.tools.md "Recall older
-- context" workflow.

CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- for similarity ranking on short queries

-- ── harness_escalations ─────────────────────────────────────────────

ALTER TABLE harness_shared.harness_escalations
  ADD COLUMN IF NOT EXISTS body_tsv tsvector;

CREATE OR REPLACE FUNCTION harness_shared.harness_escalations_tsv_update()
RETURNS trigger AS $$
BEGIN
  NEW.body_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.escalation, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.supervisor_notes, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_escalations_tsv_trigger ON harness_shared.harness_escalations;
CREATE TRIGGER harness_escalations_tsv_trigger
  BEFORE INSERT OR UPDATE OF escalation, supervisor_notes
  ON harness_shared.harness_escalations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_escalations_tsv_update();

-- Backfill existing rows
UPDATE harness_shared.harness_escalations
   SET body_tsv =
     setweight(to_tsvector('english', coalesce(escalation, '')), 'A') ||
     setweight(to_tsvector('english', coalesce(supervisor_notes, '')), 'B')
 WHERE body_tsv IS NULL;

CREATE INDEX IF NOT EXISTS harness_escalations_tsv_idx
  ON harness_shared.harness_escalations USING GIN (body_tsv);

-- ── harness_brainstorm ──────────────────────────────────────────────

ALTER TABLE harness_shared.harness_brainstorm
  ADD COLUMN IF NOT EXISTS content_tsv tsvector;

CREATE OR REPLACE FUNCTION harness_shared.harness_brainstorm_tsv_update()
RETURNS trigger AS $$
BEGIN
  NEW.content_tsv := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_brainstorm_tsv_trigger ON harness_shared.harness_brainstorm;
CREATE TRIGGER harness_brainstorm_tsv_trigger
  BEFORE INSERT OR UPDATE OF content
  ON harness_shared.harness_brainstorm
  FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_brainstorm_tsv_update();

UPDATE harness_shared.harness_brainstorm
   SET content_tsv = to_tsvector('english', coalesce(content, ''))
 WHERE content_tsv IS NULL;

CREATE INDEX IF NOT EXISTS harness_brainstorm_tsv_idx
  ON harness_shared.harness_brainstorm USING GIN (content_tsv);

-- ── operator_turns ──────────────────────────────────────────────────
--
-- Operator turns are append-only and large (~hundreds of rows per
-- workspace). We index ALL roles since user turns are valuable too
-- ("remember when I asked about X"). The search tool filters at query
-- time via WHERE clauses.

ALTER TABLE harness_shared.operator_turns
  ADD COLUMN IF NOT EXISTS text_tsv tsvector;

CREATE OR REPLACE FUNCTION harness_shared.operator_turns_tsv_update()
RETURNS trigger AS $$
BEGIN
  NEW.text_tsv := to_tsvector('english', coalesce(NEW.text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operator_turns_tsv_trigger ON harness_shared.operator_turns;
CREATE TRIGGER operator_turns_tsv_trigger
  BEFORE INSERT OR UPDATE OF text
  ON harness_shared.operator_turns
  FOR EACH ROW EXECUTE FUNCTION harness_shared.operator_turns_tsv_update();

UPDATE harness_shared.operator_turns
   SET text_tsv = to_tsvector('english', coalesce(text, ''))
 WHERE text_tsv IS NULL;

CREATE INDEX IF NOT EXISTS operator_turns_tsv_idx
  ON harness_shared.operator_turns USING GIN (text_tsv);
