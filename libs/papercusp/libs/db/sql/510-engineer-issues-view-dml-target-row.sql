-- 510-engineer-issues-view-dml-target-row.sql — EI-7490
--
-- Migration 503 stopped duplicate issue ids from crashing `engineer_issues`
-- view UPDATEs by deleting duplicate physical rows before every UPDATE. That
-- was safe for the original corrupt empty-slug twin rows, but live federation
-- can also introduce semantically different remote issue rows with the same
-- EI-<n> id as a local row. In that case, "collapse all but one" is data loss.
--
-- Root cause of the recurring duplicate-key throw:
--   * `engineer_issues` is a view over `work_items`.
--   * An UPDATE through the view fires once per matched view row.
--   * The trigger recomputed `harness_slug` from NEW.scope on every UPDATE.
--   * For an unchanged operator-scoped row stored with the legacy physical slug
--     `''`, a harmless payload/status update rewrote it to
--     `operator:<workspace>`, colliding with an existing local row's
--     `(harness_slug, feature_id)` primary key.
--
-- Durable fix:
--   * Expose the base row's physical `harness_slug` as a trailing view column
--     (`base_harness_slug`) for trigger identity only.
--   * Preserve the existing physical harness_slug unless scope actually changes.
--   * UPDATE/DELETE only the physical row represented by OLD, never every row
--     sharing the logical issue id.
--
-- CREATE OR REPLACE VIEW / FUNCTION only; no top-level BEGIN/COMMIT.

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
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');

CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_slug text; v_ei jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = OLD.workspace_id
       AND harness_slug = OLD.base_harness_slug
       AND feature_id = OLD.issue_id
       AND item_kind = OLD.kind;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.scope IS NOT DISTINCT FROM OLD.scope THEN
    v_slug := OLD.base_harness_slug;
  ELSE
    v_slug := CASE WHEN COALESCE(NEW.scope, 'operator') LIKE 'harness:%'
                   THEN substr(NEW.scope, 9)
                   ELSE 'operator:' || COALESCE(NULLIF(NEW.workspace_id, ''), 'default') END;
  END IF;

  v_ei := jsonb_strip_nulls(jsonb_build_object(
     'scope', NEW.scope, 'severity', NEW.severity, 'source', NEW.source,
     'found_during', NEW.found_during, 'linked_feature_id', NEW.linked_feature_id,
     'created_by', NEW.created_by, 'assigned_by', NEW.assigned_by, 'signal_origin', NEW.signal_origin));
  IF TG_OP = 'INSERT' THEN
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at,
       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,
       rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload,
       terminal_owner, terminal_completion_ref, last_progress_at)
    VALUES
      (COALESCE(NEW.workspace_id, 'default'), v_slug, NEW.issue_id, NEW.title,
       COALESCE(NEW.body, ''), COALESCE(NEW.state, 'open'), NEW.assignee, NEW.assigned_at,
       CASE WHEN NEW.assigned_at IS NOT NULL THEN NEW.assigned_at + INTERVAL '7 days' ELSE NULL END,
       COALESCE(NEW.kind, 'bug'), COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
       NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       COALESCE(NEW.payload, '{}'::jsonb) || jsonb_build_object('_ei', v_ei),
       NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at);
    RETURN NEW;
  ELSE
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      last_released_by = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN OLD.assignee ELSE last_released_by END,
      last_released_at = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN now() ELSE last_released_at END,
      last_progress_at = NEW.last_progress_at,
      item_kind = COALESCE(NEW.kind, 'bug'), origin = COALESCE(NEW.origin, 'local'),
      author_pubkey = NEW.author_pubkey, assignee_rank = NEW.assignee_rank,
      rank_writer = NEW.rank_writer, rank_updated_at = NEW.rank_updated_at,
      fed_ts = NEW.fed_ts, fed_hlc = NEW.fed_hlc,
      created_ts = (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
      updated_ts = (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
      payload = (COALESCE(NEW.payload, '{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei),
      terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref
    WHERE workspace_id = OLD.workspace_id
      AND harness_slug = OLD.base_harness_slug
      AND feature_id = OLD.issue_id
      AND item_kind = OLD.kind;
    RETURN NEW;
  END IF;
END;
$function$;
