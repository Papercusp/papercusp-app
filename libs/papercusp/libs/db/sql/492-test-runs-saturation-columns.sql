-- 492-test-runs-saturation-columns.sql
--
-- EI-4940 — Tests-tab test_runs don't flag host-saturation flakes. 16 of 24
-- "failing" files in a real Tests-tab triage were bare `Test timed out in
-- 60000ms` timeouts recorded during an overnight bg-host event-loop/RSS
-- saturation incident (WI-1089) — they passed fresh on the recovered box.
-- Nothing in test_runs distinguished a saturation-era timeout from a genuine
-- failure, so an agent had to re-run every red file to separate flakes from
-- real bugs.
--
-- Fix (first half of the proposal — the annotation): stamp each row with the
-- host's event-loop-lag p95 + process RSS AT RECORD TIME, read straight from
-- the already-running event-loop-lag-monitor.ts gauge (currentLoopLag()) and
-- process.memoryUsage(). A reviewer (or a future auto-retry / Tests-tab badge)
-- can then tell "the host was saturated when this ran" apart from "this is a
-- real red" without re-running anything.
--
--   loop_lag_p95_ms — currentLoopLag().p95Ms at persist time. NULL when no
--                     monitor was running on that process (older rows, or a
--                     process that never booted the gauge) — absence of
--                     signal, not a claim the host was calm.
--   rss_mb          — process.memoryUsage().rss / 1_048_576 at persist time.
--                     Same NULL semantics.
--
-- SAFE ON BOOT (additive, nullable, NO DEFAULT, NO new CHECK): existing rows
-- keep NULL for both; the operator's existing INSERT (which omits these
-- columns) keeps working unchanged.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS loop_lag_p95_ms real;

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS rss_mb real;

COMMENT ON COLUMN harness_shared.test_runs.loop_lag_p95_ms IS
  'EI-4940: event-loop p95 delay (ms) at persist time, from event-loop-lag-monitor.ts currentLoopLag(). NULL = no monitor was running on that process (not a claim the host was calm). >= the critical band (PAPERCUSP_LOOP_CRITICAL_MS, default 600ms) means a timeout-class failure on this row is likely a host-saturation artifact, not a genuine red.';
COMMENT ON COLUMN harness_shared.test_runs.rss_mb IS
  'EI-4940: process RSS (MB) at persist time, from process.memoryUsage(). NULL = not captured (older row). Context for loop_lag_p95_ms — a saturation window often carries elevated RSS too (WI-1089).';
