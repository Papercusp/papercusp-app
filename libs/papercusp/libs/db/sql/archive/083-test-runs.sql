-- 083-test-runs.sql
--
-- harness_shared.test_runs — per-file test invocation history backing
-- the /admin/testing tabs' status chips (P-008, plan
-- admin-testing-tab-restructure-2026-05-24).
--
-- One row per test FILE per RUN. Populated by:
--   - apps/operator/test/reporters/admin-test-runs-reporter.ts (vitest)
--   - matching Playwright + Cargo reporters (P-011 + P-012)
--   - admin-testing-run.ts route (source='admin-ui') when a user
--     hits the per-file Run button (P-014)
--
-- Per D-010, every row records its origin:
--   source       — 'ci' | 'local' | 'admin-ui'
--   branch       — git branch at run time (best-effort, null on failure)
--   commit_sha   — git HEAD at run time (best-effort, null on failure)
--
-- The file-status route (P-009) filters by
--   branch = currentBranch() OR source = 'admin-ui'
-- so the developer's chip reflects what's true on THEIR checkout,
-- not a flake from three-weeks-ago-on-main.
--
-- Retention (P-041): a daily cron prunes rows older than the last 50
-- per (file_path, branch). prune_test_runs() function ships here;
-- the timer lives next to the kopia backup user-timer.
--
-- Fail-soft contract (D-007): reporters MUST never throw if this
-- table is missing/unreachable. They wrap inserts in try/catch and
-- log-and-continue.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.test_runs (
  id             BIGSERIAL    PRIMARY KEY,
  file_path      TEXT         NOT NULL,
  framework      TEXT         NOT NULL,           -- vitest|playwright|cargo|node|shell|admin-suite
  status         TEXT         NOT NULL,           -- pass|fail|skip|cancelled|error
  duration_ms    BIGINT,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  output_tail    TEXT,                            -- last N stdout/stderr lines
  suite_id       TEXT,                            -- nullable; admin-suite invocations only
  run_group_id   TEXT,                            -- nullable; ties N files to one CLI run

  -- D-010: origin metadata for branch-scoped status filtering
  source         TEXT         NOT NULL DEFAULT 'local',  -- ci|local|admin-ui
  branch         TEXT,                            -- git branch at run time, nullable on resolution failure
  commit_sha     TEXT,                            -- git HEAD, nullable on resolution failure
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Defensive CHECKs that match the enum-like fields. PG ENUMs were
  -- considered and rejected — ALTERing them later is painful.
  CONSTRAINT test_runs_source_valid CHECK (source IN ('ci', 'local', 'admin-ui')),
  CONSTRAINT test_runs_status_valid CHECK (
    status IN ('pass', 'fail', 'skip', 'cancelled', 'error', 'running')
  )
);

-- Hot path: file-status route looks up the most recent row for one or
-- many file_paths, scoped by branch+source.
CREATE INDEX IF NOT EXISTS test_runs_file_path_idx
  ON harness_shared.test_runs (file_path, finished_at DESC);
CREATE INDEX IF NOT EXISTS test_runs_branch_idx
  ON harness_shared.test_runs (branch, finished_at DESC)
  WHERE branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS test_runs_source_idx
  ON harness_shared.test_runs (source, finished_at DESC);
CREATE INDEX IF NOT EXISTS test_runs_run_group_idx
  ON harness_shared.test_runs (run_group_id)
  WHERE run_group_id IS NOT NULL;

-- P-041: retention pruner. Called by the daily systemd-user timer
-- (alongside the existing kopia-backup timer). Keeps the last 50 runs
-- per (file_path, branch) pair; older rows are deleted.
-- Branch=NULL rows form their own bucket so untrackable runs (CI on a
-- detached HEAD, etc.) don't get prematurely pruned.
CREATE OR REPLACE FUNCTION harness_shared.prune_test_runs(
  keep_per_file_branch INTEGER DEFAULT 50
) RETURNS INTEGER
LANGUAGE plpgsql
AS $body$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY file_path, COALESCE(branch, '__null__')
             ORDER BY finished_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM harness_shared.test_runs
  )
  DELETE FROM harness_shared.test_runs
   WHERE id IN (SELECT id FROM ranked WHERE rn > keep_per_file_branch);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$body$;

COMMIT;
