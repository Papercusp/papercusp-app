-- Migration 043 — `see_also TEXT[]` on harness_features_consolidated.
--
-- Phase 2 of the agent-memory plan. Adds an explicit per-feature
-- "look at these too" cross-link column so workers can be guided to
-- related features beyond what tags + tsvector search would surface.
--
-- Tags already exist (`tags JSONB`) on the consolidated table — this
-- migration only adds the see-also relation and refreshes per-harness
-- views so they expose the new column.
--
-- View refresh: per-harness `harness_<slug>.harness_features` is a
-- `SELECT *` view over the consolidated table. PG resolves `*` at view
-- creation time and does NOT auto-track new columns. We refresh each
-- view via the registry's recorded slugs so the new column propagates
-- without requiring a re-scaffold of every harness.

BEGIN;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS see_also TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS hfc_see_also_gin
  ON harness_shared.harness_features_consolidated
  USING GIN (see_also);

-- Refresh per-harness views so they expose see_also. CREATE OR REPLACE
-- VIEW with `SELECT *` permits adding columns at the end (see PG docs:
-- "The new query must generate the same columns ... but it may add
-- additional columns to the end of the list"). Slug → schema name maps
-- via lower(replace(slug, '-', '_')); we walk the registry to recover
-- the original slugs for the WHERE clause.
DO $$
DECLARE
  ws_payload JSONB;
  proj JSONB;
  proj_slug TEXT;
  proj_schema TEXT;
BEGIN
  FOR ws_payload IN SELECT payload FROM harness_shared.harness_registry LOOP
    FOR proj IN SELECT * FROM jsonb_array_elements(COALESCE(ws_payload->'projects', '[]'::jsonb)) LOOP
      proj_slug := proj->>'slug';
      IF proj_slug IS NULL OR proj_slug = '' THEN
        CONTINUE;
      END IF;
      proj_schema := 'harness_' || lower(replace(proj_slug, '-', '_'));
      IF EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE information_schema.schemata.schema_name = proj_schema
      ) THEN
        BEGIN
          EXECUTE format(
            'CREATE OR REPLACE VIEW %I.harness_features AS
               SELECT * FROM harness_shared.harness_features_consolidated
               WHERE harness_slug = %L
               WITH CHECK OPTION',
            proj_schema, proj_slug
          );
        EXCEPTION WHEN OTHERS THEN
          -- View may have been hand-customized or the schema may be in an
          -- unexpected state. Skip rather than fail the whole migration.
          RAISE NOTICE 'see-also: skipping view refresh for %.harness_features (%)', proj_schema, SQLERRM;
        END;
      END IF;
    END LOOP;
  END LOOP;
END$$;

COMMIT;
