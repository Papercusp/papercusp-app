-- 432-work-item-completion-integrity.sql — completion-integrity gate columns
-- (work-item-completion-integrity-2026-07-01 WI-1403).
--
-- A work_item may reach a TERMINAL state (feature-family: passed|deprecated;
-- issue-family: resolved|closed) only via a transition that records BOTH who
-- did it and what proves it: `terminal_owner` (the claiming principal) and
-- `terminal_completion_ref` (a free-text completion reference — a completion
-- summary, commit sha, coord/plan-item ref, or equivalent evidence string).
-- Enforced in code at the setWorkItemState / setIssueState choke point, not by
-- a DB CHECK (both families' terminal vocab already differ and are enforced
-- app-side; the columns here are pure bookkeeping written alongside the state
-- flip, not a constraint).
--
-- DISTINCT from the pre-unification `completion_ref` jsonb column already on
-- `harness_shared.work_items` (added by archived migrations 080/082, surfaced
-- through the harness_features_consolidated view) — that is the narrow git/PR
-- "dogfood pipeline" concept ({remote,branch,commit_sha,pr_url,...}) verified by
-- a P-016 daemon via `git ls-remote`. This is a general, family-agnostic
-- "who + what proves it" pair; the two are unrelated and must not collide.
--
-- SCHEMA CONTEXT (post work-items-unify-base-table, migration 374):
-- harness_shared.work_items is the TRUE base table; harness_features_consolidated
-- and engineer_issues are compat VIEWS over it (the latter with an INSTEAD OF DML
-- trigger). So the new columns land on the BASE table, and BOTH compat views (+
-- the issue view's INSTEAD OF trigger) must be re-created to surface/persist them:
--   - harness_features_consolidated is `SELECT * FROM work_items WHERE …` — a bare
--     CREATE OR REPLACE re-expands `*` to pick up the two new trailing columns
--     with no other change (additive, so REPLACE is valid).
--   - engineer_issues has an explicit column list (not `SELECT *`) — replaced here
--     with the CURRENT live definition (migration 403) plus the two new columns
--     appended, unchanged otherwise. NOT touching the (unrelated, pre-existing)
--     scope-derivation shape 403 carries — that is a separate concern, tracked
--     independently, out of scope for this gate.
--   - the INSTEAD OF trigger (current live body: migration 388) gets the two new
--     columns threaded through both the INSERT and UPDATE branches so writing the
--     view's terminal_owner/terminal_completion_ref persists to the base table.
--
-- The migration runner wraps each file in its own txn — NO top-level
-- BEGIN;/COMMIT; (lint:migrations, files >= 215).

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS terminal_owner text,
  ADD COLUMN IF NOT EXISTS terminal_completion_ref text;

-- Re-expand `SELECT *` to pick up the two new trailing columns (additive; the
-- view's existing column list/order for everything else is preserved).
CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
  SELECT * FROM harness_shared.work_items
  WHERE item_kind NOT IN ('bug', 'change', 'task')
  WITH CASCADED CHECK OPTION;

-- engineer_issues compat view: current live shape (migration 403) + the two new
-- columns appended at the end.
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
    COALESCE(payload->'_ei'->>'signal_origin', 'organic') AS signal_origin,
    fed_hlc,
    terminal_owner,
    terminal_completion_ref
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');

-- INSTEAD OF DML trigger: current live body (migration 388) + terminal_owner /
-- terminal_completion_ref threaded through the INSERT + UPDATE branches.
CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_slug text; v_ei jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
       AND item_kind IN ('bug', 'change', 'task');
    RETURN OLD;
  END IF;
  v_slug := CASE WHEN COALESCE(NEW.scope, 'operator') LIKE 'harness:%'
                 THEN substr(NEW.scope, 9)
                 ELSE 'operator:' || COALESCE(NULLIF(NEW.workspace_id, ''), 'default') END;
  v_ei := jsonb_strip_nulls(jsonb_build_object(
     'scope', NEW.scope, 'severity', NEW.severity, 'source', NEW.source,
     'found_during', NEW.found_during, 'linked_feature_id', NEW.linked_feature_id,
     'created_by', NEW.created_by, 'assigned_by', NEW.assigned_by, 'signal_origin', NEW.signal_origin));
  IF TG_OP = 'INSERT' THEN
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at,
       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,
       rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload,
       terminal_owner, terminal_completion_ref)
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
       NEW.terminal_owner, NEW.terminal_completion_ref);
    RETURN NEW;
  ELSE
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      item_kind = COALESCE(NEW.kind, 'bug'), origin = COALESCE(NEW.origin, 'local'),
      author_pubkey = NEW.author_pubkey, assignee_rank = NEW.assignee_rank,
      rank_writer = NEW.rank_writer, rank_updated_at = NEW.rank_updated_at,
      fed_ts = NEW.fed_ts, fed_hlc = NEW.fed_hlc,
      created_ts = (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
      updated_ts = (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
      payload = (COALESCE(NEW.payload, '{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei),
      terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref
    WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
      AND item_kind IN ('bug', 'change', 'task');
    RETURN NEW;
  END IF;
END;
$function$;
