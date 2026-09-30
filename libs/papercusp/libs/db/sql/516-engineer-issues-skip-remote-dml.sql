-- 516-engineer-issues-skip-remote-dml.sql — EI-7490 final boundary
--
-- Local `engineer_issues` compat UPDATE/DELETE statements can match remote
-- federated issue rows when a peer reuses a local EI-<n> id. Those rows should
-- not be mutated by the local issue surface at all: they are replicated facts,
-- not local work items. If the physical row represented by OLD is currently
-- origin='remote', make the trigger a no-op for UPDATE/DELETE. The local twin
-- still updates, duplicate-id updates stop throwing, and remote rows are not
-- silently reclassified as local.

CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_slug text; v_ei jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1
      FROM harness_shared.work_items cur
     WHERE cur.workspace_id = OLD.workspace_id
       AND cur.harness_slug = OLD.base_harness_slug
       AND cur.feature_id = OLD.issue_id
       AND cur.item_kind = OLD.kind
       AND cur.origin = 'remote'
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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
      item_kind = COALESCE(NEW.kind, 'bug'),
      origin = COALESCE(NEW.origin, 'local'),
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
