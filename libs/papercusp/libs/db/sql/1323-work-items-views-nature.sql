-- 1323-work-items-views-nature.sql
--
-- P-010 / WI-10005046 (plan enterprise-data-sources-2026-10-01, D-011, D-018).
--
-- Migration 1322 added work_items.nature and work_items.audience, stamped by a
-- BEFORE trigger from datatype_registry. The two family compat views that the
-- list, count and search read paths query (harness_features_consolidated and
-- engineer_issues) are column projections of work_items, so they do not expose
-- the new columns. This migration appends nature and audience LAST to both views.
--
-- Why it matters: work_items:list, search and counts default to nature = 'work'
-- (R-4). Every non-work kind (record / document / event, e.g. the fundraise
-- pipeline-deal) lands in harness_features_consolidated, because that view is
-- item_kind NOT IN ('bug','change','task'). The read path therefore needs the
-- column on that view.
--
-- Pattern: read the LIVE definition with pg_get_viewdef, replace ONE structural
-- anchor (the FROM work_items tail), and CREATE OR REPLACE VIEW. That form may
-- only append columns, which is exactly what this does, so the dependent view
-- harness_features is untouched. Same pattern as 1041 / 1110.
--
-- Additive only: no DROP, no RENAME, nothing the deployed release reads changes.

DO $mig1323_views$
DECLARE
  v_name text;
  def text;
  -- pg_get_viewdef qualifies the relation only when harness_shared is NOT on the
  -- caller's search_path (the migration runner: qualified, as in 1110; an
  -- operator session: unqualified). Accept either, but still demand exactly one hit.
  qualified constant text := E'\n   FROM harness_shared.work_items';
  unqualified constant text := E'\n   FROM work_items\n';
  anchor text;
  additions constant text := E',\n    nature,\n    audience';
  hits integer;
  patched text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['harness_features_consolidated', 'engineer_issues'] LOOP
    SELECT pg_get_viewdef(c.oid)
      INTO def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = v_name
       AND c.relkind = 'v';

    IF def IS NULL THEN
      RAISE EXCEPTION '1323: harness_shared.% view not found', v_name;
    END IF;

    -- Idempotent: a view that already projects nature is left alone.
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname = v_name
         AND a.attname = 'nature' AND NOT a.attisdropped
    ) THEN
      CONTINUE;
    END IF;

    anchor := CASE WHEN position(qualified IN def) > 0 THEN qualified ELSE unqualified END;
    hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    IF hits <> 1 THEN
      RAISE EXCEPTION
        '1323: expected exactly one FROM work_items tail anchor in %, found %; re-derive the view patch instead of forcing it',
        v_name, hits;
    END IF;

    patched := replace(def, anchor, additions || anchor);
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.%I AS %s', v_name, patched);
  END LOOP;
END
$mig1323_views$;

DO $mig1323_check$
DECLARE
  missing integer;
BEGIN
  SELECT count(*)::int
    INTO missing
    FROM (VALUES ('harness_features_consolidated'), ('engineer_issues')) v(relname)
    CROSS JOIN (VALUES ('nature'), ('audience')) col(attname)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relname = v.relname
        AND a.attname = col.attname AND NOT a.attisdropped
   );
  IF missing <> 0 THEN
    RAISE EXCEPTION '1323: % view column(s) missing after the patch', missing;
  END IF;
END
$mig1323_check$;
