-- 295-completion-diagnostic.sql  (READ-ONLY PROBE — safe to run anytime db is up)
--
-- Answers "what 'default' harness-keyed residue did mig 295 (WI-148 workspace-
-- identity restamp) leave behind, and how much of it is movable under 295's
-- collision-safe contract?" — the ground truth the staged completion migration
-- (425-workspace-identity-restamp-completion.sql.draft) needs before it can be
-- filled and applied.
--
-- WRITES NOTHING to real data. Only: builds a SESSION-LOCAL temp map (295's
-- slug → unique-non-default-workspace) and RAISE NOTICE's per-table counts.
-- No UPDATE / INSERT / DELETE / ALTER on any harness_shared table. Run with:
--     psql "$HARNESS_ADMIN_URL" -f 295-completion-diagnostic.sql
--
-- Reading the output:
--   * "<table> [<key>]: default=<N> movable=<M> left=<L>"
--       N = rows under workspace_id='default'
--       M = rows whose harness maps to EXACTLY ONE non-default workspace (295
--           moves these)
--       L = N - M = rows LEFT untouched (slug in 0 or >1 non-default workspaces,
--           or scope not 'harness:<slug>') — 295's fail-safe.
--   * Tables with default=0 are clean (295 already covered them, or never held
--     'default' rows) — they do NOT go in the completion migration.
--   * The sum of M across tables is the real "~68K" the audit cited. Each table
--     with M>0 needs one UPDATE in the completion migration.

DO $diag$
DECLARE
  rec        record;
  n_default  bigint;
  n_movable  bigint;
  total_def  bigint := 0;
  total_mov  bigint := 0;
  tbls       int    := 0;
BEGIN
  -- 295's collision-safe map: slug → its UNIQUE non-default workspace (n=1 only).
  DROP TABLE IF EXISTS _wsmap_diag;
  CREATE TEMP TABLE _wsmap_diag AS
  SELECT slug, real_ws FROM (
    SELECT slug, max(workspace_id) AS real_ws, count(*) AS n FROM (
      SELECT DISTINCT r.workspace_id, p->>'slug' AS slug
        FROM harness_shared.harness_registry r,
             jsonb_array_elements(COALESCE(r.payload->'projects','[]'::jsonb)) p
       WHERE r.workspace_id NOT IN ('default','*','scratch')
    ) d GROUP BY slug
  ) m WHERE n = 1;

  RAISE NOTICE '--- 295-completion residue probe (map has % unique-slug entries) ---',
    (SELECT count(*) FROM _wsmap_diag);

  -- harness_slug-keyed tables: workspace_id + harness_slug both present.
  FOR rec IN
    SELECT c1.table_name
      FROM information_schema.columns c1
      JOIN information_schema.columns c2
        ON c2.table_schema = c1.table_schema AND c2.table_name = c1.table_name
     WHERE c1.table_schema = 'harness_shared'
       AND c1.column_name  = 'workspace_id'
       AND c2.column_name  = 'harness_slug'
     ORDER BY c1.table_name
  LOOP
    -- LEFT JOIN + count(matched) rather than a subquery-in-FILTER (the latter is
    -- not reliably valid inside an aggregate FILTER clause). count(m.slug) counts
    -- only rows whose harness_slug matched a unique-workspace map entry = movable.
    EXECUTE format(
      'SELECT count(*), count(m.slug) '
      'FROM harness_shared.%I t LEFT JOIN _wsmap_diag m ON m.slug = t.harness_slug '
      'WHERE t.workspace_id = %L',
      rec.table_name, 'default')
      INTO n_default, n_movable;
    IF n_default > 0 THEN
      tbls := tbls + 1; total_def := total_def + n_default; total_mov := total_mov + n_movable;
      RAISE NOTICE '% [harness_slug]: default=% movable=% left=%',
        rec.table_name, n_default, n_movable, n_default - n_movable;
    END IF;
  END LOOP;

  -- scope-keyed tables (e.g. engineer_issues): workspace_id + scope, NO
  -- harness_slug. 295 moved these via scope = 'harness:' || slug.
  FOR rec IN
    SELECT c1.table_name
      FROM information_schema.columns c1
      JOIN information_schema.columns c2
        ON c2.table_schema = c1.table_schema AND c2.table_name = c1.table_name
     WHERE c1.table_schema = 'harness_shared'
       AND c1.column_name  = 'workspace_id'
       AND c2.column_name  = 'scope'
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns c3
          WHERE c3.table_schema = 'harness_shared'
            AND c3.table_name   = c1.table_name
            AND c3.column_name  = 'harness_slug')
     ORDER BY c1.table_name
  LOOP
    -- scope = 'harness:' || slug is 295's exact predicate; LEFT JOIN on it so
    -- count(m.slug) = rows whose scope names a unique-workspace harness = movable.
    EXECUTE format(
      'SELECT count(*), count(m.slug) '
      'FROM harness_shared.%I t LEFT JOIN _wsmap_diag m ON t.scope = %L || m.slug '
      'WHERE t.workspace_id = %L',
      rec.table_name, 'harness:', 'default')
      INTO n_default, n_movable;
    IF n_default > 0 THEN
      tbls := tbls + 1; total_def := total_def + n_default; total_mov := total_mov + n_movable;
      RAISE NOTICE '% [scope=harness:*]: default=% movable=% left=%',
        rec.table_name, n_default, n_movable, n_default - n_movable;
    END IF;
  END LOOP;

  RAISE NOTICE '--- TOTAL: % residual table(s), default=% movable=% (movable = the completion migration''s scope) ---',
    tbls, total_def, total_mov;

  DROP TABLE _wsmap_diag;
END
$diag$;
