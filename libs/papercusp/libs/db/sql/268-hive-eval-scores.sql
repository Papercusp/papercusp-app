-- hive-eval-scores (HE-06 of hive-run-evaluation-2026-06-13, P-040/P-041).
--
-- The SCORE layer over the judge-free runs migration 264 recorded. One row per
-- (run, rubric): the gated, floor-capped composite plus the deterministic-floor signals
-- (P-041) promoted to columns for indexable trend reads, and the whole HiveScore detail
-- (per-axis sub-scores + the `why`s + the gate reason) kept in `detail`.
--
-- Keyed (run_id, rubric_hash) — the beekeeper rubric-hash store pattern (D-006/D-011): re-scoring
-- the same run under the same rubric is an idempotent overwrite; a rubric change writes a distinct
-- row, so scores under different rubrics never silently mix. Deliberately its OWN table referencing
-- hive_eval_runs (NOT beekeeper_scores) so hive-run scores never contaminate the apiary instance
-- trend (D-011). Idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS harness_shared.hive_eval_scores (
  run_id              TEXT NOT NULL REFERENCES harness_shared.hive_eval_runs(run_id) ON DELETE CASCADE,
  rubric_hash         TEXT NOT NULL,
  rubric_version      TEXT NOT NULL,
  -- D-002 gate: efficiency/speed credit is zeroed unless the run did a good job.
  outcome_gate_passed BOOLEAN NOT NULL,
  efficiency_score    NUMERIC NOT NULL,
  speed_score         NUMERIC NOT NULL,
  -- the gated, floor-capped 0–10 composite (the headline; computed, never judge-raised).
  composite           NUMERIC NOT NULL,
  -- advisory LLM-judge composite — recorded, never folded into `composite` (P-041).
  judge_composite     NUMERIC,
  -- ── the deterministic floor signals (P-041), promoted for indexable trend reads ──
  regressions         BOOLEAN NOT NULL,
  planted_bug_caught  BOOLEAN NOT NULL,
  fabrication_detected BOOLEAN NOT NULL,
  critical_path_ratio NUMERIC NOT NULL,
  floor_ceiling       NUMERIC NOT NULL,
  detail              JSONB NOT NULL,   -- the whole HiveScore (per-axis components + why + gate reason)
  scored_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, rubric_hash)
);

CREATE INDEX IF NOT EXISTS hive_eval_scores_run_idx ON harness_shared.hive_eval_scores (run_id);
CREATE INDEX IF NOT EXISTS hive_eval_scores_composite_idx ON harness_shared.hive_eval_scores (composite);
