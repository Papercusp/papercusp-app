\set ON_ERROR_STOP on
BEGIN;

-- Phase 1.5: drop per-harness physical tables, replace with auto-updatable
-- VIEWs over the consolidated tables. Writers continue to work unchanged
-- because every query already passes harness_slug. Reads through the view
-- are filtered to that slug. WITH CHECK OPTION prevents inserts/updates
-- with the wrong slug.

DROP FUNCTION IF EXISTS harness_shared.sync_features_consolidated() CASCADE;
DROP FUNCTION IF EXISTS harness_shared.sync_issues_consolidated() CASCADE;
DROP FUNCTION IF EXISTS harness_shared.sync_agent_runs_consolidated() CASCADE;
DROP FUNCTION IF EXISTS harness_shared.sync_snapshots_consolidated() CASCADE;

DO $$
DECLARE
  s TEXT;     -- schema name (harness_<slug>)
  slug TEXT;  -- registry slug (with hyphens)
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');

    -- Drop the per-harness physical tables. CASCADE drops their indexes
    -- and any remaining triggers. Their data already lives in
    -- harness_shared.*_consolidated via the trigger backfill from 029-031.
    -- Idempotence: on re-run the names refer to VIEWs (created below);
    -- DROP TABLE IF EXISTS errors with "is not a table", so try VIEW first.
    BEGIN EXECUTE format('DROP VIEW IF EXISTS %I.harness_features CASCADE', s);    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP TABLE IF EXISTS %I.harness_features CASCADE', s);   EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP VIEW IF EXISTS %I.harness_issues CASCADE', s);      EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP TABLE IF EXISTS %I.harness_issues CASCADE', s);     EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP VIEW IF EXISTS %I.agent_runs CASCADE', s);          EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP TABLE IF EXISTS %I.agent_runs CASCADE', s);         EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP VIEW IF EXISTS %I.harness_snapshots CASCADE', s);   EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('DROP TABLE IF EXISTS %I.harness_snapshots CASCADE', s);  EXCEPTION WHEN OTHERS THEN NULL; END;

    -- Replace with auto-updatable views over the consolidated tables.
    EXECUTE format($v$
      CREATE VIEW %1$I.harness_features AS
        SELECT * FROM harness_shared.harness_features_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    EXECUTE format($v$
      CREATE VIEW %1$I.harness_issues AS
        SELECT * FROM harness_shared.harness_issues_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    EXECUTE format($v$
      CREATE VIEW %1$I.agent_runs AS
        SELECT * FROM harness_shared.agent_runs_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    EXECUTE format($v$
      CREATE VIEW %1$I.harness_snapshots AS
        SELECT * FROM harness_shared.harness_snapshots_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.harness_features, %I.harness_issues, %I.agent_runs, %I.harness_snapshots TO harness_app', s, s, s, s);
    EXECUTE format('GRANT SELECT ON %I.harness_features, %I.harness_issues, %I.agent_runs, %I.harness_snapshots TO harness_zero', s, s, s, s);
  END LOOP;
END $$;

COMMIT;
