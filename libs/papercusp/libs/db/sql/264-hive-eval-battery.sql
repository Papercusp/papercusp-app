-- hive-eval-battery (HE-03 of hive-run-evaluation-2026-06-13, P-021/P-022).
--
-- The Hive-run-evaluation battery is a SIBLING of the apiary IQ-battery (D-006/D-009): it
-- runs the WHOLE Hive (Queen + bees) on a seeded scenario in a throwaway hive and records
-- the run. Unlike the beekeeper's runs (UNIQUE instance_id, case_id — one run per case), this
-- slice keeps EVERY repeat — keyed (instance_id, scenario_id, repeat) — so a scenario's score
-- is a DISTRIBUTION, not a single point (P-022).
--
-- This migration records the raw, judge-free run (the harness's output). Scoring (the LLM
-- judge / composite / un-gameable gate) is HE-06 and adds its own hive_eval_scores table over
-- these runs (the beekeeper rubric-hash store pattern). Idempotent (CREATE TABLE IF NOT EXISTS).

-- The code generation under test (reuses the apiary InstanceManifest shape / lineage, D-006).
CREATE TABLE IF NOT EXISTS harness_shared.hive_eval_instances (
  instance_id       TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  code_sha          TEXT NOT NULL,
  genome_id         TEXT,
  battery_slice_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code_sha, genome_id)
);

-- The seeded corpus entries + their COMPUTED objective optimum (D-004), recorded so the trend
-- surface (HE-07) and the speed metrics (HE-05, critical-path ratio) read the ideal without
-- recomputing the DAG.
CREATE TABLE IF NOT EXISTS harness_shared.hive_eval_scenarios (
  scenario_id            TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  shape                  TEXT NOT NULL,
  ideal_wall_clock_units NUMERIC NOT NULL,
  ideal_bee_count        INTEGER NOT NULL,
  total_units            NUMERIC NOT NULL,
  critical_path          JSONB NOT NULL,
  work_item_count        INTEGER NOT NULL,
  planted_bug_location   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One whole-Hive run on a scenario (drained / timeout / failed). The raw deterministic
-- observations are promoted to columns for indexable trend reads + kept whole in `observations`.
CREATE TABLE IF NOT EXISTS harness_shared.hive_eval_runs (
  run_id               TEXT PRIMARY KEY,
  instance_id          TEXT NOT NULL REFERENCES harness_shared.hive_eval_instances(instance_id) ON DELETE CASCADE,
  scenario_id          TEXT NOT NULL,
  shape                TEXT NOT NULL,
  repeat               INTEGER NOT NULL,
  seed                 BIGINT NOT NULL,
  budget_usd_cap       NUMERIC,
  bee_cap              INTEGER,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  terminal_state       TEXT,            -- 'drained' | 'timeout' | 'failed'
  wall_clock_ms        BIGINT,          -- measured boot→drive wall-clock (speed numerator)
  frontier_drained     BOOLEAN,         -- did the Hive complete every work-item
  work_items_total     INTEGER,
  work_items_completed INTEGER,
  cost_usd             NUMERIC,
  observations         JSONB,           -- the whole raw-observation bag (HE-04/05 input)
  trace_ref            TEXT,            -- ref to the full trace (HE-06's judge reads it)
  UNIQUE (instance_id, scenario_id, repeat)
);

CREATE INDEX IF NOT EXISTS hive_eval_runs_instance_idx ON harness_shared.hive_eval_runs (instance_id);
CREATE INDEX IF NOT EXISTS hive_eval_runs_scenario_idx ON harness_shared.hive_eval_runs (scenario_id);
