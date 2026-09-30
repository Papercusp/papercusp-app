-- 499-issue-family-release-cooldown.sql — issue-family (bug/change/task)
-- release-cooldown provenance, mirroring the feature-family mechanism
-- (mig 485 / EI-6956) so the SAME claim/release ping-pong guard applies to
-- BOTH families.
--
-- ROOT CAUSE (confirmed live 2026-07-04, backlog-drain fleet): the feature-family
-- release path (releaseWorkItem's non-issue branch, work-items.ts) stamps
-- `last_released_by`/`last_released_at` on release, and claimNextWorkItem's shared
-- `claimFloorsWhereSql` floor excludes a row from the SAME releasing claimant for
-- `releaseCooldownSec()` (default 300s) afterward — this is the guard that stops an
-- agent from immediately re-claiming the exact row it just released.
--
-- The issue-family (bug/change/task) release path has NEITHER half of this: `releaseIssue()`
-- (issues-engineer.ts) updates the `engineer_issues` compat view's `assignee`/`assigned_at`
-- columns only — the view's INSTEAD OF trigger (engineer_issues_view_dml, current body:
-- migration 432) never touches `last_released_by`/`last_released_at` on the base
-- `harness_shared.work_items` row, even though those columns already exist there (added
-- pre-unification, migration 374 carries them on the base table). AND
-- `claimNextIssueWorkItem`'s claim query (work-items.ts) never reads them as a floor at all.
--
-- Net effect: releasing (or `scheduler:get_next`/`work_items:claim_next` re-serving) an
-- issue-family item has ZERO cooldown protection — the very next self-select call from the
-- SAME agent re-claims the SAME top-ranked item, forever, whenever it's the oldest/highest-
-- ranked eligible row. This is the generalized form of the already-observed WI-652-class
-- "ping-pong" symptom (EI-7528 thread) — reproduced fresh live on WI-2381 this session (a
-- release immediately followed by the identical item being re-served + re-claimed).
--
-- THE FIX (two halves, both additive/backward-compatible — no other behavior changes):
--   1. engineer_issues_view_dml's UPDATE branch: stamp last_released_by/at on the base row
--      whenever a release is happening (NEW.assignee IS NULL and OLD.assignee WAS set) —
--      the exact same "SET's RHS reads the OLD row" pattern the feature-family release uses.
--      OLD.assignee / NEW.assignee are already exposed on the view (mapped from taken_by),
--      so no view column list change is needed — the view definition is unchanged here.
--   2. claimNextIssueWorkItem's claim query (work-items.ts, app-side, not this file): add the
--      identical cooldown floor claimFloorsWhereSql already has for features.
--
-- The migration runner wraps each file in its own txn — NO top-level BEGIN;/COMMIT;
-- (lint:migrations, files >= 215).

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
      -- 499: release-cooldown provenance (mirrors the feature-family release stamp,
      -- work-items.ts releaseWorkItem). A release is exactly "this update clears an
      -- assignee that was previously set" — OLD is the view row BEFORE this UPDATE,
      -- so OLD.assignee is the releasing holder.
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
