-- 1285-decision-model-calls-surface.sql — which host surface made a decision call.
-- WI-10004485 (owner directive #1115: improve the Jev integration), step C.
--
-- decision_model_calls (1246) records WHO asked (`consumer`, e.g. memory-injection)
-- but not WHERE: the memory filter runs on several injection ports (initialize,
-- turn-start, mid-turn, and tool-call surfaces such as claim/create), and they
-- differ in whether the turn waits for the answer. Mid-turn never waits and is
-- ~78% of the calls, so without this column every timeout or drop rate is a blend
-- dominated by a port where the bound does not matter.
--
-- Nullable, no default: rows written before this migration, and callers that pass
-- no surface, record NULL (unattributed) rather than being defaulted to a surface
-- they might not be — the same contract as memory_recall_stats.client (770).
-- Values match memory_recall_stats.surface for the memory consumer.

ALTER TABLE harness_shared.decision_model_calls
  ADD COLUMN IF NOT EXISTS surface text;

COMMENT ON COLUMN harness_shared.decision_model_calls.surface IS
  'Host surface that made the call (memory-injection: initialize | turn-start | mid-turn | claim | create ...). NULL = unattributed (pre-1285 rows, or a caller that passed none).';
