-- 395-perf-regression-snapshots.sql — infra-perf-reliability-audit-round4-2026-06-19 P-013.
--
-- perf_regression_snapshots — ONE row per perf-regression rig tick (the periodic
-- SLO snapshot collectPerfRegressionSnapshot() persists). The DURABLE evidence
-- trail that turns the round-2/3/4 perf gains into a STANDING budget: a snapshot of
-- the four key reliability SLO metrics, captured + evaluated against PERF_REGRESSION_BUDGETS
-- on the existing improvement-watchdog cadence, so a silent regression (the
-- dispatch-orphan rate that crept to 91% with nothing watching) is caught.
--
-- The four tracked metrics (perf-regression-rig.ts):
--   loop_lag_p95_ms          — event-loop-lag p95 (currentLoopLag().p95Ms), the per-thread
--                              saturation signal (mirrors perf-budgets.ts eventLoopLagP95*).
--   conn_saturation_pct      — server-wide PG connection saturation (pgHealth().saturationPct).
--   dispatch_orphan_rate     — % of recent improvement_dispatches with outcome='orphaned'
--                              over a recent window (the silently-regressed metric, 0..1).
--   coord_open_escalations   — open-escalation backlog (coord_open_escalations row count).
-- `dispatch_sample` is the dispatch row count behind the orphan rate (the rate is
-- meaningless below a min sample; the rig gates on it). `breached` is the JSONB array
-- of the breaches this tick filed (metric, value, budget, tier) for the audit trail.
--
-- WHY a new table (reuse-first checked): watchdog_ticks (mig 202) records the watchdog's
-- OWN health (which collector ran/failed), not the per-metric SLO VALUES over time — there
-- is nowhere structured today that stores the loop-lag/saturation/orphan-rate/backlog series
-- so a regression is visible as a trend. perf-baselines (perf-budgets.ts) are fs JSON host
-- captures, not the PG-canonical reliability-SLO series this rig owns.
--
-- Conventions mirror watchdog_ticks / improvement_dispatches (workspace_id-scoped,
-- RLS workspace-isolation, harness_app/harness_zero grants).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.perf_regression_snapshots (
  workspace_id           text             NOT NULL,
  captured_at            timestamptz      NOT NULL DEFAULT now(),
  loop_lag_p95_ms        double precision,
  conn_saturation_pct    double precision,
  dispatch_orphan_rate   double precision,
  dispatch_sample        int,
  coord_open_escalations int,
  breached               jsonb,
  PRIMARY KEY (workspace_id, captured_at)
);

-- Primary read path: the recent SLO series for a workspace, newest first (a trend read
-- + the latest-snapshot lookup).
CREATE INDEX IF NOT EXISTS perf_regression_snapshots_ws_captured_idx
  ON harness_shared.perf_regression_snapshots (workspace_id, captured_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.perf_regression_snapshots TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.perf_regression_snapshots TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.perf_regression_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS perf_regression_snapshots_workspace_isolation ON harness_shared.perf_regression_snapshots;
CREATE POLICY perf_regression_snapshots_workspace_isolation ON harness_shared.perf_regression_snapshots
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
