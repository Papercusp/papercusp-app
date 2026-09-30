-- 521-engineer-issues-view-remote-skip-return-null.sql
--
-- EI-7833: engineer_issues_view_dml() (the INSTEAD OF trigger backing the
-- harness_shared.engineer_issues compat view over work_items[kind in bug/change/task])
-- SILENTLY no-ops UPDATE/DELETE on a remote-origin row but RETURNs NEW/OLD — so a LOCAL
-- issue-tool write (claimIssue / setIssueState / releaseIssue) against a FEDERATED item
-- gets back an OPTIMISTIC row (fresh now() taken_at/updated_at, mutated assignee/status/
-- terminal_owner) while harness_shared.work_items is NEVER written. Callers treat the
-- non-null RETURNING row as success => the MCP tools (work_items:claim/complete/set_state)
-- report ok:true with a resolved/claimed item, but every reader (work_items:get, claim_next,
-- coord:orient, dev:pg_query) reads the base row and still sees todo/terminal_owner=null.
-- => permanent "false-resolved": the item resurfaces forever (WI-1994 alone burned 3+ sessions).
--
-- The remote-skip GUARD itself is correct — a federated row is owned by its authoring peer's
-- core and its canonical state arrives via the hyperbee->PG projector
-- (packages/operator-core/lib/sync/hyperbee/projections/engineer-issues.ts), which writes the
-- work_items BASE table DIRECTLY (INSERT ... ON CONFLICT), NOT through this view. So this
-- trigger only gates the operator's LOCAL view callers, and RETURN NULL here cannot affect
-- federation inbound.
--
-- FIX: on the remote-origin skip branch RETURN NULL instead of NEW/OLD. For an INSTEAD OF
-- trigger, RETURN NULL reports 0 rows affected and an empty RETURNING, so claimIssue /
-- setIssueState / releaseIssue correctly return null and the tools surface an HONEST failure
-- ("remote-authored — not claimable/closeable locally; it closes when its author node
-- resolves it") instead of the silent false-success.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Only the remote-skip branch changes; the rest of
-- the function is reproduced verbatim from the live definition.

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
    -- EI-7833: a federated (origin='remote') row is owned by its authoring peer's core;
    -- the operator's LOCAL view writes must NOT clobber it (the hyperbee->PG projector owns
    -- the base row under LWW). RETURN NULL — NOT NEW/OLD — so the INSTEAD OF trigger reports
    -- 0 rows affected + empty RETURNING, making the caller see an honest no-op instead of a
    -- silent false-success. (Previously: RETURN OLD for DELETE, RETURN NEW for UPDATE, both
    -- of which handed callers an optimistic row while the base table was never written.)
    RETURN NULL;
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
