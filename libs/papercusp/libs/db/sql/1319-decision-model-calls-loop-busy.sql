-- 1319-decision-model-calls-loop-busy.sql — how busy the calling thread was during a decision call.
-- EI-24748208098755918, plan jev-memory-timeouts-to-zero-2026-10-01 P-001.
--
-- A Jev call that times out could have been slow at the provider, or the answer
-- could have arrived on time and waited while our own thread was busy (a
-- synchronous spawn, a blocking file read, a long callback). The ledger had no way
-- to tell the two apart, so every timeout was a guess. These two columns record the
-- calling thread's event-loop activity over the call window (Node's
-- performance.eventLoopUtilization), measured by @papercusp/decision-model:
--
--   loop_busy_ms     — milliseconds the thread spent running code instead of
--                      waiting idle for I/O while this call was open;
--   loop_utilization — loop_busy_ms / call window, in [0, 1].
--
-- A timed-out call with high utilization was held up on our side; one with low
-- utilization was waiting on the provider or the network.
--
-- Nullable, no default: rows written before this migration, and hosts that turn the
-- measurement off, record NULL (not measured) rather than a fake zero.

ALTER TABLE harness_shared.decision_model_calls
  ADD COLUMN IF NOT EXISTS loop_busy_ms integer,
  ADD COLUMN IF NOT EXISTS loop_utilization real;

-- FORWARD-COMPAT: the dropped constraint is the one this migration creates (dropped only so a re-run is idempotent); no deployed release knows it exists.
ALTER TABLE harness_shared.decision_model_calls
  DROP CONSTRAINT IF EXISTS decision_model_calls_loop_busy_range;
ALTER TABLE harness_shared.decision_model_calls
  ADD CONSTRAINT decision_model_calls_loop_busy_range CHECK (
    (loop_busy_ms IS NULL OR loop_busy_ms >= 0)
    AND (loop_utilization IS NULL OR (loop_utilization >= 0 AND loop_utilization <= 1))
  );

COMMENT ON COLUMN harness_shared.decision_model_calls.loop_busy_ms IS
  'Milliseconds the calling thread''s event loop spent running code (not idle waiting on I/O) while the call was open. NULL = not measured (pre-1319 rows, or the host disabled the measurement).';
COMMENT ON COLUMN harness_shared.decision_model_calls.loop_utilization IS
  'loop_busy_ms divided by the call window, in [0, 1] (Node performance.eventLoopUtilization over the call). High on a timed-out call = our thread held the answer up; low = waiting on the provider or network. NULL = not measured.';
