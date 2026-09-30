-- Migration 159 — work_items becomes the TRUE cross-kind surface: a UNION ALL
-- view over BOTH per-kind tables, with INSTEAD OF DML routing writes by kind.
--
-- Plan: unify-work-items-2026-06-04 (D-010=(b) — per-kind tables unified by a
-- work_items VIEW with INSTEAD OF triggers; the "kind-views" half of the
-- deferred tail, opened by agent-briefs-2026-06-05 Brief 14).
--
-- Before this migration the view was SELECT * over harness_features_consolidated
-- only (mig 136, recreated in 155): the issue family (engineer_issues — kinds
-- bug | change | task) was invisible to SQL-level cross-kind reads, and the
-- cross-kind unification lived only in code (work-items.ts). Now:
--
--   • The view keeps the EXACT 47-column shape + order of the prior view (the
--     consumer contract: the DBOS frontier reads feature_id/status/feature_order/
--     metadata/origin/audit_verdict + filters item_kind='feature'; export-state
--     COPYies SELECT * WHERE harness_slug=… AND item_kind<>'feature'). Feature
--     rows are bit-identical to before.
--   • Issue-family rows are mapped INTO that column space: issue_id→feature_id,
--     body→summary, state→status, assignee→taken_by, kind→item_kind,
--     scope 'harness:<slug>'→harness_slug (operator scope → NULL, so per-harness
--     filters naturally exclude operator-scoped items), timestamps → epoch ms.
--     Feature-only columns are typed NULLs/defaults.
--   • INSTEAD OF INSERT/UPDATE/DELETE routes by kind: bug|change|task →
--     engineer_issues; everything else → harness_features_consolidated. This is
--     the D-010(b) write contract — and it makes export-state's restore-side
--     `COPY INTO work_items` workable (PG supports COPY into a view with an
--     INSTEAD OF INSERT trigger), un-blocking the su-4b6ce P-005 follow-on.
--
-- Effects on existing consumers (audited 2026-06-05):
--   • DBOS frontier (orchestrator-loop.ts readFrontierFeatures): filters
--     item_kind='feature' + harness_slug — issue rows excluded; feature rows
--     unchanged. No behavior change.
--   • export-state (shared-table-filters 'work_items', item_kind<>'feature'):
--     now ALSO captures a harness's issue-family rows — previously silently
--     lost (engineer_issues has no capture entry of its own). Net new data in
--     the snapshot CSV; restore's empty-CSV skip is unaffected.
--   • The per-kind tables stay the write-path for the engine (work-items.ts
--     dispatches directly); the triggers serve SQL-level writers.
--
-- The base-table RENAME (hfc→work_items_feature, engineer_issues→
-- work_items_issue — deferred tail #4) is NOT in this migration: it breaks the
-- green :3070 checkout (old code, same DB, ON CONFLICT can't bridge through
-- compat views) + the CDC's TG_TABLE_NAME federation keying — it needs the
-- supervised quiet-window pass the plan always specified.
--
-- Idempotent: DROP VIEW IF EXISTS + CREATE; CREATE OR REPLACE FUNCTION;
-- DROP TRIGGER IF EXISTS + CREATE. Composes onto 000-baseline + 136/142/152/155.

\set ON_ERROR_STOP on
BEGIN;

-- 155 audited: nothing depends on the view object itself; recreate is safe.
DROP VIEW IF EXISTS harness_shared.work_items;

CREATE VIEW harness_shared.work_items AS
  SELECT
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at,
    expires_at, workspace_id, _search, deprecation_reason, see_also,
    needs_design, design_status, design_spec_id, discarded_design_work,
    completion_ref, created_by_github_user_id, working_users, worked_by_history,
    wave, verified_done_at_remote_ts, verifier_last_error,
    verifier_last_checked_at, source_plan_slug, source_plan_item_ids,
    feature_order, author_pubkey, origin, audit_verdict, audit_reasons,
    audited_at, item_kind, payload
  FROM harness_shared.harness_features_consolidated
  UNION ALL
  SELECT
    CASE WHEN ei.scope LIKE 'harness:%' THEN substr(ei.scope, 9) ELSE NULL END, -- harness_slug
    ei.issue_id,                                   -- feature_id (the work-item id)
    ei.title,
    ei.body,                                       -- summary
    ei.state,                                      -- status (open|resolved|closed)
    NULL::bigint,                                  -- attempts
    NULL::text,                                    -- claims
    NULL::text,                                    -- notes
    NULL::jsonb,                                   -- metadata
    NULL::text,                                    -- kind (legacy feature SUB-CATEGORY — not the discriminator)
    NULL::text,                                    -- project_id
    NULL::bigint,                                  -- expected_cost_cents
    NULL::jsonb,                                   -- tags
    FALSE,                                         -- needs_human_review
    (extract(epoch FROM ei.updated_at) * 1000)::bigint, -- ts
    (extract(epoch FROM ei.created_at) * 1000)::bigint, -- created_ts
    (extract(epoch FROM ei.updated_at) * 1000)::bigint, -- updated_ts
    NULL::text,                                    -- parent_id
    NULL::text,                                    -- goal_id
    ei.assignee,                                   -- taken_by
    ei.assigned_at,                                -- taken_at
    CASE WHEN ei.assigned_at IS NOT NULL THEN ei.assigned_at + INTERVAL '7 days' ELSE NULL END, -- expires_at
    ei.workspace_id,
    ei._search,
    NULL::text,                                    -- deprecation_reason
    NULL::text[],                                  -- see_also
    FALSE,                                         -- needs_design
    NULL::text,                                    -- design_status
    NULL::text,                                    -- design_spec_id
    FALSE,                                         -- discarded_design_work
    NULL::jsonb,                                   -- completion_ref
    NULL::bigint,                                  -- created_by_github_user_id
    NULL::bigint[],                                -- working_users
    NULL::jsonb,                                   -- worked_by_history
    NULL::text,                                    -- wave
    NULL::timestamptz,                             -- verified_done_at_remote_ts
    NULL::text,                                    -- verifier_last_error
    NULL::timestamptz,                             -- verifier_last_checked_at
    NULL::text,                                    -- source_plan_slug
    NULL::text[],                                  -- source_plan_item_ids
    NULL::integer,                                 -- feature_order
    ei.author_pubkey,
    ei.origin,
    NULL::text,                                    -- audit_verdict
    NULL::text,                                    -- audit_reasons
    NULL::timestamptz,                             -- audited_at
    COALESCE(ei.kind, 'bug'),                      -- item_kind (the discriminator)
    ei.payload
  FROM harness_shared.engineer_issues ei;

COMMENT ON VIEW harness_shared.work_items IS
  'The canonical cross-kind work-item surface (unify-work-items D-010=(b)): UNION ALL of the per-kind tables — harness_features_consolidated (feature|research-task|chunk) + engineer_issues (bug|change|task) — in the feature column space. Discriminator = item_kind; kind-specific data = payload. Writes route by kind via INSTEAD OF triggers (work_items_view_dml); the engine (work-items.ts) writes the base tables directly.';

-- ── INSTEAD OF DML routing (the D-010(b) write contract) ─────────────────────
CREATE OR REPLACE FUNCTION harness_shared.work_items_view_dml()
RETURNS trigger
LANGUAGE plpgsql
AS $work_items_dml$
DECLARE
  v_is_issue boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_is_issue := NEW.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue THEN
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, body, state, assignee, assigned_at,
         kind, payload, origin, author_pubkey, created_at, updated_at)
      VALUES
        (COALESCE(NEW.workspace_id, 'default'),
         NEW.feature_id,
         CASE WHEN NEW.harness_slug IS NULL OR NEW.harness_slug = ''
              THEN 'operator' ELSE 'harness:' || NEW.harness_slug END,
         NEW.title,
         COALESCE(NEW.summary, ''),
         COALESCE(NEW.status, 'open'),
         NEW.taken_by,
         NEW.taken_at,
         NEW.item_kind,
         NEW.payload,
         COALESCE(NEW.origin, 'local'),
         NEW.author_pubkey,
         COALESCE(to_timestamp(NEW.created_ts / 1000.0), now()),
         COALESCE(to_timestamp(NEW.updated_ts / 1000.0), now()));
    ELSE
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, title, summary, status, attempts, claims, notes,
         metadata, kind, parent_id, goal_id, taken_by, taken_at,
         needs_design, needs_human_review, item_kind, payload,
         ts, created_ts, updated_ts, origin, author_pubkey,
         source_plan_slug, source_plan_item_ids, feature_order, wave)
      VALUES
        (NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary,
         COALESCE(NEW.status, 'todo'), COALESCE(NEW.attempts, 0), NEW.claims, NEW.notes,
         NEW.metadata, NEW.kind, NEW.parent_id, NEW.goal_id, NEW.taken_by, NEW.taken_at,
         COALESCE(NEW.needs_design, FALSE), COALESCE(NEW.needs_human_review, FALSE),
         COALESCE(NEW.item_kind, 'feature'), NEW.payload,
         COALESCE(NEW.ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.created_ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.updated_ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
         NEW.source_plan_slug, NEW.source_plan_item_ids, NEW.feature_order, NEW.wave);
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Route by the row's CURRENT family (OLD.item_kind): reclassification across
    -- families (bug→feature) is a cross-table move — do it via the engine, not
    -- a view UPDATE (the trigger refuses silently-destructive moves).
    v_is_issue := OLD.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue AND NEW.item_kind NOT IN ('bug', 'change', 'task') THEN
      RAISE EXCEPTION 'work_items: cross-family reclassification (% -> %) is a cross-table move — use the work-items engine', OLD.item_kind, NEW.item_kind;
    ELSIF NOT v_is_issue AND NEW.item_kind IN ('bug', 'change', 'task') THEN
      RAISE EXCEPTION 'work_items: cross-family reclassification (% -> %) is a cross-table move — use the work-items engine', OLD.item_kind, NEW.item_kind;
    END IF;
    IF v_is_issue THEN
      UPDATE harness_shared.engineer_issues SET
        title      = NEW.title,
        body       = COALESCE(NEW.summary, ''),
        state      = NEW.status,
        assignee   = NEW.taken_by,
        assigned_at = NEW.taken_at,
        kind       = NEW.item_kind,
        payload    = NEW.payload,
        updated_at = COALESCE(to_timestamp(NEW.updated_ts / 1000.0), now())
      WHERE workspace_id = OLD.workspace_id AND issue_id = OLD.feature_id;
    ELSE
      UPDATE harness_shared.harness_features_consolidated SET
        title = NEW.title, summary = NEW.summary, status = NEW.status,
        attempts = NEW.attempts, claims = NEW.claims, notes = NEW.notes,
        metadata = NEW.metadata, kind = NEW.kind, parent_id = NEW.parent_id,
        goal_id = NEW.goal_id, taken_by = NEW.taken_by, taken_at = NEW.taken_at,
        expires_at = NEW.expires_at, needs_design = NEW.needs_design,
        needs_human_review = NEW.needs_human_review, item_kind = NEW.item_kind,
        payload = NEW.payload, wave = NEW.wave, feature_order = NEW.feature_order,
        source_plan_slug = NEW.source_plan_slug,
        source_plan_item_ids = NEW.source_plan_item_ids,
        ts = COALESCE(NEW.ts, (extract(epoch FROM now()) * 1000)::bigint),
        updated_ts = COALESCE(NEW.updated_ts, (extract(epoch FROM now()) * 1000)::bigint)
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    END IF;
    RETURN NEW;

  ELSE -- DELETE
    v_is_issue := OLD.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue THEN
      DELETE FROM harness_shared.engineer_issues
       WHERE workspace_id = OLD.workspace_id AND issue_id = OLD.feature_id;
    ELSE
      DELETE FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$work_items_dml$;

DROP TRIGGER IF EXISTS work_items_dml_trg ON harness_shared.work_items;
CREATE TRIGGER work_items_dml_trg
  INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.work_items_view_dml();

-- Mirror 155's read grants + the new write contract for the app role.
GRANT SELECT ON harness_shared.work_items TO harness_app;
GRANT SELECT ON harness_shared.work_items TO harness_zero;
GRANT INSERT, UPDATE, DELETE ON harness_shared.work_items TO harness_app;

COMMIT;
