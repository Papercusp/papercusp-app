-- 679-engineer-issues-view-dml-carry-authority.sql
--
-- agent-protocol-authority-semantics-2026-07-26 P-004.
--
-- THE BUG ---------------------------------------------------------------------
-- 677 added `harness_shared.work_items.authority` and exposed it on BOTH family
-- views, and then declared the schema work done. It was not: `engineer_issues` is
-- not an auto-updatable view. It carries an INSTEAD OF trigger
-- (`engineer_issues_view_dml`) whose INSERT and UPDATE branches enumerate their
-- columns EXPLICITLY — and `authority` was not among them.
--
-- The consequence is the worst available one. An `UPDATE harness_shared.engineer_issues
-- SET authority = 'committed'` does not error, does not warn, and does not write.
-- The trigger simply ignores the column and reports success. So the entire
-- issue family — bug / change / task, the MAJORITY of work-items — could never
-- record a completion authority, and every caller would have been told it had.
--
-- This was caught only because P-004's integration tests assert the value reads
-- back from the base table after the write. The unit tests, which mock the state
-- writer, were green throughout: they prove the writer is ASKED for an authority,
-- never that Postgres kept it. Worth remembering the next time a mocked green
-- tempts anyone to skip the round-trip.
--
-- Verified on the live store before writing this (2026-07-26):
--   SELECT position('authority' in pg_get_functiondef(oid)) FROM pg_proc … → 0
--
-- WHY THIS MIGRATION EDITS THE LIVE DEFINITION INSTEAD OF RESTATING IT ---------
-- The obvious form is CREATE OR REPLACE with the whole ~120-line function body
-- pasted in. That form is a live hazard on this repo, and deliberately avoided:
-- this tree is edited concurrently by a whole fleet, so a full-body replacement
-- authored from a copy that is even minutes stale SILENTLY REVERTS whatever landed
-- in between — and this particular function is a magnet for exactly that, having
-- accumulated the mig-499 release-cooldown stamp, the mig-509 last_progress_at
-- passthrough, the WI-5493 payload normalisation and the mig-655 claim-race guard
-- in separate passes. A reverted claim-race guard would not fail any test; it would
-- just start losing races again.
--
-- So this migration performs SURGERY on whatever definition is actually installed,
-- adding one column in three places and touching nothing else. It cannot revert a
-- concurrent change because it never restates the parts it is not changing.
--
-- The trade is that surgery can MISS instead of clobbering, and a silent miss here
-- would leave the exact bug this file exists to fix. So every anchor is asserted:
-- if any expected substring is absent, or if the result does not end up carrying
-- `authority` in all three positions, the migration RAISES and the transaction
-- rolls back. It fails loudly or it works — it cannot half-apply.
--
-- Idempotent: re-running against an already-patched function is a no-op.

DO $mig679$
DECLARE
  def       text;
  patched   text;
  -- The three anchors, exactly as they appear in the installed definition.
  a_ins_cols  CONSTANT text := 'terminal_owner, terminal_completion_ref, last_progress_at)';
  a_ins_vals  CONSTANT text := 'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at);';
  a_upd_set   CONSTANT text := 'terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '679: harness_shared.engineer_issues_view_dml() not found — expected it to exist before this migration runs';
  END IF;

  -- Already carries the column (a re-run, or a future migration got there first).
  -- Keyed on `NEW.authority` rather than a bare `authority`: the bare word also occurs
  -- in this function's own explanatory comments, which pg_get_functiondef returns, so a
  -- bare test would read a COMMENT as an applied patch and no-op forever.
  IF position('NEW.authority' in def) > 0 THEN
    RAISE NOTICE '679: engineer_issues_view_dml already carries authority — no-op';
    RETURN;
  END IF;

  IF position(a_ins_cols in def) = 0 THEN
    RAISE EXCEPTION '679: INSERT column-list anchor not found in engineer_issues_view_dml — the function has been restructured; re-derive the anchors instead of forcing this migration. Expected: %', a_ins_cols;
  END IF;
  IF position(a_ins_vals in def) = 0 THEN
    RAISE EXCEPTION '679: INSERT VALUES anchor not found in engineer_issues_view_dml — the function has been restructured. Expected: %', a_ins_vals;
  END IF;
  IF position(a_upd_set in def) = 0 THEN
    RAISE EXCEPTION '679: UPDATE SET anchor not found in engineer_issues_view_dml — the function has been restructured. Expected: %', a_upd_set;
  END IF;

  patched := def;
  patched := replace(patched, a_ins_cols, 'terminal_owner, terminal_completion_ref, last_progress_at, authority)');
  patched := replace(patched, a_ins_vals, 'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at, NEW.authority);');
  patched := replace(patched, a_upd_set,  'terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref, authority = NEW.authority');

  EXECUTE patched;

  -- Re-read what actually landed. `patched` being right is not evidence that the
  -- installed function is right, and this migration's whole failure mode is a
  -- silent no-op, so the post-condition is checked against pg_proc, not against
  -- the local variable.
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  -- Count `NEW.authority`, not a bare `authority`. Two reasons, both learned the hard way
  -- when the first draft of this assertion fired against a correctly-patched function:
  --   · the bare word appears in comments (which pg_get_functiondef returns), and
  --   · the UPDATE clause `authority = NEW.authority` contains it TWICE on its own,
  -- so a bare-substring count is neither stable nor meaningful. `NEW.authority` occurs
  -- exactly once in the INSERT VALUES list and once in the UPDATE SET list.
  IF (length(def) - length(replace(def, 'NEW.authority', ''))) / length('NEW.authority') <> 2 THEN
    RAISE EXCEPTION '679: post-condition failed — expected exactly 2 occurrences of NEW.authority in the installed engineer_issues_view_dml (INSERT values, UPDATE set), found %',
      (length(def) - length(replace(def, 'NEW.authority', ''))) / length('NEW.authority');
  END IF;
  -- And the INSERT column list must actually name the column, or the INSERT branch would
  -- bind NEW.authority to the wrong column position.
  IF position('last_progress_at, authority)' in def) = 0 THEN
    RAISE EXCEPTION '679: post-condition failed — the INSERT column list does not name `authority`';
  END IF;

  RAISE NOTICE '679: engineer_issues_view_dml now carries authority (INSERT + UPDATE)';
END
$mig679$;
