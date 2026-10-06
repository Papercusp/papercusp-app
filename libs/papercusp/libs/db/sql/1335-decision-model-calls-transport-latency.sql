-- 1335-decision-model-calls-transport-latency.sql — the provider's share of a decision call.
-- EI-24748208098755918, plan jev-memory-timeouts-to-zero-2026-10-01 P-008.
--
-- Jev calls now run on a worker thread (@papercusp/decision-model
-- createWorkerTransport), so the provider round trip no longer waits on the busy
-- calling thread. latency_ms stays what the CALLER saw: request to outcome, including
-- any time the finished answer waited for the calling thread. This column records what
-- the WORKER saw: request sent to complete response read, off the calling thread.
--
--   transport_latency_ms ~ latency_ms           → the time was spent at the provider or network;
--   transport_latency_ms << latency_ms          → the answer was ready and waited for our thread.
--
-- Nullable, no default: NULL = not measured (pre-1335 rows, an in-thread transport
-- such as the fallback, or a call that got no response, e.g. a timeout).

ALTER TABLE harness_shared.decision_model_calls
  ADD COLUMN IF NOT EXISTS transport_latency_ms integer;

-- FORWARD-COMPAT: the dropped constraint is the one this migration creates (dropped only so a re-run is idempotent); no deployed release knows it exists.
ALTER TABLE harness_shared.decision_model_calls
  DROP CONSTRAINT IF EXISTS decision_model_calls_transport_latency_range;
ALTER TABLE harness_shared.decision_model_calls
  ADD CONSTRAINT decision_model_calls_transport_latency_range CHECK (
    transport_latency_ms IS NULL OR transport_latency_ms >= 0
  );

COMMENT ON COLUMN harness_shared.decision_model_calls.transport_latency_ms IS
  'Request-sent to response-complete time measured on the transport''s worker thread, off the calling thread (P-008). Compare with latency_ms: close = provider or network time; much smaller = the answer waited for the calling thread. NULL = not measured (pre-1335 rows, in-thread transport, or no response).';
