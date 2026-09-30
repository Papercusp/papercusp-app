-- 428-worker-chunk-loop-outcomes-extended-metrics.sql —
-- worker-chunk-loop-operator-hosted-2026-06-14 P-020.
--
-- Extends harness_shared.worker_chunk_loop_outcomes (migration 397) with the three P-020
-- sub-metrics that weren't captured yet: file-lock CONTENTION, crash-RESUME success, and
-- per-chunk DURABILITY — plus broadening replan FREQUENCY to cover every run (not just
-- escalated ones). All additive columns, all nullable, no backfill needed (old rows simply
-- read as "unknown" for the new fields, which the aggregation already treats as excluded
-- from the relevant ratio rather than as a zero).
--
-- Lock-safety: plain `ADD COLUMN IF NOT EXISTS` with no DEFAULT and no NOT NULL — PG adds
-- a nullable column as a metadata-only change (no table rewrite, no ACCESS EXCLUSIVE hold
-- beyond the brief catalog update), safe on the in-use table. Idempotent + fresh-migrate-safe.

ALTER TABLE harness_shared.worker_chunk_loop_outcomes
  ADD COLUMN IF NOT EXISTS resumed BOOLEAN,                  -- crash-resume: true iff this run resumed a persisted, not-all-done plan after a crash/restart
  ADD COLUMN IF NOT EXISTS abort_reason TEXT,                -- aborted only: 'lock_contention' | 'scratch_setup' | 'replan_failed' | 'other'
  ADD COLUMN IF NOT EXISTS total_replans INT,                -- replans spent across the WHOLE run (vs replan_strikes, which is escalated-only and resets per chunk)
  ADD COLUMN IF NOT EXISTS chunks_committed_so_far INT,       -- chunks actually committed by the time this run ended, for ANY outcome kind (not just completed)
  ADD COLUMN IF NOT EXISTS total_chunks_planned INT;          -- size of the chunk plan this run was driving, for the per-chunk durability ratio

CREATE INDEX IF NOT EXISTS worker_chunk_loop_outcomes_abort_reason_idx
  ON harness_shared.worker_chunk_loop_outcomes (workspace_id, execution_path, abort_reason)
  WHERE abort_reason IS NOT NULL;
