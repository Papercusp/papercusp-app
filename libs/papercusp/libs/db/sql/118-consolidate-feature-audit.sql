-- Migration 118 — consolidate per-harness feature_audit → slug-keyed
-- harness_shared.feature_audit_consolidated, replacing the per-harness physical
-- tables with auto-updatable VIEWs (032 pattern). Part of
-- harness-state-storage-unification-2026-06-01 P-004 (D-007: consolidate).
--
-- Reality (verified 2026-06-03): feature_audit is dual-written — the canonical
-- row goes to feature_audit_consolidated (feature-audit.ts), and a best-effort
-- mirror goes to the per-harness feature_audit table. Per-harness holds 841 rows
-- vs 591 in consolidated, so ~250 mirror-only rows predate the dual-write and
-- must be backfilled (no natural key → dedup on the content tuple). Per-harness
-- shape is UNIFORM (17/17 have harness_slug + bigint ts), so no drift guard.
--
-- The writer (feature-audit.ts) is simplified in the same change to stop the
-- per-harness mirror insert — once feature_audit is a view over consolidated,
-- that insert would route back into consolidated and double-write.
--
-- Idempotent: re-running finds views (not tables), skips backfill, recreates views.

\set ON_ERROR_STOP on
BEGIN;

DO $mig$
DECLARE
  s    TEXT;
  slug TEXT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = s AND table_name = 'feature_audit' AND table_type = 'BASE TABLE'
    ) THEN
      -- Backfill rows not already in consolidated (content dedup; no natural key).
      -- IS NOT DISTINCT FROM handles NULL old_value/new_value/actor correctly.
      EXECUTE format($q$
        INSERT INTO harness_shared.feature_audit_consolidated
          (workspace_id, harness_slug, feature_id, ts, field, old_value, new_value, actor)
        SELECT 'default', ph.harness_slug, ph.feature_id, ph.ts, ph.field,
               ph.old_value, ph.new_value, ph.actor
          FROM %1$I.feature_audit ph
         WHERE NOT EXISTS (
           SELECT 1 FROM harness_shared.feature_audit_consolidated c
            WHERE c.harness_slug = ph.harness_slug
              AND c.feature_id  IS NOT DISTINCT FROM ph.feature_id
              AND c.ts           = ph.ts
              AND c.field        = ph.field
              AND c.actor      IS NOT DISTINCT FROM ph.actor
              AND c.old_value  IS NOT DISTINCT FROM ph.old_value
              AND c.new_value  IS NOT DISTINCT FROM ph.new_value
         )
      $q$, s);

      EXECUTE format('DROP TABLE IF EXISTS %I.feature_audit CASCADE', s);
    END IF;

    EXECUTE format('DROP VIEW IF EXISTS %I.feature_audit CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.feature_audit AS
        SELECT * FROM harness_shared.feature_audit_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    EXECUTE format('ALTER VIEW %I.feature_audit ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.feature_audit ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.feature_audit TO harness_app, harness_admin', s);
    BEGIN
      EXECUTE format('GRANT SELECT ON %I.feature_audit TO harness_zero', s);
    EXCEPTION WHEN OTHERS THEN
      -- harness_zero absent — skip.
    END;
  END LOOP;
END $mig$;

COMMIT;
