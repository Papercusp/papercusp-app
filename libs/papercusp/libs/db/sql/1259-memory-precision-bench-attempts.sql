-- Migration 1259 — memory_precision_bench_attempts: one row per memory-precision monitor fire
--
-- WI-10004133 (residue of WI-10004117). memory_precision_bench (migration 312) only gets a row
-- when a bench run SUCCEEDS, so a fire that records nothing leaves no durable trace of WHY: the
-- monitor's `{ ran:false, skipReason, error }` reached only the user journal and
-- dbos.workflow_status, both of which age out in about three days. That is exactly why the
-- 2026-08-09 and 2026-08-16 empty fires could not be diagnosed afterwards.
--
-- This table records every fire's outcome, including the successful ones, so "the last fire
-- produced no row" always has an answer:
--   outcome   'recorded' (a memory_precision_bench row was written; row_id points at it),
--             'failed'   (the bench or the record step threw; stage + error say which and why),
--             'flag-off' (MEMORY_PRECISION_BENCH was off; nothing ran, by design).
--   stage     for 'failed' only: 'bench' (the isolated worker) or 'record' (the row insert).
--   jev_gate  whether this fire measured the Jev-gated push path (plan
--             jev-decision-model-integration-2026-09-29 P-008).
--
-- A sibling table rather than status/error columns on memory_precision_bench: every reader of
-- that table (the trend, the recall-drop baseline, the learning-loop activity ledger, the
-- efficacy read) treats a row as a measurement, and a failed attempt with null metrics would
-- silently skew each of them.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; additive only; fresh-migrate-safe.


CREATE TABLE IF NOT EXISTS harness_shared.memory_precision_bench_attempts (
  id            bigserial PRIMARY KEY,
  workspace_id  text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL,
  stage         text,
  error         text,
  row_id        bigint REFERENCES harness_shared.memory_precision_bench (id) ON DELETE SET NULL,
  jev_gate      boolean NOT NULL DEFAULT false,
  CONSTRAINT memory_precision_bench_attempts_outcome_check
    CHECK (outcome = ANY (ARRAY['recorded'::text, 'failed'::text, 'flag-off'::text])),
  CONSTRAINT memory_precision_bench_attempts_stage_check
    CHECK (stage IS NULL OR stage = ANY (ARRAY['bench'::text, 'record'::text])),
  -- A failure always says where and why; a non-failure never carries an error.
  CONSTRAINT memory_precision_bench_attempts_failed_shape_check
    CHECK ((outcome = 'failed') = (stage IS NOT NULL AND error IS NOT NULL))
);

-- The reads: newest attempt per workspace, and the newest failure per workspace.
CREATE INDEX IF NOT EXISTS memory_precision_bench_attempts_ws_at_idx
  ON harness_shared.memory_precision_bench_attempts (workspace_id, attempted_at DESC);

-- Workspace isolation + grants, mirroring 312-memory-precision-bench.sql.
ALTER TABLE harness_shared.memory_precision_bench_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_precision_bench_attempts_workspace_isolation ON harness_shared.memory_precision_bench_attempts;
CREATE POLICY memory_precision_bench_attempts_workspace_isolation ON harness_shared.memory_precision_bench_attempts
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.memory_precision_bench_attempts TO harness_app;
GRANT SELECT ON harness_shared.memory_precision_bench_attempts TO harness_zero;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.memory_precision_bench_attempts_id_seq TO harness_app;
