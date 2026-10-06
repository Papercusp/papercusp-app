-- 1378: preserve test-run rows cited by immutable spec evidence.
--
-- The binding table intentionally keeps historical run IDs even when older runs
-- are already absent. NOT VALID preserves those legacy rows while enforcing the
-- relationship for new bindings and preventing any future delete of a cited run.
-- The BEFORE DELETE trigger skips only referenced rows so batch retention continues
-- pruning unbound runs instead of failing the whole DELETE statement.
CREATE INDEX IF NOT EXISTS spec_evidence_bindings_by_test_run
  ON harness_shared.spec_evidence_bindings (test_run_id)
  WHERE test_run_id IS NOT NULL;

-- Migration 855 deliberately left this column scalar. Add the FK without a
-- destructive drop; an existing same-named but different constraint fails closed.
DO $constraint_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'harness_shared.spec_evidence_bindings'::regclass
       AND c.conname = 'spec_evidence_bindings_test_run_id_fkey'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'harness_shared.spec_evidence_bindings'::regclass
         AND c.conname = 'spec_evidence_bindings_test_run_id_fkey'
         AND c.contype = 'f'
         AND c.confrelid = 'harness_shared.test_runs'::regclass
         AND c.conkey = ARRAY[
           (SELECT a.attnum
              FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'harness_shared.spec_evidence_bindings'::regclass
               AND a.attname = 'test_run_id'
               AND NOT a.attisdropped)
         ]::smallint[]
         AND c.confkey = ARRAY[
           (SELECT a.attnum
              FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'harness_shared.test_runs'::regclass
               AND a.attname = 'id'
               AND NOT a.attisdropped)
         ]::smallint[]
         AND c.confdeltype = 'r'
    ) THEN
      RAISE EXCEPTION 'spec_evidence_bindings_test_run_id_fkey exists with an incompatible definition';
    END IF;
  ELSE
    ALTER TABLE harness_shared.spec_evidence_bindings
      ADD CONSTRAINT spec_evidence_bindings_test_run_id_fkey
      FOREIGN KEY (test_run_id)
      REFERENCES harness_shared.test_runs (id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$constraint_guard$;

COMMENT ON COLUMN harness_shared.spec_evidence_bindings.test_run_id IS
  'Optional historical reference to test_runs.id. Existing legacy references are left unvalidated; new references are FK-checked, and cited test-run rows are retained so immutable proof keeps its exact source.';

CREATE OR REPLACE FUNCTION harness_shared.preserve_spec_bound_test_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM harness_shared.spec_evidence_bindings b
     WHERE b.test_run_id = OLD.id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS test_runs_preserve_spec_bound_evidence
  ON harness_shared.test_runs;
CREATE TRIGGER test_runs_preserve_spec_bound_evidence
  BEFORE DELETE ON harness_shared.test_runs
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.preserve_spec_bound_test_runs();
