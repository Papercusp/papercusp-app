-- 1153-test-runs-mutation-probe-source.sql — widen the durable test-run source vocabulary.
-- EI-22955349101740344: mutation probes are falsifiability evidence.
-- Keep their per-file rows bindable to a real test_runs id while separating
-- them from repository-health and release-gate populations by source.
--
-- FORWARD-COMPAT: this widens test_runs_source_valid while retaining every
-- value the deployed release can write (ci, local, admin-ui). Older writers
-- therefore remain accepted while the new mutation-probe writer rolls out.
-- The migration runner supplies the transaction around this file.

ALTER TABLE harness_shared.test_runs
  DROP CONSTRAINT IF EXISTS test_runs_source_valid;

ALTER TABLE harness_shared.test_runs
  ADD CONSTRAINT test_runs_source_valid CHECK (
    source IN ('ci', 'local', 'admin-ui', 'mutation-probe')
  );

COMMENT ON COLUMN harness_shared.test_runs.source IS
  'Writer origin: ci | local | admin-ui | mutation-probe. Mutation-probe rows are durable falsifiability evidence and must be excluded from health/gate populations.';
