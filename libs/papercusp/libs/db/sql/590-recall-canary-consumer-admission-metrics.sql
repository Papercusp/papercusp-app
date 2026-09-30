-- Migration 590 — recall-canary: measure the zero-hit alarm AT THE CONSUMER (EI-10666).
--
-- The canary's `zero_hit_rate` used to mean "the backend search returned no rows". But between
-- the store and an agent sit the consumer-admission gates (relevance floor → queen-loop withhold
-- → aggregate char budget), and a hit those gates discard never reaches anyone. Scoring such a
-- probe as a HIT is not hypothetical: in EI-10372 the backend returned 5 rows, orient's relevance
-- floor dropped all 5, every agent's recall fold was EMPTY — and this canary would have reported
-- GREEN straight through the blackout it exists to catch.
--
-- So `zero_hit_rate` is REDEFINED as consumer-level (post-admission — what an agent actually
-- received), and these two columns keep the retrieval-level view as the DIAGNOSTIC that says
-- WHICH LAYER went dark:
--
--   zero_hit_rate ≈ retrieval_zero_hit_rate   ⇒ the STORE went dark (swallowed-error smell)
--   retrieval_zero_hit_rate ≪ zero_hit_rate   ⇒ the store was FINE and the GATES ate everything
--
-- One number cannot distinguish those, and they send you to opposite halves of the system.
--
-- Redefining an existing column's meaning is safe here, verified rather than assumed: the canary
-- never materialized its routine (EI-10625 — it was dead on arrival), so both canary tables are
-- EMPTY (0 runs, 0 sets as of 2026-07-12). There is no historical series to reinterpret.
--
-- Nullable + no backfill: 'decayed' runs score nothing and legitimately record NULL.

ALTER TABLE harness_shared.memory_live_recall_canary_run
  ADD COLUMN IF NOT EXISTS retrieval_zero_hit_rate double precision,
  ADD COLUMN IF NOT EXISTS retrieval_r_at_10 double precision;

COMMENT ON COLUMN harness_shared.memory_live_recall_canary_run.zero_hit_rate IS
  'EI-10666: fraction of scored probes after which a CONSUMER received nothing — retrieval empty '
  'OR the admission gates (floor/withhold/budget) discarded every hit. The number the alarm reads.';
COMMENT ON COLUMN harness_shared.memory_live_recall_canary_run.retrieval_zero_hit_rate IS
  'EI-10666 diagnostic: fraction of scored probes where the BACKEND returned nothing. Compare with '
  'zero_hit_rate to locate a blackout — equal ⇒ the store went dark; much lower ⇒ the gates ate it.';
COMMENT ON COLUMN harness_shared.memory_live_recall_canary_run.retrieval_r_at_10 IS
  'EI-10666 diagnostic: recall@10 against the RAW backend rows, before the consumer admission gates.';
