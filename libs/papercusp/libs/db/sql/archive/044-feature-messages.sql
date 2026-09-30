-- Migration 044 — feature-to-feature messaging.
--
-- Phase 3 of the agent-memory plan. Adds two nullable columns to every
-- existing per-harness `messages` table:
--   from_feature_id TEXT NULL  — the feature whose worker authored the message
--   to_feature_id   TEXT NULL  — the feature this message is addressed to
--
-- Both nullable so existing harness-to-harness messages keep working
-- with both fields NULL. Feature-to-feature messages set both. Mixed
-- modes (one set, one null) are allowed for "from a feature, addressed
-- to a harness role" and vice versa.
--
-- The "dismiss" UX surfaces via the existing `status='archived'`
-- transition — no new status enum value needed; messages:feature_dismiss
-- moves a message to 'archived'.

BEGIN;

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
      ) AND EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = proj_schema AND table_name = 'messages'
      ) THEN
        BEGIN
          EXECUTE format(
            'ALTER TABLE %I.messages
               ADD COLUMN IF NOT EXISTS from_feature_id TEXT,
               ADD COLUMN IF NOT EXISTS to_feature_id   TEXT',
            proj_schema
          );
          -- Index on (to_feature_id, status) to support
          -- `messages:feature_inbox` lookups: "pending messages for F-X".
          EXECUTE format(
            'CREATE INDEX IF NOT EXISTS messages_to_feature_idx
               ON %I.messages(to_feature_id, status)
               WHERE to_feature_id IS NOT NULL',
            proj_schema
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'feature-messages: skipping %.messages (%)', proj_schema, SQLERRM;
        END;
      END IF;
    END LOOP;
  END LOOP;
END$$;

COMMIT;
