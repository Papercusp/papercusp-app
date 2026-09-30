-- 315-tool-invocations-invoked-at-cov-idx.sql
--
-- infra round-3 F4 (plan infra-perf-reliability-audit-round3-2026-06-19, P-006):
-- dev:telemetry's cross-workspace rollup
--   SELECT tool_name, count(*), percentile_cont(...) WITHIN GROUP (ORDER BY duration_ms)
--   FROM harness_shared.tool_invocations WHERE invoked_at > $since GROUP BY tool_name
-- TIMED OUT over a 24h window (>30s, MCP-budget). The only invoked_at index was
-- (workspace_id, harness_slug, invoked_at DESC) — leading on workspace, so a
-- cross-workspace query (workspaceIds = null) could not range-scan on invoked_at;
-- it broad-bitmap-scanned ~354k rows + heap-fetched + sorted them.
--
-- This covering index leads on invoked_at and INCLUDEs the three columns the
-- rollup needs, so the 24h query becomes an Index-Only Scan + in-memory sort.
-- Live-verified on the dev box: 30s+ timeout -> 225ms Execution Time.
--
-- Idempotent (IF NOT EXISTS): a no-op on the dev box (built live via
-- CREATE INDEX CONCURRENTLY), instant on a freshly-provisioned frame (empty table).
-- Non-concurrent here is fine: migrations run at boot/provision before load, and
-- IF NOT EXISTS skips it where the index already exists. The same index also
-- speeds the spawn-rollup (GROUP BY spawn_id) queries in dev-data.ts.

CREATE INDEX IF NOT EXISTS tool_invocations_invoked_at_cov_idx
  ON harness_shared.tool_invocations (invoked_at DESC)
  INCLUDE (tool_name, duration_ms, status);
