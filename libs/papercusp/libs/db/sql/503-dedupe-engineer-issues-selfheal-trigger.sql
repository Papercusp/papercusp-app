-- 503-dedupe-engineer-issues-selfheal-trigger.sql
--
-- Fix: `[improvement-watchdog] decay sweep failed: duplicate key value violates
-- unique constraint "work_items_pkey"` (recurring ~6x/90min in the bg-host /
-- desktop operator log).
--
-- Root cause: `harness_shared.engineer_issues` is a VIEW over `work_items`
-- (pkey = (harness_slug, feature_id)) with an INSTEAD OF INSERT/UPDATE/DELETE
-- trigger `engineer_issues_view_dml()`. The UPDATE branch rewrites
-- `harness_slug = v_slug` for EVERY work_items row matching (workspace_id,
-- feature_id, issue-kind). Corrupt DUPLICATE issue rows exist for the same
-- logical issue — one with a junk `harness_slug = ''` (empty) alongside the
-- canonical `operator:<ws>` / `<harness>` / `*` twin — so any payload-merge
-- UPDATE (e.g. the decay sweep's mergeIssuePayload) tries to move the empty-slug
-- row onto the canonical row's pkey → duplicate-key throw.
--
-- Two-part durable fix:
--   (1) One-time cleanup: delete the empty-`harness_slug` issue duplicates that
--       have a non-empty twin, then collapse any residual issue-dup group to one
--       physical row.
--   (2) Harden `engineer_issues_view_dml()` so the UPDATE branch SELF-HEALS:
--       collapse any duplicate issue rows for the logical issue to ONE physical
--       row BEFORE the UPDATE, so rewriting `harness_slug = v_slug` can never
--       collide again — even if a corrupt empty-slug row is re-introduced later.
--
-- Idempotent: the cleanup DELETEs are naturally re-runnable (no-op once clean);
-- the function is CREATE OR REPLACE. The migration runner wraps this whole file in
-- a single BEGIN…COMMIT transaction, so the file itself must NOT open one.

-- (1a) Delete corrupt empty-harness_slug issue rows that pair with a non-empty twin.
DELETE FROM harness_shared.work_items a
 WHERE a.item_kind IN ('bug', 'change', 'task')
   AND a.harness_slug = ''
   AND EXISTS (
     SELECT 1 FROM harness_shared.work_items b
      WHERE b.workspace_id = a.workspace_id
        AND b.feature_id   = a.feature_id
        AND b.item_kind IN ('bug', 'change', 'task')
        AND b.harness_slug <> ''
   );

-- (1b) Belt-and-suspenders: collapse any (workspace_id, feature_id) issue group that
--      STILL has >1 physical row (e.g. two non-empty slugs) to the min(ctid) survivor.
--      The survivor is fully overwritten on the next view UPDATE, so which physical
--      row remains is immaterial.
DELETE FROM harness_shared.work_items a
 WHERE a.item_kind IN ('bug', 'change', 'task')
   AND a.ctid <> (
     SELECT min(b.ctid) FROM harness_shared.work_items b
      WHERE b.workspace_id = a.workspace_id
        AND b.feature_id   = a.feature_id
        AND b.item_kind IN ('bug', 'change', 'task'))
   AND EXISTS (
     SELECT 1 FROM harness_shared.work_items c
      WHERE c.workspace_id = a.workspace_id
        AND c.feature_id   = a.feature_id
        AND c.item_kind IN ('bug', 'change', 'task')
        AND c.ctid <> a.ctid);

-- (2) Redefine the view DML trigger function with the self-heal collapse.
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
    -- SELF-HEAL (migration 503): collapse any duplicate issue rows for this logical
    -- issue to ONE physical row BEFORE the UPDATE. Corrupt duplicates (e.g. an empty
    -- harness_slug twin from a bad legacy write) otherwise make the harness_slug=v_slug
    -- rewrite below collide on the (harness_slug, feature_id) pkey. The DELETE is a
    -- no-op in the common single-row case (min(ctid) = the only row).
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
