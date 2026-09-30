-- 374-work-items-unify-base-table.sql
--
-- P-010 work-item unification (work-item-deps-and-readiness-2026-06-22): make
-- harness_shared.work_items the TRUE base table — harness_features_consolidated
-- (feature|research-task|chunk) + engineer_issues (bug|change|task) collapse into
-- one row-space keyed by item_kind. Blueprint + decisions D-U1..D-U6:
-- apps/operator/docs/work-items-unification-cutover-2026-06-22.md.
--
-- IDEMPOTENT by construction: the structural cutover runs ONLY while work_items is
-- still the union VIEW; on an already-unified DB the guard skips it and the rest is
-- CREATE OR REPLACE / DISABLE-if-enabled / ON CONFLICT DO NOTHING — a true no-op.
-- (NOTE: an earlier `_DRAFT-` copy of this already applied to the shared dev DB out
-- of band; this numbered, idempotent version converges fresh DBs + that DB safely.)

\set ON_ERROR_STOP on
BEGIN;

-- ── Structural cutover (first-unification only) ──────────────────────────────
DO $cut$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'work_items'
      AND relnamespace = 'harness_shared'::regnamespace AND relkind = 'v'
  ) THEN
    -- 1. Drop the union view; promote the feature table to the base.
    DROP VIEW harness_shared.work_items CASCADE;
    ALTER TABLE harness_shared.harness_features_consolidated RENAME TO work_items;
    ALTER TABLE harness_shared.work_items
      RENAME CONSTRAINT harness_features_consolidated_pkey TO work_items_pkey;

    -- 2. Backfill engineer_issues -> work_items (D-U1 sentinel ''; D-U2 issue-only
    --    columns into payload->'_ei'). Triggers OFF: a data move must not
    --    notify-storm or re-enqueue federation.
    ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       taken_by, taken_at, expires_at, item_kind, origin, author_pubkey,
       assignee_rank, rank_writer, rank_updated_at, fed_ts, fed_hlc,
       ts, created_ts, updated_ts, payload)
    SELECT
      ei.workspace_id,
      CASE WHEN ei.scope LIKE 'harness:%' THEN substr(ei.scope, 9) ELSE '' END,
      ei.issue_id, ei.title, ei.body, ei.state,
      ei.assignee, ei.assigned_at,
      CASE WHEN ei.assigned_at IS NOT NULL THEN ei.assigned_at + INTERVAL '7 days' ELSE NULL END,
      COALESCE(ei.kind, 'bug'), COALESCE(ei.origin, 'local'), ei.author_pubkey,
      ei.assignee_rank, ei.rank_writer, ei.rank_updated_at, ei.fed_ts, ei.fed_hlc,
      (extract(epoch FROM ei.updated_at) * 1000)::bigint,
      (extract(epoch FROM ei.created_at) * 1000)::bigint,
      (extract(epoch FROM ei.updated_at) * 1000)::bigint,
      COALESCE(ei.payload, '{}'::jsonb) || jsonb_build_object('_ei', jsonb_strip_nulls(jsonb_build_object(
         'scope', ei.scope, 'severity', ei.severity, 'source', ei.source,
         'found_during', ei.found_during, 'linked_feature_id', ei.linked_feature_id,
         'created_by', ei.created_by, 'assigned_by', ei.assigned_by,
         'signal_origin', ei.signal_origin)))
    FROM harness_shared.engineer_issues ei
    ON CONFLICT (harness_slug, feature_id) DO NOTHING;
    ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

    -- 3. Retire the issue table (its federation/updated_at triggers drop with it;
    --    federation is re-unified in the follow-on federation migration).
    DROP TABLE harness_shared.engineer_issues CASCADE;
  END IF;
END $cut$;

-- ── One RLS posture (D-U6 / F7): no row-level RLS (idempotent) ────────────────
ALTER TABLE harness_shared.work_items DISABLE ROW LEVEL SECURITY;
DO $rls$
DECLARE p record;
BEGIN
  FOR p IN SELECT polname FROM pg_policy WHERE polrelid = 'harness_shared.work_items'::regclass LOOP
    EXECUTE format('DROP POLICY %I ON harness_shared.work_items', p.polname);
  END LOOP;
END $rls$;

-- ── Compat views + INSTEAD OF DML (CREATE OR REPLACE — idempotent) ───────────
CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
  SELECT * FROM harness_shared.work_items
  WHERE item_kind NOT IN ('bug', 'change', 'task')
  WITH CASCADED CHECK OPTION;

-- engineer_issues compat view (CREATE OR REPLACE — no DROP, so no dependent-drop
-- wedge on the live re-apply; shape matches the already-applied copy).
CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT
    workspace_id,
    feature_id AS issue_id,
    COALESCE(payload->'_ei'->>'scope',
             CASE WHEN harness_slug = '' THEN 'operator' ELSE 'harness:' || harness_slug END) AS scope,
    title,
    COALESCE(summary, '') AS body,
    COALESCE(payload->'_ei'->>'severity', 'minor') AS severity,
    COALESCE(payload->'_ei'->>'source', 'engineer') AS source,
    status AS state,
    taken_by AS assignee,
    payload->'_ei'->>'found_during' AS found_during,
    payload->'_ei'->>'linked_feature_id' AS linked_feature_id,
    payload->'_ei'->>'created_by' AS created_by,
    to_timestamp(created_ts / 1000.0) AS created_at,
    to_timestamp(updated_ts / 1000.0) AS updated_at,
    author_pubkey, origin, _search,
    item_kind AS kind,
    (payload - '_ei') AS payload,
    payload->'_ei'->>'assigned_by' AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank, rank_writer, rank_updated_at, fed_ts,
    COALESCE(payload->'_ei'->>'signal_origin', 'local') AS signal_origin,
    fed_hlc
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');

CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
RETURNS trigger LANGUAGE plpgsql AS $ei_dml$
DECLARE v_slug text; v_ei jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
       AND item_kind IN ('bug', 'change', 'task');
    RETURN OLD;
  END IF;
  v_slug := CASE WHEN COALESCE(NEW.scope, 'operator') LIKE 'harness:%' THEN substr(NEW.scope, 9) ELSE '' END;
  v_ei := jsonb_strip_nulls(jsonb_build_object(
     'scope', NEW.scope, 'severity', NEW.severity, 'source', NEW.source,
     'found_during', NEW.found_during, 'linked_feature_id', NEW.linked_feature_id,
     'created_by', NEW.created_by, 'assigned_by', NEW.assigned_by, 'signal_origin', NEW.signal_origin));
  IF TG_OP = 'INSERT' THEN
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at,
       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,
       rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload)
    VALUES
      (COALESCE(NEW.workspace_id, 'default'), v_slug, NEW.issue_id, NEW.title,
       COALESCE(NEW.body, ''), COALESCE(NEW.state, 'open'), NEW.assignee, NEW.assigned_at,
       CASE WHEN NEW.assigned_at IS NOT NULL THEN NEW.assigned_at + INTERVAL '7 days' ELSE NULL END,
       COALESCE(NEW.kind, 'bug'), COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
       NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       COALESCE(NEW.payload, '{}'::jsonb) || jsonb_build_object('_ei', v_ei));
    RETURN NEW;
  ELSE
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      item_kind = COALESCE(NEW.kind, 'bug'), origin = COALESCE(NEW.origin, 'local'),
      author_pubkey = NEW.author_pubkey, assignee_rank = NEW.assignee_rank,
      rank_writer = NEW.rank_writer, rank_updated_at = NEW.rank_updated_at,
      fed_ts = NEW.fed_ts, fed_hlc = NEW.fed_hlc,
      updated_ts = (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
      payload = (COALESCE(NEW.payload, '{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei)
    WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
      AND item_kind IN ('bug', 'change', 'task');
    RETURN NEW;
  END IF;
END;
$ei_dml$;

DROP TRIGGER IF EXISTS engineer_issues_view_dml_trg ON harness_shared.engineer_issues;
CREATE TRIGGER engineer_issues_view_dml_trg
  INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.engineer_issues
  FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();

-- ── Grants (idempotent) ──────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.work_items TO harness_app;
GRANT SELECT ON harness_shared.work_items TO harness_zero;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_features_consolidated TO harness_app;
GRANT SELECT ON harness_shared.harness_features_consolidated TO harness_zero;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.engineer_issues TO harness_app;
GRANT SELECT ON harness_shared.engineer_issues TO harness_zero;

COMMIT;
