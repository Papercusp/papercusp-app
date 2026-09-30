-- 655-engineer-issues-claim-race-guard.sql
--
-- bug-drain-200k (2026-07-21, EI-18218648001542437): two fleet agents both got
-- assigned/claimed the IDENTICAL issue-family work-item (EI-18216603504703679) and
-- both attempted the identical fix -- a genuine claim race, not a coordination
-- misunderstanding.
--
-- ROOT CAUSE: harness_shared.engineer_issues_view_dml() (the INSTEAD OF UPDATE
-- trigger backing the engineer_issues compat view -- the by-id claim path,
-- work_items:claim -> claimWorkItem -> claimIssue() -> `UPDATE engineer_issues SET
-- assignee = ... WHERE assignee IS NULL OR ...`) had its "is this row still
-- claimable" check ONLY at the outer view-query level. The trigger's own INNER
-- write to the base table:
--
--   UPDATE harness_shared.work_items SET ..., taken_by = NEW.assignee, ...
--    WHERE workspace_id = OLD.workspace_id AND harness_slug = OLD.base_harness_slug
--      AND feature_id = OLD.issue_id AND item_kind = OLD.kind;
--
-- is keyed ONLY by the row's primary-key-shaped columns -- it never re-checks
-- taken_by. An updatable view processed via INSTEAD OF triggers gets NO automatic
-- EvalPlanQual re-check the way a normal table UPDATE does: the outer
-- `WHERE (assignee IS NULL OR ...)` is evaluated once, against each transaction's
-- own pre-commit snapshot. Two concurrent `claimIssue()` calls on the SAME
-- unclaimed row can BOTH pass that check (neither has committed yet), both fire
-- the trigger, and then their two inner UPDATEs correctly serialize on the real
-- row lock -- but since the inner UPDATE has no ownership guard, the SECOND one to
-- acquire the lock unconditionally overwrites `taken_by` with its OWN assignee,
-- silently discarding the first claimant's already-committed win. This is the
-- confirmed mechanism behind the observed duplicate-claim incident.
--
-- Note the SIBLING claim path (scheduler:get_next -> claimNextIssueWorkItem,
-- work-items.ts) was NEVER affected: it writes the base work_items table directly
-- via `UPDATE ... WHERE (pk) = (SELECT ... FOR UPDATE SKIP LOCKED)`, one atomic
-- statement, no view/trigger indirection.
--
-- FIX: give the trigger's inner UPDATE its OWN, freshly-evaluated ownership guard
-- (the same "claimable" predicate the outer check uses, mirrored from
-- claimIssue()'s own WHERE clause: unassigned, blank, the literal 'unassigned'
-- sentinel, or already the new assignee) PLUS an explicit pass-through for a
-- release (NEW.assignee IS NULL) and non-claim field-only edits (NEW.assignee
-- unchanged from OLD.assignee) so no legitimate write is newly blocked. When the
-- guard fails (the row was genuinely claimed by someone else in the interim),
-- `GET DIAGNOSTICS ... ROW_COUNT` reports 0 and the function RETURNs NULL --
-- exactly the same "0 rows affected / empty RETURNING" signal the existing
-- federated-row skip already uses two paragraphs up, which `claimIssue()` already
-- correctly interprets as `rows[0]` undefined -> null (a lost race), no caller
-- change needed.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Only the UPDATE branch's WHERE clause
-- (new AND-guard) and a trailing `GET DIAGNOSTICS`/`IF NOT FOUND` check are added;
-- every other line is reproduced verbatim from 641.

CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_slug text; v_ei jsonb; v_payload jsonb; v_updated int;
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
    -- EI-7833: a federated (origin='remote') row is owned by its authoring peer's
    -- core; the operator's LOCAL view writes must NOT clobber it. RETURN NULL so
    -- the INSTEAD OF trigger reports 0 rows affected + empty RETURNING.
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

  -- WI-5493: normalize NEW.payload to a real jsonb OBJECT before it is ever
  -- merged with `||` below — an un-normalized non-object payload silently
  -- array-corrupts the merge and destroys every named key.
  v_payload := COALESCE(NEW.payload, '{}'::jsonb);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    BEGIN
      IF jsonb_typeof(v_payload) = 'string' THEN
        -- postgres-js-jsonb-binding quirk: a JS object bound as ::jsonb sometimes
        -- double-encodes to a jsonb string scalar holding the JSON text — unwrap it.
        v_payload := (v_payload #>> '{}')::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_payload := '{}'::jsonb;
    END;
    IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
      -- Any other non-object shape (array/number/boolean, or a string that
      -- didn't unwrap to an object) would still corrupt the `||` merge — treat
      -- as empty rather than silently destroying the caller's named keys.
      v_payload := '{}'::jsonb;
    END IF;
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
       v_payload || jsonb_build_object('_ei', v_ei),
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
      payload = (v_payload - '_ei') || jsonb_build_object('_ei', v_ei),
      terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref
    WHERE workspace_id = OLD.workspace_id
      AND harness_slug = OLD.base_harness_slug
      AND feature_id = OLD.issue_id
      AND item_kind = OLD.kind
      -- 655 (claim-race guard): re-verify ownership against the CURRENT (fresh, at
      -- the moment this write actually takes the row lock) taken_by — NOT the OLD
      -- snapshot the outer view-query's WHERE clause evaluated, which can be stale
      -- under two concurrent claimants. Allows: a release (NEW.assignee IS NULL,
      -- always permitted structurally); a genuine new claim ONLY when the row is
      -- CURRENTLY unclaimed (NULL/blank/the 'unassigned' sentinel); a self-
      -- consistent re-affirm / non-claim field edit while the row is still held by
      -- the SAME assignee (taken_by = NEW.assignee, idempotent). A caller-authorized
      -- former-holder -> successor transfer is also valid while the row is still held
      -- by the OLD assignee; the view-level claimIssue() predicate has already checked
      -- that holder identity before this trigger takes the row lock. Anything else —
      -- the row is currently held by someone OTHER than NEW.assignee or OLD.assignee —
      -- fails this guard, updates 0 rows, and falls into the ROW_COUNT check below.
      AND (
        NEW.assignee IS NULL
        OR taken_by IS NULL OR btrim(taken_by) = '' OR lower(btrim(taken_by)) = 'unassigned'
        OR taken_by = NEW.assignee
        OR taken_by = OLD.assignee
      );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      -- Lost a genuine claim race (or the row's ownership changed between the
      -- view-level WHERE check and this write taking the lock) — signal it exactly
      -- like the federated-row skip above: RETURN NULL so the INSTEAD OF trigger
      -- reports 0 affected rows / empty RETURNING, which claimIssue() already
      -- treats as `rows[0]` undefined -> null (a lost race), the same outcome a
      -- same-transaction pre-check miss already produces today.
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;
