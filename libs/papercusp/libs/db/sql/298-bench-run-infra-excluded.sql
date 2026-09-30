-- 298-bench-run-infra-excluded.sql
--
-- benchmark-fairness-fix: make the bench-run resolved% metric FAIR.
--
-- The audit found external/transient failures (429 / gateway contention, wall-clock
-- timeout, drain-unsettled-under-contention, infra errors) were being scored as agent
-- capability-failures in the resolved% denominator. The fix excludes those rows from
-- the denominator (treated as resolved=null, never a fail) and reports them SEPARATELY.
--
-- This adds the `infra_excluded` rollup column on bench_runs so the count of NON-SCORED
-- (external/transient/infra) per-task rows is surfaced alongside graded_count/resolved_count
-- — the live mirror of bench-metrics' `infraErrors`. The rollup logic lives in
-- run-store.ts:rollupBenchRunMetrics (it now derives scored-ness from stop_reason +
-- generation_error and excludes the non-scored rows from graded_count).
--
-- Additive, idempotent, fresh-migrate-safe (ADD COLUMN IF NOT EXISTS).

ALTER TABLE harness_shared.bench_runs
    ADD COLUMN IF NOT EXISTS infra_excluded integer;
