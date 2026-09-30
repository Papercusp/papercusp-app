-- 332: DS-1 — rename schema papercup_shared -> papercusp_shared + compat views.
--
-- ALTER SCHEMA RENAME is catalog-only (no row rewrite). The legacy release tree
-- still carries papercup_shared in its search_path, so we recreate papercup_shared
-- as AUTO-UPDATABLE views over papercusp_shared — safe because these tables carry
-- NO RLS. The views are dropped later (the "contract") once the release tree is
-- redeployed onto papercusp_shared.
--
-- GUARDED / idempotent: on an already-migrated DB (papercup_shared holds views,
-- not base tables) this is a no-op. On a fresh DB (papercup_shared still holds the
-- base tables from earlier migrations) it performs the rename + view bridge.
DO $$
DECLARE
  has_real_tables boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'papercup_shared'::regnamespace AND relkind = 'r'
  ) INTO has_real_tables;

  IF has_real_tables THEN
    ALTER SCHEMA papercup_shared RENAME TO papercusp_shared;

    CREATE SCHEMA papercup_shared;
    GRANT USAGE  ON SCHEMA papercup_shared TO harness_admin, harness_app;
    GRANT CREATE ON SCHEMA papercup_shared TO harness_admin;

    CREATE VIEW papercup_shared.briefings           AS SELECT * FROM papercusp_shared.briefings;
    CREATE VIEW papercup_shared.directive_summaries AS SELECT * FROM papercusp_shared.directive_summaries;
    CREATE VIEW papercup_shared.directives          AS SELECT * FROM papercusp_shared.directives;
    CREATE VIEW papercup_shared.message_comments    AS SELECT * FROM papercusp_shared.message_comments;
    CREATE VIEW papercup_shared.message_recipients  AS SELECT * FROM papercusp_shared.message_recipients;
    CREATE VIEW papercup_shared.messages            AS SELECT * FROM papercusp_shared.messages;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA papercup_shared TO harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA papercup_shared TO harness_app;
  END IF;
END $$;
