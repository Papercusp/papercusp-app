-- 966-expose-admission-on-harness-features-consolidated-view.sql
--
-- EI-21465624967193102 — migration 944 added the born-pending admission
-- columns to harness_shared.work_items, but migration 374 had already defined
-- harness_features_consolidated as a SELECT * compatibility VIEW. PostgreSQL
-- expands that star when the view is created, so later base-table columns do
-- not appear on the view automatically. Migration 946 repaired only the issue
-- family. Feature-family claim/preflight reads consequently failed with
-- `column admission does not exist` and reported the misleading fallback
-- reason `lane-unknown` after plans:start had already promoted its items.
--
-- Append the three columns at the catalog-derived SELECT-list tail. This reuses
-- migration 698's guarded view-surgery pattern instead of restating a long,
-- concurrently evolving definition. The unique structural anchor and catalog
-- post-condition make a silent partial patch impossible. Additive and
-- idempotent: a deployed older binary simply ignores the new view columns.

DO $mig966_view$
DECLARE
  def             text;
  patched         text;
  missing_select  text := '';
  anchor          CONSTANT text := E'\n   FROM harness_shared.work_items';
  hits            integer;
  exposed_count   integer;
BEGIN
  SELECT count(*)::integer
    INTO exposed_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'harness_features_consolidated'
     AND column_name IN ('admission', 'admitted_at', 'admitted_by');

  IF exposed_count = 3 THEN
    RAISE NOTICE
      '966: harness_features_consolidated already exposes all admission columns — no-op';
    RETURN;
  END IF;

  SELECT pg_get_viewdef(c.oid)
    INTO def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared'
     AND c.relname = 'harness_features_consolidated'
     AND c.relkind = 'v';

  IF def IS NULL THEN
    RAISE EXCEPTION
      '966: harness_shared.harness_features_consolidated view not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'harness_features_consolidated'
       AND column_name = 'admission'
  ) THEN
    missing_select := missing_select || E',\n    admission';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'harness_features_consolidated'
       AND column_name = 'admitted_at'
  ) THEN
    missing_select := missing_select || E',\n    admitted_at';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'harness_features_consolidated'
       AND column_name = 'admitted_by'
  ) THEN
    missing_select := missing_select || E',\n    admitted_by';
  END IF;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '966: expected exactly one work_items view-tail anchor, found %; re-derive the patch instead of forcing it',
      hits;
  END IF;

  patched := replace(def, anchor, missing_select || anchor);
  EXECUTE format(
    'CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS %s',
    patched
  );

  SELECT count(*)::integer
    INTO exposed_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'harness_features_consolidated'
     AND column_name IN ('admission', 'admitted_at', 'admitted_by');

  IF exposed_count <> 3 THEN
    RAISE EXCEPTION
      '966: post-condition failed — harness_features_consolidated exposes % of 3 admission columns',
      exposed_count;
  END IF;
END
$mig966_view$;
