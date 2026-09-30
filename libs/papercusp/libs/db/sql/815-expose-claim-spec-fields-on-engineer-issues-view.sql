-- 815 — EI-20288042426947475
--
-- The claim-spec SQL compiler reads these five values from the shared
-- work_items base row. The issue-family JS path reads the engineer_issues
-- compatibility view, which previously dropped them, so issue rows silently
-- fell back to payload-only values (or to defaults) and could disagree with
-- the SQL admission path. The columns already exist on work_items; append them
-- to preserve every existing engineer_issues view ordinal and its DML trigger.

-- EI-22447063248857569: R22 accidentally omitted this file, but later migrations
-- still expanded the view. Restoring the old explicit SELECT then failed with
-- "cannot drop columns from view". Reuse the guarded append-only view patch
-- pattern from migrations 896/946: preserve the live definition, ordinals,
-- permissions and DML trigger, and append only fields that are still missing.
-- FORWARD-COMPAT: only appends missing view fields; already-applied databases
-- retain their migration ledger and current view definition unchanged.
DO $mig815_view$
DECLARE
  view_oid oid;
  definition text;
  additions text := '';
  field_name text;
  anchor CONSTANT text := E'\n   FROM harness_shared.work_items';
  required_fields CONSTANT text[] := ARRAY[
    'tags', 'source_plan_slug', 'source_plan_item_ids', 'redundancy', 'expected_cost_cents'
  ];
  hits integer;
BEGIN
  SELECT c.oid INTO view_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared'
     AND c.relname = 'engineer_issues'
     AND c.relkind = 'v';
  IF view_oid IS NULL THEN
    RAISE EXCEPTION '815: expected harness_shared.engineer_issues compatibility view';
  END IF;

  FOREACH field_name IN ARRAY required_fields LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = view_oid AND attname = field_name
         AND attnum > 0 AND NOT attisdropped
    ) THEN
      additions := additions || format(E',\n    %I', field_name);
    END IF;
  END LOOP;
  IF additions = '' THEN
    RETURN;
  END IF;

  definition := pg_get_viewdef(view_oid);
  hits := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION '815: expected exactly one work_items view tail anchor, found %', hits;
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS %s',
    replace(definition, anchor, additions || anchor)
  );

  IF (
    SELECT count(*) FROM pg_attribute
     WHERE attrelid = view_oid AND attname = ANY(required_fields)
       AND attnum > 0 AND NOT attisdropped
  ) <> cardinality(required_fields) THEN
    RAISE EXCEPTION '815: engineer_issues must expose every claim-spec field';
  END IF;
END
$mig815_view$;
