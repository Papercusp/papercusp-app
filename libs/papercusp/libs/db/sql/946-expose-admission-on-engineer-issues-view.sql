-- 946-expose-admission-on-engineer-issues-view.sql
-- Plan: work-queue-admission-and-bulk-dedup-2026-08-24, P-002 (born-pending).
--
-- WHY THIS EXISTS — migration 944 was incomplete for the ISSUE family.
--
-- 944 added admission/admitted_at/admitted_by to harness_shared.work_items, which is
-- the ONE base TABLE (relkind='r'). But harness_shared.engineer_issues is a VIEW over
-- it (relkind='v') carrying an INSTEAD OF trigger, and that is the surface every
-- issue-family filing path writes through (issues-engineer.ts createIssue ->
-- INSERT INTO harness_shared.engineer_issues with an explicit column list).
--
-- Two independent things therefore dropped the new columns on the floor:
--   1. the view did not SELECT them, so an INSERT could not even name them; and
--   2. engineer_issues_view_dml()'s INSERT branch has a FIXED column list, so a named
--      column it does not know about is silently ignored (the mig-679 class the
--      function's own RETURNING comment warns about).
--
-- Net effect before this migration: a bug/change/task could never be born pending.
-- The base column just defaulted to NULL, and isAdmitted() reads NULL as ADMITTED
-- (back-compat for pre-gate rows) — so the entire admission gate was a silent no-op
-- for the issue family while looking correct for features. P-002 requires the stamp to
-- ride IN the INSERT: a post-create UPDATE leaves a window where the row is already
-- visible and claimable, which is exactly what born-pending exists to prevent.
--
-- FORWARD-COMPAT (additive, no acknowledgment line required — no destructive DDL):
-- every change here is append-only. The deployed :3070 release never names the new
-- columns, so its inserts leave them NULL = admitted = today's behavior exactly.
--
-- ADMISSION IS INSERT-ONLY THROUGH THIS VIEW, BY DESIGN. The UPDATE branch is
-- deliberately NOT extended to write admission. The compatibility view is a
-- read/field-edit surface, not a lifecycle writer (same rationale that already refuses
-- terminal transitions here), and admission is promoter-owned lifecycle state. The
-- P-003 promoter writes harness_shared.work_items DIRECTLY. An UPDATE through this view
-- therefore leaves a stored admission untouched rather than round-tripping a stale
-- snapshot of it back over the promoter's write.
--
-- Technique: patch the LIVE definitions at a guarded structural anchor rather than
-- re-stating them (the migration-896 pattern). Re-transcribing a 150-line plpgsql body
-- to add three columns is how an unrelated clause silently regresses; a hit-count guard
-- plus a post-condition cannot. Both blocks are idempotent.

-- ---- 1. expose the three columns on the read side --------------------------
DO $mig946_view$
DECLARE
  def         text;
  patched     text;
  anchor      CONSTANT text := E'\n   FROM harness_shared.work_items';
  replacement CONSTANT text := E',\n    admission,\n    admitted_at,\n    admitted_by\n   FROM harness_shared.work_items';
  hits        integer;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name   = 'engineer_issues'
       AND column_name  = 'admission'
  ) THEN
    RAISE NOTICE '946: engineer_issues already exposes admission — view no-op';
  ELSE
    SELECT pg_get_viewdef(c.oid)
      INTO def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'engineer_issues';

    IF def IS NULL THEN
      RAISE EXCEPTION
        '946: harness_shared.engineer_issues not found — expected it before this migration';
    END IF;

    hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    IF hits <> 1 THEN
      RAISE EXCEPTION
        '946: expected exactly one work_items view tail anchor, found %; re-derive the view patch instead of forcing it',
        hits;
    END IF;

    -- Append-only at the tail: CREATE OR REPLACE VIEW permits ADDING columns at the
    -- end and nothing else, and patching only the tail anchor means a concurrent
    -- trailing-column addition is not silently reverted.
    patched := replace(def, anchor, replacement);
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.engineer_issues AS %s', patched);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name   = 'engineer_issues'
       AND column_name  IN ('admission', 'admitted_at', 'admitted_by')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION
      '946: post-condition failed — engineer_issues does not expose all three admission columns';
  END IF;
END
$mig946_view$;

-- ---- 2. let the INSTEAD OF INSERT actually carry them through ---------------
DO $mig946_fn$
DECLARE
  def          text;
  patched      text;
  cols_anchor  CONSTANT text := 'terminal_owner, terminal_completion_ref, last_progress_at, authority, parent_id)';
  cols_repl    CONSTANT text := 'terminal_owner, terminal_completion_ref, last_progress_at, authority, parent_id,'
                                || E'\n       admission, admitted_at, admitted_by)';
  vals_anchor  CONSTANT text := 'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at, NEW.authority, NEW.parent_id);';
  vals_repl    CONSTANT text := 'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at, NEW.authority, NEW.parent_id,'
                                || E'\n       NEW.admission, NEW.admitted_at, NEW.admitted_by);';
  hits         integer;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION
      '946: harness_shared.engineer_issues_view_dml() not found — expected it before this migration';
  END IF;

  IF position('NEW.admission' IN def) > 0 THEN
    RAISE NOTICE '946: engineer_issues_view_dml already carries admission — function no-op';
    RETURN;
  END IF;

  -- Each anchor must match EXACTLY once. The UPDATE branch writes these same column
  -- names in `col = NEW.col` form, so it cannot collide with either anchor; a hit
  -- count other than 1 means the function drifted and the patch must be re-derived
  -- rather than forced onto a body it no longer describes.
  hits := (length(def) - length(replace(def, cols_anchor, ''))) / length(cols_anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '946: expected exactly one INSERT column-list anchor in engineer_issues_view_dml, found %; re-derive the patch',
      hits;
  END IF;

  hits := (length(def) - length(replace(def, vals_anchor, ''))) / length(vals_anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '946: expected exactly one INSERT VALUES anchor in engineer_issues_view_dml, found %; re-derive the patch',
      hits;
  END IF;

  patched := replace(def, cols_anchor, cols_repl);
  patched := replace(patched, vals_anchor, vals_repl);
  EXECUTE patched;
END
$mig946_fn$;

-- ---- 3. post-conditions ----------------------------------------------------
DO $mig946_check$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL OR position('NEW.admission' IN def) = 0 THEN
    RAISE EXCEPTION
      '946: post-condition failed — engineer_issues_view_dml() still does not carry admission into the base INSERT';
  END IF;

  -- The INSTEAD OF trigger must still be attached: CREATE OR REPLACE FUNCTION keeps
  -- it, but assert rather than assume, because a view rebuilt any other way drops it
  -- and every issue write would then silently hit a non-updatable view.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'engineer_issues'
       AND t.tgname  = 'engineer_issues_view_dml_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      '946: post-condition failed — the engineer_issues INSTEAD OF DML trigger is missing';
  END IF;
END
$mig946_check$;
