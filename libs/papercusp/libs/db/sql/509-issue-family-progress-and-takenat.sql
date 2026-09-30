-- 509-issue-family-progress-and-takenat.sql — WI-2990
--
-- ROOT CAUSE (confirmed live 2026-07-05): issue-family claims persist correctly at
-- the DB layer — claimIssue() (issues-engineer.ts) UPDATEs the `engineer_issues`
-- compat view's assignee/assigned_at, and the view's INSTEAD OF trigger
-- (engineer_issues_view_dml, current body: migration 503) already maps
-- assigned_at -> the base `work_items.taken_at` column correctly (verified via
-- psql: claiming WI-2990 sets work_items.taken_by + taken_at as expected).
--
-- The actual bug is READ-SIDE: `issueToWorkItem()` (packages/operator-core/lib/
-- work-items.ts) hardcodes `takenAt: null, lastProgressAt: null` for EVERY
-- issue-family WorkItem, on the (incorrect, pre-374-unification) assumption that
-- "issue-family has no claim-time / progress columns" and that
-- `classifyItemActivity` "returns 'free' for a null-taken item anyway". Neither
-- holds: (a) the unified work_items base table DOES carry taken_at/last_progress_at
-- for issue-family rows post-migration-374, correctly populated on claim; (b)
-- `classifyItemActivity` (item-activity.ts) returns 'free' only when `takenBy` is
-- falsy — when takenBy IS set (the normal claimed case) but takenAt/lastProgressAt
-- read null, it returns 'stalled' (age = Infinity), which `isReclaimable()` treats
-- as immediately reclaimable. Every reader of that verdict (fleet:assignments'
-- `reclaimable` field, used by leader census / Queen placement) therefore sees a
-- freshly-claimed issue-family item as instantly stale — the observed symptom:
-- WI-2955 "dropped to assignee=null" / a leader census misreading a live claim as
-- unassigned (near double-placement). The base-table reaper (reclaimStaleIssueClaims,
-- work-items-stale-claims.ts) is UNAFFECTED — it queries assigned_at directly via SQL,
-- never through this DTO — so this migration does not change reaper behavior, only
-- the reporting fidelity feeding classifyItemActivity.
--
-- Two-part fix (this file = the DB half; the app half lands alongside in
-- work-items.ts / issues-engineer.ts / checkpoint.ts):
--   1. Expose `last_progress_at` on the `engineer_issues` compat view (it already
--      exists, correctly, on the base `work_items` table — just never surfaced
--      through the view's column list).
--   2. Thread `last_progress_at` through the view's INSERT/UPDATE INSTEAD OF
--      trigger branches so a future write through the view (not just the direct
--      base-table UPDATE the app half adds) can set it too.
--
-- CREATE OR REPLACE VIEW / FUNCTION — idempotent, no top-level BEGIN/COMMIT
-- (lint:migrations, files >= 215; the runner wraps each file in its own txn).

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
    -- WI-2990: the real item-scoped progress signal, previously never surfaced
    -- through this view (issueToWorkItem hardcoded it to null downstream).
    -- MUST be appended LAST — CREATE OR REPLACE VIEW can only add trailing
    -- columns, never reorder/insert among existing ones (PG rejects it as
    -- "cannot drop columns from view"). (The live view already carries
    -- terminal_owner/terminal_completion_ref from migration 432 — omitting them
    -- here is what tripped that error on the first two attempts.)
    last_progress_at
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
    -- SELF-HEAL (migration 503): collapse any duplicate issue rows for this logical
    -- issue to ONE physical row BEFORE the UPDATE (unchanged from 503).
    DELETE FROM harness_shared.work_items a
     WHERE a.workspace_id = OLD.workspace_id AND a.feature_id = OLD.issue_id
       AND a.item_kind IN ('bug', 'change', 'task')
       AND a.ctid <> (SELECT min(b.ctid) FROM harness_shared.work_items b
                       WHERE b.workspace_id = OLD.workspace_id AND b.feature_id = OLD.issue_id
                         AND b.item_kind IN ('bug', 'change', 'task'));
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      last_released_by = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN OLD.assignee ELSE last_released_by END,
      last_released_at = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN now() ELSE last_released_at END,
      -- WI-2990: thread last_progress_at through the view's UPDATE path too, for
      -- parity with the direct base-table write the app half (markIssueProgress)
      -- uses. NEW.last_progress_at defaults to OLD's value on a partial-column
      -- UPDATE (standard view-UPDATE semantics), so an unrelated field-only write
      -- through this view never clobbers it.
      last_progress_at = NEW.last_progress_at,
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
