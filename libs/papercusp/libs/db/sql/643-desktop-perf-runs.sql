-- desktop-performance-suite-2026-07-20 P-010: persist per-run desktop-perf
-- measures for trend/regression detection + the admin testing UI trend surface.
--
-- One row per desktop-performance run (the in-app `desktop-performance` admin
-- suite, or the packaged-binary wdio runner). `measures` is the structured
-- per-metric array the suite emits (extractDesktopPerfMeasures); the release
-- gate (P-011) and the admin trend panel read the last-N rows and diff them.
--
-- Idempotent (CREATE ... IF NOT EXISTS). App-generated text id (perfrun-…) so
-- this carries no pgcrypto/uuid extension dependency, matching the admin
-- test-run id convention.

CREATE TABLE IF NOT EXISTS harness_shared.desktop_perf_runs (
  id           text PRIMARY KEY,
  workspace_id text   NOT NULL,
  created_ts   bigint NOT NULL,
  -- 'admin-suite' (the in-app desktop-performance suite) | 'wdio' (packaged binary)
  source       text   NOT NULL,
  -- worst per-run status across measures: 'pass' | 'warn' | 'fail'
  status       text   NOT NULL,
  git_sha      text,
  -- the admin test run id (testrun-…) when source='admin-suite'; null for wdio
  run_id       text,
  -- array of { key, value, unit, budget, ok } — the structured measures
  measures     jsonb  NOT NULL DEFAULT '[]'::jsonb
);

-- Trend/regression reads are always (workspace_id, newest-first).
CREATE INDEX IF NOT EXISTS desktop_perf_runs_ws_created_idx
  ON harness_shared.desktop_perf_runs (workspace_id, created_ts DESC);
