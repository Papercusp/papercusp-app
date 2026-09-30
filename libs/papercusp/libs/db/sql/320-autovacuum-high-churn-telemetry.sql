-- 320: per-table autovacuum tuning for high-churn telemetry tables
-- (infra-perf-reliability-audit-round4-2026-06-19 P-016, lane su-61e7e).
--
-- route_invocations (7d retention) and tool_invocations (14d) are append-mostly
-- telemetry whose retention DELETE runs as ONE daily batch at 04:00 (the
-- telemetry-retention routine). One day's batch is ~14% (route) / ~7% (tool) of
-- the table — BELOW the cluster-default autovacuum_vacuum_scale_factor of 0.2 — so
-- a single daily delete does not by itself cross the autovacuum trigger and dead
-- tuples accumulate across days, bloating heap + indexes. Observed live (round-4):
-- route_invocations 3GB heap + 3GB toast/idx at ~21M rows; tool_invocations 1.8GB
-- + 1.3GB at ~4.6M rows, both with last_autovacuum = NEVER between restarts.
--
-- Lower the per-table scale factors (+ modest absolute thresholds) so autovacuum
-- keeps pace with the daily churn instead of waiting for 20% bloat. Pure tuning —
-- no schema change, no table rewrite (catalog reloptions only, SHARE UPDATE
-- EXCLUSIVE). Fully reversible: `ALTER TABLE ... RESET (autovacuum_*)`. The values
-- were verified against real post-restart churn before applying (verify-before-fix,
-- round-2 D-001). IF EXISTS guards DBs provisioned before these tables exist.

ALTER TABLE IF EXISTS harness_shared.route_invocations
  SET (autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_scale_factor = 0.02,
       autovacuum_vacuum_threshold = 20000,
       autovacuum_analyze_threshold = 10000);

ALTER TABLE IF EXISTS harness_shared.tool_invocations
  SET (autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_scale_factor = 0.02,
       autovacuum_vacuum_threshold = 20000,
       autovacuum_analyze_threshold = 10000);
