-- 1371 — refresh per-pot views over harness_shared.*_consolidated (WI-10006309).
--
-- Every pot schema `harness_<slug>` exposes each consolidated table as a view
-- `SELECT * FROM harness_shared.<base>_consolidated WHERE harness_slug = '<slug>'`.
-- Postgres fixes a view's column list when the view is created, so a column
-- added to the base table later is invisible through every view that existed
-- before it. Migration 1023 fixed that once, inline, for agent_chats.su_runtime_class;
-- 1156 then added agent_chats.continued_from_chat_id / continued_from_turn_count
-- without a refresh, and listChats (which projects them) has returned HTTP 500
-- for 256 of 263 pots since: the agent-chats list fails and pui's /resume
-- picker never leaves "Loading earlier conversations…" (P-027 G-12).
-- Measured 2026-10-06 (pg_catalog census, stranded column -> views missing it):
--   agent_chats.continued_from_chat_id 256, .continued_from_turn_count 256,
--   agent_chats.su_runtime_class 12, harness_issues.fed_hlc 209,
--   harness_issues.fed_ts 18, .author_pubkey/.origin/.workspace_id 12 each.
--
-- This migration turns 1023's loop into a reusable function and runs it for
-- every consolidated base. A later migration that adds a column to a
-- `harness_shared.*_consolidated` table must call
--   SELECT * FROM harness_shared.refresh_consolidated_views('<base>');
-- in the same file; consolidated-view-refresh.test.ts fails the build otherwise.
--
-- Safety, as in 1023:
--  * CREATE OR REPLACE VIEW may only APPEND columns, which is where ADD COLUMN
--    puts them; it keeps the view's grants and per-column DEFAULTs (the
--    workspace_id / harness_slug defaults the auto-updatable writers rely on).
--    A view whose columns no longer line up (renamed / retyped / dropped) raises
--    invalid_table_definition and is SKIPPED, never rebuilt by guesswork.
--  * The slug is read out of the view's own definition, and only a view whose
--    WHERE clause is exactly that slug filter is replaced: rebuilding any other
--    shape as a bare slug filter could widen it. (Census 2026-10-06: every
--    consolidated per-pot view has exactly that shape.)
--  * Ownership-tolerant: some pot views are owned by postgres_app, not the
--    migration role (see 1023). Each skip is a NOTICE, never silent, and the
--    function returns the counts so a caller can assert on them.
--  * Views that already expose every base column are left alone (no churn).

CREATE OR REPLACE FUNCTION harness_shared.refresh_consolidated_views(base text)
RETURNS TABLE (replaced integer, skipped integer, already_current integer)
LANGUAGE plpgsql
AS $fn$
DECLARE
  base_oid oid;
  v record;
  def text;
  slug text;
  check_opt text;
BEGIN
  replaced := 0;
  skipped := 0;
  already_current := 0;
  base_oid := to_regclass(format('harness_shared.%I', base || '_consolidated'));
  IF base_oid IS NULL THEN
    RAISE EXCEPTION 'refresh_consolidated_views: harness_shared.%_consolidated does not exist', base;
  END IF;

  FOR v IN
    SELECT c.oid, n.nspname AS s
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND c.relname = base
       AND n.nspname LIKE 'harness\_%'
       AND n.nspname <> 'harness_shared'
     ORDER BY n.nspname
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = base_oid AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute va
            WHERE va.attrelid = v.oid AND va.attname = a.attname AND NOT va.attisdropped))
    THEN
      already_current := already_current + 1;
      CONTINUE;
    END IF;

    def := pg_get_viewdef(v.oid);
    slug := (regexp_match(def, 'WHERE \(harness_slug = ''([^'']*)''::text\);?\s*$'))[1];
    IF slug IS NULL OR position(base || '_consolidated' IN def) = 0 THEN
      skipped := skipped + 1;
      RAISE NOTICE 'refresh_consolidated_views: skipped %.% (definition is not a plain slug filter over %_consolidated)', v.s, base, base;
      CONTINUE;
    END IF;

    SELECT iv.check_option INTO check_opt
      FROM information_schema.views iv
     WHERE iv.table_schema = v.s AND iv.table_name = base;

    BEGIN
      EXECUTE format(
        'CREATE OR REPLACE VIEW %1$I.%2$I AS '
        'SELECT * FROM harness_shared.%3$I '
        'WHERE harness_slug = %4$L%5$s',
        v.s,
        base,
        base || '_consolidated',
        slug,
        CASE
          WHEN check_opt = 'CASCADED' THEN ' WITH CASCADED CHECK OPTION'
          WHEN check_opt = 'LOCAL' THEN ' WITH LOCAL CHECK OPTION'
          ELSE ''
        END);
      replaced := replaced + 1;
    EXCEPTION WHEN insufficient_privilege OR wrong_object_type OR invalid_table_definition THEN
      skipped := skipped + 1;
      RAISE NOTICE 'refresh_consolidated_views: skipped %.% (%)', v.s, base, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'refresh_consolidated_views(%): replaced %, skipped %, already current %',
    base, replaced, skipped, already_current;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION harness_shared.refresh_consolidated_views(text) IS
  'Re-expose columns added to harness_shared.<base>_consolidated through every per-pot harness_<slug>.<base> view (views fix their column list at creation). Call it in the same migration as any ADD COLUMN on a *_consolidated table (WI-10006309).';

DO $mig$
DECLARE
  b text;
  r record;
BEGIN
  FOR b IN
    SELECT left(c.relname, length(c.relname) - length('_consolidated'))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE '%\_consolidated'
     ORDER BY c.relname
  LOOP
    SELECT * INTO r FROM harness_shared.refresh_consolidated_views(b);
  END LOOP;
END
$mig$;
