-- 1132-executed-source-map.sql — per-test-file executed-source map
-- gate-latency-selection-and-retry-policy-2026-09-06 P-002.
--
-- The static import index (scripts/lib/related-tests.mjs) selects every test whose
-- transitive closure reaches a changed file. Through barrels that closure is a large
-- SUPERSET of what a test actually loads, so a one-file change still selects thousands
-- of tests that never execute it. vitest observes the true executed set per test file
-- (TestModule.diagnostic().importDurations); the reporter in
-- libs/test-config/src/executed-source-map-reporter.ts records it here, and the
-- selector prunes a statically selected test ONLY when its recorded map is current
-- (nothing in its closure changed between recorded_sha and the judged sha) and the
-- executed set misses the change.
--
-- One row per (workspace, test file, recorded sha). The reporter only writes from a
-- CLEAN checkout (a dirty tree has no sha that describes what ran), and the selector
-- reads the newest row per test file. Additive: new table, no existing relation touched.

CREATE TABLE IF NOT EXISTS harness_shared.test_executed_sources (
  -- npm workspace name the run belonged to, e.g. '@papercusp/operator-core'
  workspace_name   text        NOT NULL,
  -- repo-root-relative POSIX path of the test file
  test_file        text        NOT NULL,
  -- HEAD of the clean checkout the run executed in
  recorded_sha     text        NOT NULL,
  -- repo-root-relative POSIX paths of every non-external module vitest executed for
  -- this test file (the test file itself included)
  executed_modules text[]      NOT NULL,
  module_count     integer     NOT NULL,
  -- PAPERCUSP_TEST_RUN_GROUP of the recording run, when one was stamped
  run_group_id     text,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_name, test_file, recorded_sha),
  CONSTRAINT test_executed_sources_sha_shape CHECK (recorded_sha ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT test_executed_sources_count_matches CHECK (module_count = cardinality(executed_modules))
);

-- The selector's read: newest row per (workspace, test file).
CREATE INDEX IF NOT EXISTS test_executed_sources_newest_idx
  ON harness_shared.test_executed_sources (workspace_name, test_file, recorded_at DESC);

COMMENT ON TABLE harness_shared.test_executed_sources IS
  'P-002 gate-latency: modules vitest actually executed per test file at a recorded sha; consumed by scripts/lib/related-tests.mjs pruneWithExecutedMap to remove hub-fan-out over-selection. Written only from a clean checkout by libs/test-config/src/executed-source-map-reporter.ts.';
COMMENT ON COLUMN harness_shared.test_executed_sources.executed_modules IS
  'repo-root-relative POSIX paths, non-external modules only, test file included; sorted, de-duplicated';
