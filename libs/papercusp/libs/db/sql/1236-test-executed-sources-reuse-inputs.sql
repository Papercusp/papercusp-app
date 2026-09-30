-- 1236-test-executed-sources-reuse-inputs.sql — per-file pass reuse inputs
-- gate-file-level-test-reuse-2026-09-27 P-008/P-009 (WI-10003476; decisions D-003, D-004).
--
-- A test_executed_sources row is already a per-file PASS proof: the reporter records only a
-- passed, isolated test file from a clean checkout, with the modules vitest executed for it.
-- The gate can therefore SKIP a file at judged sha T when nothing that file depends on
-- changed since the proof's sha. "Depends on" must cover more than the executed modules,
-- so these columns carry the rest of the proof. Each is additive and nullable or defaulted,
-- so the currently-deployed release (which never reads them) is unaffected.
--
--   read_paths       repo-relative paths the test read at runtime through node:fs (P-009).
--                    A path ending in '/' is a directory read and matches any change under it.
--   inputs_captured  true only when the runtime input capture was live for this run. A row
--                    without it can never be reused: its non-module inputs are unknown.
--   opaque_reasons   why this proof cannot be reused whatever the drift (a child process was
--                    spawned, the capture failed, ...). Empty = reusable in principle.
--   run_context      which runner class recorded the row ('green-checkpoint', 'clean-local').
--                    Reuse only consumes rows from its own context (same env class).
--   runner_identity  node version + platform + arch of the recording worker.

ALTER TABLE harness_shared.test_executed_sources
  ADD COLUMN IF NOT EXISTS read_paths      text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS inputs_captured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opaque_reasons  text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS run_context     text,
  ADD COLUMN IF NOT EXISTS runner_identity text;

COMMENT ON COLUMN harness_shared.test_executed_sources.read_paths IS
  'repo-root-relative POSIX paths read at runtime via node:fs (P-009); a trailing / marks a directory read. Sorted, de-duplicated.';
COMMENT ON COLUMN harness_shared.test_executed_sources.inputs_captured IS
  'true only when the runtime input capture was live for this run; a row without it is never reused (gate-file-level-test-reuse-2026-09-27 D-004).';
COMMENT ON COLUMN harness_shared.test_executed_sources.opaque_reasons IS
  'reasons this pass proof cannot be reused regardless of drift (e.g. child-process); empty = reusable in principle.';
COMMENT ON COLUMN harness_shared.test_executed_sources.run_context IS
  'runner class that recorded the row (green-checkpoint | clean-local); reuse consumes only its own context.';
COMMENT ON COLUMN harness_shared.test_executed_sources.runner_identity IS
  'node version + platform + arch of the recording worker (e.g. v22.12.0 linux x64).';
