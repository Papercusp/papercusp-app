-- 012-trigger-workspace-id.sql
--
-- Update the harness_features_consolidated trigger to propagate
-- workspace_id from per-harness writes. Per 001-shared.sql, the trigger
-- mirrors per-harness `harness_<slug>.harness_features` rows into the
-- consolidated table; that path doesn't carry workspace_id today.
--
-- We resolve the workspace_id via a lookup against harness_shared.projects
-- (slug=NEW.harness_slug). If projects has been backfilled, this gives
-- the right value; if not, the trigger falls through with the column's
-- DEFAULT (still '' under 009; '' rejected under 010's CHECK).
--
-- Run this AFTER 009 and the backfill, before 010.

CREATE OR REPLACE FUNCTION harness_shared.sync_features_consolidated()
RETURNS TRIGGER AS $$
DECLARE
  ws TEXT;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    RETURN OLD;
  END IF;

  -- Resolve workspace from projects.
  SELECT workspace_id INTO ws
    FROM harness_shared.projects
   WHERE slug = NEW.harness_slug
   LIMIT 1;
  IF ws IS NULL OR ws = '' THEN
    -- Should not happen post-backfill; raise so we notice.
    RAISE WARNING 'features_consolidated trigger: no workspace_id for harness % (consolidated row will use empty string until next backfill)', NEW.harness_slug;
    ws := '';
  END IF;

  INSERT INTO harness_shared.harness_features_consolidated (
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at,
    workspace_id
  ) VALUES (
    NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary, NEW.status, NEW.attempts,
    NEW.claims, NEW.notes, NEW.metadata, NEW.kind, NEW.project_id, NEW.expected_cost_cents,
    NEW.tags, NEW.needs_human_review, NEW.ts, NEW.created_ts, NEW.updated_ts,
    NEW.parent_id, NEW.goal_id, NEW.taken_by, NEW.taken_at, NEW.expires_at,
    ws
  )
  ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
    title = EXCLUDED.title, summary = EXCLUDED.summary, status = EXCLUDED.status,
    attempts = EXCLUDED.attempts, claims = EXCLUDED.claims, notes = EXCLUDED.notes,
    metadata = EXCLUDED.metadata, kind = EXCLUDED.kind, project_id = EXCLUDED.project_id,
    expected_cost_cents = EXCLUDED.expected_cost_cents, tags = EXCLUDED.tags,
    needs_human_review = EXCLUDED.needs_human_review, ts = EXCLUDED.ts,
    created_ts = EXCLUDED.created_ts, updated_ts = EXCLUDED.updated_ts,
    parent_id = EXCLUDED.parent_id, goal_id = EXCLUDED.goal_id,
    taken_by = EXCLUDED.taken_by, taken_at = EXCLUDED.taken_at,
    expires_at = EXCLUDED.expires_at,
    workspace_id = EXCLUDED.workspace_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
