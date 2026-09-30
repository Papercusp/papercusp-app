-- 1041-expose-release-columns-on-engineer-issues-view.sql
-- EI-19320339017813143 — the read side of the `worked-then-abandoned` open-work-item
-- audit bucket (packages/operator-core/lib/completion-audit.ts).
--
-- WHY THIS EXISTS. `last_released_at` / `last_released_by` are stamped on the ONE base
-- TABLE harness_shared.work_items (relkind='r') by the release path, but
-- harness_shared.engineer_issues is a VIEW over it (relkind='v') and never SELECTed
-- them. Every issue-family read — including listIssues/countIssues, which is where
-- work_items:list routes bug/change/task — therefore cannot see them at all.
--
-- That is not a cosmetic gap for this bucket, it is the whole population. Measured
-- 2026-08-30 on this install, over open non-observation rows released >21 days ago and
-- still open:
--     task 184 · change 139 · bug 58   (issue family, invisible without this) = 381
--     feature                       25 (already visible via harness_features_consolidated)
-- So 94% of what the bucket exists to surface lives behind this view. Shipping the
-- predicate without this migration would have produced a bucket that returns 25 rows
-- and reads as a complete answer — the exact "a leader ran it, saw a short list, and
-- concluded the fleet was sound" failure the completion-audit module header documents
-- (EI-10867). A silently-narrow audit is worse than no audit.
--
-- READ SIDE ONLY, DELIBERATELY. Unlike migration 946 (admission), this does NOT extend
-- engineer_issues_view_dml()'s INSERT/UPDATE branches. Release stamps are LIFECYCLE
-- state owned by the release write path, which writes harness_shared.work_items
-- DIRECTLY; the compatibility view is a read/field-edit surface, not a lifecycle writer
-- (the same rationale 946 records for admission, and the same reason this view already
-- refuses terminal transitions). Carrying these columns through the view's INSERT would
-- let a stale snapshot of a release stamp round-trip back over the writer.
--
-- FORWARD-COMPAT (additive, no acknowledgment line required — no destructive DDL):
-- every change here is append-only. CREATE OR REPLACE VIEW permits ADDING columns at
-- the end and nothing else. The deployed :3070 release never names the new columns, so
-- its reads and writes behave exactly as they do today.
--
-- Technique: patch the LIVE definition at a guarded structural anchor rather than
-- re-stating it (the migration-896 / 946 pattern). Re-transcribing a long view body to
-- add two columns is how an unrelated clause silently regresses; a hit-count guard plus
-- a post-condition cannot. Idempotent.

-- ---- 1. expose the two release columns on the read side ---------------------
DO $mig1041_view$
DECLARE
  def         text;
  patched     text;
  anchor      CONSTANT text := E'\n   FROM harness_shared.work_items';
  replacement CONSTANT text := E',\n    last_released_at,\n    last_released_by\n   FROM harness_shared.work_items';
  hits        integer;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name   = 'engineer_issues'
       AND column_name  = 'last_released_at'
  ) THEN
    RAISE NOTICE '1041: engineer_issues already exposes last_released_at — view no-op';
  ELSE
    SELECT pg_get_viewdef(c.oid)
      INTO def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'engineer_issues';

    IF def IS NULL THEN
      RAISE EXCEPTION
        '1041: harness_shared.engineer_issues not found — expected it before this migration';
    END IF;

    hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    IF hits <> 1 THEN
      RAISE EXCEPTION
        '1041: expected exactly one work_items view tail anchor, found %; re-derive the view patch instead of forcing it',
        hits;
    END IF;

    -- Append-only at the tail: patching only the tail anchor means a concurrent
    -- trailing-column addition is not silently reverted.
    patched := replace(def, anchor, replacement);
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.engineer_issues AS %s', patched);
  END IF;
END
$mig1041_view$;

-- ---- 2. post-conditions ----------------------------------------------------
DO $mig1041_check$
BEGIN
  -- Both columns present, and the INSTEAD OF trigger still attached. CREATE OR REPLACE
  -- VIEW keeps the trigger, but assert rather than assume: a view rebuilt any other way
  -- drops it, and every issue write would then silently hit a non-updatable view.
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name   = 'engineer_issues'
       AND column_name  IN ('last_released_at', 'last_released_by')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION
      '1041: post-condition failed — engineer_issues does not expose both release columns';
  END IF;

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
      '1041: post-condition failed — the engineer_issues INSTEAD OF DML trigger is missing';
  END IF;
END
$mig1041_check$;
