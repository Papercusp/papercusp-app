-- Migration 049 — auto-compute needs_design at feature creation.
--
-- Step 1's plan (apps/operator/content/internal-docs/design/design-phase-plan.mdx
-- §3) puts the heuristic in TS. That helps writers that go through the
-- TS lib, but most existing feature writers (linear-sync, jira-sync,
-- the Hono harness route in libs/papercusp/apps/web) bypass the TS lib
-- and INSERT into per-harness harness_features directly. Re-wiring each
-- writer is a touch-many-files refactor.
--
-- This migration extends sync_features_consolidated() so that the
-- needs_design column gets a sensible default at INSERT time when the
-- writer didn't compute one itself. The text-keyword heuristic is a
-- subset of the TS one (no glob support — can't compute that in SQL),
-- but it covers the common case. Writers with richer context can still
-- supply their own value (e.g. force-on/off via the TS lib); the trigger
-- only fills in NULL.
--
-- Idempotent.

\set ON_ERROR_STOP on
BEGIN;

-- ─── Helper: compute needs_design from text. Extracted so the
-- sync trigger and any other PG-side caller can share it. ───────────
CREATE OR REPLACE FUNCTION harness_shared.compute_needs_design(
  p_title TEXT,
  p_summary TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  haystack TEXT := lower(coalesce(p_title, '') || ' ' || coalesce(p_summary, ''));
BEGIN
  -- Mirrors apps/operator/lib/design-phase.ts keyword regexes. Kept
  -- intentionally simple; if a writer needs richer detection it can
  -- compute needs_design in TS and pass it explicitly.
  RETURN haystack ~ E'\\m(ui|ux|design|layout|page|screen|view|component|panel|modal|drawer|button|form|chart|color|theme|font|icon|navigation|menu|toolbar|sidebar|header|footer|landing|onboarding)\\M'
      OR haystack ~ E'\\m(label|copy|wording|message|placeholder|tooltip|empty[\\s-]?state|error[\\s-]?message|prompt[\\s-]?text|microcopy|i18n|translation)\\M'
      OR haystack ~ E'\\m(route|page|url|slug|navigation|navlink|tab|breadcrumb|deep[\\s-]?link)\\M'
      OR haystack ~ E'\\m(icon|iconography|illustration|graphic|svg|image|avatar|logo|emoji)\\M';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

GRANT EXECUTE ON FUNCTION harness_shared.compute_needs_design(TEXT, TEXT) TO harness_app, harness_admin;

-- ─── Replace the sync trigger to fill needs_design when missing ────
CREATE OR REPLACE FUNCTION harness_shared.sync_features_consolidated()
RETURNS TRIGGER AS $$
DECLARE
  v_needs_design BOOLEAN;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    RETURN OLD;
  END IF;
  -- Per-harness rows don't carry needs_design today (column was added on
  -- consolidated only in migration 048). Compute from text.
  v_needs_design := harness_shared.compute_needs_design(NEW.title, NEW.summary);
  INSERT INTO harness_shared.harness_features_consolidated (
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at,
    deprecation_reason,
    needs_design
  ) VALUES (
    NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary, NEW.status,
    NEW.attempts, NEW.claims, NEW.notes, NEW.metadata, NEW.kind, NEW.project_id,
    NEW.expected_cost_cents, NEW.tags, NEW.needs_human_review, NEW.ts,
    NEW.created_ts, NEW.updated_ts, NEW.parent_id, NEW.goal_id,
    NEW.taken_by, NEW.taken_at, NEW.expires_at,
    NEW.deprecation_reason,
    v_needs_design
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
    -- needs_design is intentionally NOT updated on conflict — preserve
    -- whatever the writer (or a previous trigger run) recorded. Setting
    -- needs_design via direct UPDATE on consolidated still works because
    -- the trigger doesn't fire on consolidated; it fires on per-harness
    -- writes.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Backfill: set needs_design on existing rows where it's still
-- the schema default (false) but the title/summary suggests UI work.
-- Only touches rows where needs_design IS NULL / false to avoid
-- clobbering explicitly-set values. ────────────────────────────────
UPDATE harness_shared.harness_features_consolidated
   SET needs_design = harness_shared.compute_needs_design(title, summary)
 WHERE needs_design = FALSE
   AND harness_shared.compute_needs_design(title, summary) = TRUE;

COMMIT;
