-- Migration 029 — make harness_shared.harness_features_consolidated the
-- canonical store for features (Phase 1 of un-hardcode). Today the table
-- is a trigger-mirrored copy of per-harness `harness_features` tables;
-- writers pump into per-harness, the trigger fans out into consolidated.
-- After this migration, writers should target consolidated directly.
--
-- This migration is non-destructive: it adds the missing column
-- (deprecation_reason) and renames-via-comment so callers know it's
-- canonical. The per-harness tables remain — we drop them in a later
-- migration once the codebase stops reading them.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS deprecation_reason TEXT;

-- Update the trigger function to also propagate deprecation_reason. Without
-- this, today's trigger leaves the column NULL even when the per-harness
-- row has it set.
CREATE OR REPLACE FUNCTION harness_shared.sync_features_consolidated()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    RETURN OLD;
  END IF;
  INSERT INTO harness_shared.harness_features_consolidated (
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at,
    deprecation_reason
  ) VALUES (
    NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary, NEW.status,
    NEW.attempts, NEW.claims, NEW.notes, NEW.metadata, NEW.kind, NEW.project_id,
    NEW.expected_cost_cents, NEW.tags, NEW.needs_human_review, NEW.ts,
    NEW.created_ts, NEW.updated_ts, NEW.parent_id, NEW.goal_id,
    NEW.taken_by, NEW.taken_at, NEW.expires_at,
    NEW.deprecation_reason
  )
  ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
    title               = EXCLUDED.title,
    summary             = EXCLUDED.summary,
    status              = EXCLUDED.status,
    attempts            = EXCLUDED.attempts,
    claims              = EXCLUDED.claims,
    notes               = EXCLUDED.notes,
    metadata            = EXCLUDED.metadata,
    kind                = EXCLUDED.kind,
    project_id          = EXCLUDED.project_id,
    expected_cost_cents = EXCLUDED.expected_cost_cents,
    tags                = EXCLUDED.tags,
    needs_human_review  = EXCLUDED.needs_human_review,
    ts                  = EXCLUDED.ts,
    created_ts          = EXCLUDED.created_ts,
    updated_ts          = EXCLUDED.updated_ts,
    parent_id           = EXCLUDED.parent_id,
    goal_id             = EXCLUDED.goal_id,
    taken_by            = EXCLUDED.taken_by,
    taken_at            = EXCLUDED.taken_at,
    expires_at          = EXCLUDED.expires_at,
    deprecation_reason  = EXCLUDED.deprecation_reason;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE harness_shared.harness_features_consolidated IS
  'Canonical store for harness features. (Migration 029) Was a trigger-mirrored copy of per-harness harness_features.<schema>.harness_features tables; the per-harness tables remain temporarily as the trigger sources but writers should target this table directly. Per-harness tables drop in a later migration once unread.';

-- Backfill: ensure deprecation_reason from per-harness tables flows into
-- consolidated. Re-fires the trigger by touching every row with a no-op
-- update of updated_ts. (UPDATE … SET col = col is optimized out by PG;
-- needs an actual change.)
DO $$
DECLARE
  s TEXT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%'
       AND schema_name <> 'harness_shared'
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE %I.harness_features SET updated_ts = updated_ts WHERE deprecation_reason IS NOT NULL',
        s
      );
    EXCEPTION WHEN OTHERS THEN
      -- Empty schemas / missing harness_features tables — skip silently.
    END;
  END LOOP;
END $$;

COMMIT;
