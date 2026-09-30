-- 711-engineer-issues-view-dml-return-stored-row.sql
--
-- EI-19300744792370081 (root cause found during WI-6752).
--
-- THE BUG ---------------------------------------------------------------------
-- `harness_shared.engineer_issues` is a VIEW behind an INSTEAD OF trigger
-- (`engineer_issues_view_dml`). Both of its write branches end `RETURN NEW`.
--
-- For an INSTEAD OF trigger, the row the function RETURNS is the row a caller's
-- RETURNING clause is evaluated against. `RETURN NEW` therefore hands the caller
-- back THE ROW THEY SUPPLIED — re-labelled as a result. It is not read from
-- `harness_shared.work_items` and it is not evidence that anything was stored.
--
-- That makes the write STRUCTURALLY UNVERIFIABLE at the exact point that could
-- verify it. `createIssue()` (packages/operator-core/lib/issues-engineer.ts)
-- builds `{ created: true, ...toIssue(rows[0]) }` from precisely that RETURNING,
-- so a fully-formed issue object with a real id is returned from data the caller
-- typed. Every layer above — the MCP envelope, the replay cache that persists it
-- (EI-19301511582594101), the agent reading `ok:true` — inherits a claim no one
-- ever checked.
--
-- This is not theoretical, and the function itself proves it: the federated-row
-- skip (EI-7833) and the claim-race guard (mig 655) BOTH `RETURN NULL`, i.e. the
-- trigger already declines writes while the surrounding SQL reports success. A
-- caller cannot presently distinguish "stored" from "declined" by inspecting the
-- returned row, because the returned row is their own input either way.
--
-- The silent-drop class is broader than a declined write. Mig 679 landed because
-- the INSERT/UPDATE branches enumerate their columns EXPLICITLY: `authority` was
-- missing from the list, so writes to it did not error, did not warn, and did not
-- store — and RETURNING cheerfully echoed the value back. Any future column added
-- to the view but forgotten in these two lists fails exactly the same way. With
-- this migration it cannot: the returned row is read back out of the view, so a
-- column the trigger ignores comes back holding its stored value, visibly not the
-- one the caller sent.
--
-- THE FIX ---------------------------------------------------------------------
-- After each write branch, re-SELECT the affected row THROUGH THE VIEW and return
-- that. The read-back is keyed on `harness_shared.work_items`' primary key
-- (harness_slug, feature_id), so it matches at most one row, and it is projected
-- by the view itself — it cannot drift from the view's shape the way a hand-built
-- row list would.
--
-- Read-back keys, and why they differ per branch:
--   INSERT — (v_slug, NEW.issue_id): the values the INSERT actually wrote.
--   UPDATE — (v_slug, OLD.issue_id): the row the UPDATE actually targeted. Its
--     WHERE matched OLD, and the SET list does not touch feature_id, so the row
--     stays at OLD.issue_id. Keying on OLD (not NEW) is deliberate: if a caller
--     sets a column this trigger ignores, we return the row AS STORED and let the
--     difference be visible in RETURNING, rather than raising. Returning the truth
--     beats erroring — the caller can see what did and did not take.
--
-- NOT FOUND after a successful write means the stored row is not visible through
-- this view — in practice `item_kind` landed outside the view's
-- ('bug','change','task') filter. That is a write which genuinely cannot be
-- evidenced, so it RAISES rather than returning a row nobody can read back. Note
-- the pre-existing RETURN NULL paths are untouched: a declined write still
-- reports 0 rows + empty RETURNING, which callers already treat as "did not
-- happen". This migration only changes what a CLAIMED SUCCESS is built from.
--
-- WHY SURGERY AND NOT A FULL-BODY RESTATEMENT ----------------------------------
-- Same reasoning as mig 679, which applies with more force each time this
-- function is touched. It has now accumulated the EI-7833 federated skip, the
-- mig-499 release cooldown, the mig-509 last_progress_at passthrough, the WI-5493
-- payload normalisation, the mig-655 claim-race guard and the mig-679 authority
-- column in separate passes. A CREATE OR REPLACE pasted from a copy even minutes
-- stale would SILENTLY REVERT whatever landed in between, and a reverted
-- claim-race guard fails no test — it just starts losing races again.
--
-- So this patches whatever definition is actually installed, in three places,
-- touching nothing else. Every anchor is asserted and every post-condition is
-- re-read from pg_proc: it fails loudly or it works, it cannot half-apply.
--
-- Idempotent: re-running against an already-patched function is a no-op.

DO $mig711$
DECLARE
  def      text;
  patched  text;
  n_stored int;
  n_new    int;

  -- The three anchors, exactly as they appear in the installed definition.
  a_declare CONSTANT text := 'DECLARE v_slug text; v_ei jsonb; v_payload jsonb; v_updated int;';
  a_ins_ret CONSTANT text := 'NEW.last_progress_at, NEW.authority);
    RETURN NEW;';
  a_upd_ret CONSTANT text := '    RETURN NEW;
  END IF;
END;';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '711: harness_shared.engineer_issues_view_dml() not found — expected it to exist before this migration runs';
  END IF;

  -- Already patched (a re-run, or a later migration got there first). Keyed on the
  -- RETURN statement rather than the variable name: the explanatory comments this
  -- migration injects are returned by pg_get_functiondef too, so a marker that can
  -- appear in prose would read a COMMENT as an applied patch and no-op forever.
  IF position('RETURN v_stored;' in def) > 0 THEN
    RAISE NOTICE '711: engineer_issues_view_dml already returns the stored row — no-op';
    RETURN;
  END IF;

  IF position(a_declare in def) = 0 THEN
    RAISE EXCEPTION '711: DECLARE anchor not found in engineer_issues_view_dml — the function has been restructured; re-derive the anchors instead of forcing this migration. Expected: %', a_declare;
  END IF;
  IF position(a_ins_ret in def) = 0 THEN
    RAISE EXCEPTION '711: INSERT-branch RETURN anchor not found in engineer_issues_view_dml — the function has been restructured. Expected: %', a_ins_ret;
  END IF;
  IF position(a_upd_ret in def) = 0 THEN
    RAISE EXCEPTION '711: UPDATE-branch RETURN anchor not found in engineer_issues_view_dml — the function has been restructured. Expected: %', a_upd_ret;
  END IF;

  patched := def;

  -- 1/3 — a row variable to hold the read-back. Declared `record` rather than
  -- `harness_shared.engineer_issues%ROWTYPE` so the function carries no compile-time
  -- shape coupling to the view; the tuple is selected as `v.*` straight out of the
  -- view, so its descriptor matches the trigger's expected row type by construction.
  patched := replace(patched, a_declare,
    'DECLARE v_slug text; v_ei jsonb; v_payload jsonb; v_updated int; v_stored record;');

  -- 2/3 — INSERT branch: return the row as STORED, not as supplied.
  patched := replace(patched, a_ins_ret,
    'NEW.last_progress_at, NEW.authority);
    -- EI-19300744792370081: a RETURNING clause is evaluated against the row this
    -- trigger returns. Returning NEW would hand back the caller''s own input as if
    -- it were a result, so a failed or declined store is indistinguishable from a
    -- successful one. Read the row back THROUGH THE VIEW instead: what comes back
    -- is what Postgres kept.
    SELECT v.* INTO v_stored
      FROM harness_shared.engineer_issues v
     WHERE v.base_harness_slug = v_slug
       AND v.issue_id = NEW.issue_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION ''engineer_issues INSTEAD OF INSERT: row (%, %) is not readable back through the view after the INSERT (item_kind outside the view''''s bug/change/task filter?) — refusing to report a success that cannot be evidenced'', v_slug, NEW.issue_id;
    END IF;
    RETURN v_stored;');

  -- 3/3 — UPDATE branch: same, keyed on the row the UPDATE actually targeted.
  patched := replace(patched, a_upd_ret,
    '    -- EI-19300744792370081: as in the INSERT branch — RETURNING must reflect
    -- storage, not input. Keyed on OLD.issue_id because that is the row the UPDATE
    -- above matched; the SET list does not touch feature_id. A column this trigger
    -- silently ignores (the mig-679 class) therefore comes back holding its stored
    -- value, visibly different from what the caller sent.
    SELECT v.* INTO v_stored
      FROM harness_shared.engineer_issues v
     WHERE v.base_harness_slug = v_slug
       AND v.issue_id = OLD.issue_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION ''engineer_issues INSTEAD OF UPDATE: row (%, %) is not readable back through the view after the UPDATE (item_kind moved outside the view''''s bug/change/task filter?) — refusing to report a success that cannot be evidenced'', v_slug, OLD.issue_id;
    END IF;
    RETURN v_stored;
  END IF;
END;');

  EXECUTE patched;

  -- Re-read what actually landed. `patched` being right is not evidence that the
  -- installed function is right, and this migration's whole failure mode is a
  -- silent no-op, so post-conditions are checked against pg_proc — not against the
  -- local variable. (Which is the same discipline this migration exists to impose
  -- on the trigger itself.)
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  n_stored := (length(def) - length(replace(def, 'RETURN v_stored;', ''))) / length('RETURN v_stored;');
  IF n_stored <> 2 THEN
    RAISE EXCEPTION '711: post-condition failed — expected exactly 2 occurrences of `RETURN v_stored;` in the installed engineer_issues_view_dml (INSERT branch, UPDATE branch), found %', n_stored;
  END IF;

  -- And no write branch may still hand back the caller's input. The DELETE branch
  -- returns OLD and the two decline paths return NULL, so a surviving `RETURN NEW;`
  -- can only mean a branch was missed.
  n_new := (length(def) - length(replace(def, 'RETURN NEW;', ''))) / length('RETURN NEW;');
  IF n_new <> 0 THEN
    RAISE EXCEPTION '711: post-condition failed — % write branch(es) still `RETURN NEW;` (echoing caller input into RETURNING)', n_new;
  END IF;

  RAISE NOTICE '711: engineer_issues_view_dml now returns the stored row on INSERT and UPDATE';
END
$mig711$;
