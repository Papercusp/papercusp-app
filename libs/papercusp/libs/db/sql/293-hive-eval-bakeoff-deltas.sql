-- 293-hive-eval-bakeoff-deltas.sql
-- plan-implementation-framework-2026-06-15 P-014: one row per framework bake-off run (a flag A/B
-- result) — the persisted source the Learning/Benchmark tab's bake-off trend reads. Workspace-
-- scoped, newest-first by run_at_ms.
--
-- run_at_ms is epoch ms (a BIGINT, NOT timestamptz) on purpose: reads map straight to
-- BakeoffTrendRow.at (a number) with zero Date<->timestamptz coercion — the org PG client rejects a
-- raw JS Date param (see the `org-pg-client-rejects-raw-date` memory / store-pg.ts). created_at is a
-- timestamptz DEFAULT now() (a server default, never a bound Date), so it is safe.
--
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS); a re-run of the same bet appends a new row (id PK).
CREATE TABLE IF NOT EXISTS harness_shared.hive_eval_bakeoff_deltas (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          TEXT             NOT NULL,
  flag_key              TEXT             NOT NULL,
  delta_mean_composite  DOUBLE PRECISION NOT NULL,
  delta_gate_pass_rate  DOUBLE PRECISION NOT NULL,
  verdict               TEXT             NOT NULL,
  run_at_ms             BIGINT           NOT NULL,
  created_at            TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hive_eval_bakeoff_deltas_ws_run_idx
  ON harness_shared.hive_eval_bakeoff_deltas (workspace_id, run_at_ms DESC);
