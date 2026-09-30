\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
  harness_slug      TEXT NOT NULL,
  issue_id          TEXT NOT NULL,
  title             TEXT NOT NULL,
  severity          TEXT NOT NULL,
  source            TEXT NOT NULL,
  status            TEXT NOT NULL,
  found_at          TIMESTAMPTZ NOT NULL,
  found_during      TEXT,
  repro             TEXT,
  evidence          TEXT,
  suggested_fix     TEXT,
  code_pointer      TEXT,
  linked_feature_id TEXT,
  attempts          BIGINT NOT NULL DEFAULT 0,
  notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_ts        BIGINT NOT NULL,
  updated_ts        BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, issue_id)
);

CREATE INDEX IF NOT EXISTS hic_severity_idx ON harness_shared.harness_issues_consolidated (harness_slug, severity);
CREATE INDEX IF NOT EXISTS hic_status_idx   ON harness_shared.harness_issues_consolidated (harness_slug, status);
CREATE INDEX IF NOT EXISTS hic_linked_idx   ON harness_shared.harness_issues_consolidated (linked_feature_id);
CREATE INDEX IF NOT EXISTS hic_found_during_idx ON harness_shared.harness_issues_consolidated (found_during);

CREATE OR REPLACE FUNCTION harness_shared.sync_issues_consolidated()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_issues_consolidated
      WHERE harness_slug = OLD.harness_slug AND issue_id = OLD.issue_id;
    RETURN OLD;
  END IF;
  INSERT INTO harness_shared.harness_issues_consolidated (
    harness_slug, issue_id, title, severity, source, status, found_at,
    found_during, repro, evidence, suggested_fix, code_pointer,
    linked_feature_id, attempts, notes, created_ts, updated_ts
  ) VALUES (
    NEW.harness_slug, NEW.issue_id, NEW.title, NEW.severity, NEW.source,
    NEW.status, NEW.found_at, NEW.found_during, NEW.repro, NEW.evidence,
    NEW.suggested_fix, NEW.code_pointer, NEW.linked_feature_id,
    NEW.attempts, NEW.notes, NEW.created_ts, NEW.updated_ts
  )
  ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
    title             = EXCLUDED.title,
    severity          = EXCLUDED.severity,
    source            = EXCLUDED.source,
    status            = EXCLUDED.status,
    found_at          = EXCLUDED.found_at,
    found_during      = EXCLUDED.found_during,
    repro             = EXCLUDED.repro,
    evidence          = EXCLUDED.evidence,
    suggested_fix     = EXCLUDED.suggested_fix,
    code_pointer      = EXCLUDED.code_pointer,
    linked_feature_id = EXCLUDED.linked_feature_id,
    attempts          = EXCLUDED.attempts,
    notes             = EXCLUDED.notes,
    created_ts        = EXCLUDED.created_ts,
    updated_ts        = EXCLUDED.updated_ts;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE s TEXT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    BEGIN
      EXECUTE format($f$
        DROP TRIGGER IF EXISTS sync_issues_consolidated_trg ON %1$I.harness_issues;
        CREATE TRIGGER sync_issues_consolidated_trg
          AFTER INSERT OR UPDATE OR DELETE ON %1$I.harness_issues
          FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_issues_consolidated();
      $f$, s);
      EXECUTE format(
        'INSERT INTO harness_shared.harness_issues_consolidated SELECT * FROM %I.harness_issues ON CONFLICT (harness_slug, issue_id) DO NOTHING',
        s
      );
    EXCEPTION WHEN OTHERS THEN
      -- Schema lacks harness_issues — skip silently.
    END;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_issues_consolidated TO harness_app;
GRANT SELECT ON harness_shared.harness_issues_consolidated TO harness_zero;


COMMENT ON TABLE harness_shared.harness_issues_consolidated IS
  'Canonical store for harness issues. (Migration 030) Trigger-mirrored from per-harness harness_<slug>.harness_issues until writers move; per-harness tables drop in a later migration.';

COMMIT;
