-- harness_gym — the gym controller's experiment store (P-012).
--
-- Gym-PG-resident (D-018): this migration is applied by the migration runner ONLY to
-- the dedicated gym Postgres database (see schema.ts applyGymSchema), NOT to the live
-- operator DB and NOT part of the live 000-baseline / sql-NNN sequence. It follows the
-- "schema = migrations only, no runtime DDL" rule (CLAUDE.md / self-contained-migration-
-- baseline-2026-06-02): the DDL lives in this file and is applied by the runner, never
-- via an inline ensureXxx() in TS. Idempotent (CREATE ... IF NOT EXISTS).

CREATE SCHEMA IF NOT EXISTS harness_gym;

-- The dedicated gym database applies the shared control-plane migrations before
-- this gym-owned file, but older test/provision paths may stop before the
-- additive provenance columns. Converge those paths here as well so every
-- proposal written by the loop has the same candidate-verdict surface.
DO $control_plane$ BEGIN
  IF to_regclass('harness_shared.gym_proposals') IS NOT NULL THEN
    ALTER TABLE harness_shared.gym_proposals
      ADD COLUMN IF NOT EXISTS task_corpus text NOT NULL DEFAULT 'synthetic',
      ADD COLUMN IF NOT EXISTS candidate_verdict jsonb;
  END IF;
END $control_plane$;

-- Synthetic feature tasks, by pool (D-013/D-014).
CREATE TABLE IF NOT EXISTS harness_gym.gym_tasks (
  task_id      TEXT PRIMARY KEY,
  pool         TEXT NOT NULL CHECK (pool IN ('train','dev-anchor','monitor','probe','real-anchor')),
  repo_url     TEXT NOT NULL,
  repo_commit  TEXT NOT NULL,
  spec         TEXT NOT NULL,
  intent       TEXT NOT NULL,
  planted_bug  JSONB,
  generated_by TEXT,
  metadata     JSONB,
  -- Which corpus this task belongs to (gym-real-fitness-signal-2026-07-27 P-003).
  -- 'synthetic' = a generated stub substrate that proves only the MECHANISM;
  -- 'real' = derived from genuinely shipped work with a known outcome. Defaults to
  -- 'synthetic' so an unlabelled task can never inflate a champion's provenance,
  -- and rides the durable copy into harness_gym_durable.gym_tasks.corpus, which the
  -- `fitness-signal-is-real` release gate reads.
  corpus       TEXT NOT NULL DEFAULT 'synthetic' CHECK (corpus IN ('synthetic','real')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent add for gym DBs provisioned before P-003 (this file is re-applied per
-- ephemeral gym boot, but a long-lived gym DB may predate the column).
ALTER TABLE harness_gym.gym_tasks
  ADD COLUMN IF NOT EXISTS corpus TEXT NOT NULL DEFAULT 'synthetic';

-- Prompt-overlay variants + lineage (D-010/D-015). models is reserved (D-015).
CREATE TABLE IF NOT EXISTS harness_gym.gym_variants (
  variant_id         TEXT PRIMARY KEY,
  parent_id          TEXT REFERENCES harness_gym.gym_variants(variant_id) ON DELETE SET NULL,
  label              TEXT NOT NULL,
  prompt_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  models             JSONB,
  diff_from_parent   TEXT,
  proposer_rationale TEXT,
  status             TEXT NOT NULL DEFAULT 'candidate',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One (variant x task x cycle x repeat) hermetic run. terminal_state is observability (D-011).
-- `repeat` is the P-014 variance sample index (the gym is doubly-stochastic, so we run a
-- (variant,task,cycle) several times and measure judge-composite variance, D-013); each
-- repeat is its own throwaway harness, so the uniqueness key includes it.
CREATE TABLE IF NOT EXISTS harness_gym.gym_runs (
  run_id                TEXT PRIMARY KEY,
  variant_id            TEXT NOT NULL REFERENCES harness_gym.gym_variants(variant_id) ON DELETE CASCADE,
  task_id               TEXT NOT NULL REFERENCES harness_gym.gym_tasks(task_id) ON DELETE CASCADE,
  cycle                 INT NOT NULL DEFAULT 0,
  repeat                INT NOT NULL DEFAULT 0,
  harness_slug          TEXT,
  workflow_id           TEXT,
  terminal_state        TEXT,
  deterministic_signals JSONB,
  trace_ref             TEXT,
  distilled_ref         TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  elapsed_ms            BIGINT,
  UNIQUE (variant_id, task_id, cycle, repeat)
);

-- Frozen Opus judge output; re-judge-from-cache keyed on rubric_hash (P-010/D-016).
CREATE TABLE IF NOT EXISTS harness_gym.gym_scores (
  run_id      TEXT NOT NULL REFERENCES harness_gym.gym_runs(run_id) ON DELETE CASCADE,
  judge_model TEXT NOT NULL,
  rubric_hash TEXT NOT NULL,
  judge_temp  REAL,
  weights     JSONB NOT NULL,
  d1          REAL NOT NULL,
  d2          REAL NOT NULL,
  d3          REAL NOT NULL,
  composite   REAL NOT NULL,
  rationale   TEXT,
  scored_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, rubric_hash)
);

-- Loop audit trail (Phase 5).
CREATE TABLE IF NOT EXISTS harness_gym.gym_cycles (
  cycle_id         TEXT PRIMARY KEY,
  cycle            INT NOT NULL,
  parent_id        TEXT REFERENCES harness_gym.gym_variants(variant_id) ON DELETE SET NULL,
  candidate_id     TEXT REFERENCES harness_gym.gym_variants(variant_id) ON DELETE SET NULL,
  decision         TEXT,
  gate_results     JSONB,
  budget_spent_usd NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The frozen run-params that make variants comparable (D-016).
CREATE TABLE IF NOT EXISTS harness_gym.gym_runs_params (
  run_id           TEXT PRIMARY KEY REFERENCES harness_gym.gym_runs(run_id) ON DELETE CASCADE,
  harness_commit   TEXT NOT NULL,
  substrate_commit TEXT NOT NULL,
  mutable_roles    JSONB,
  judge_model      TEXT,
  judge_temp       REAL,
  weights          JSONB,
  rubric_hash      TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gym_runs_variant_idx ON harness_gym.gym_runs (variant_id);
CREATE INDEX IF NOT EXISTS gym_runs_task_idx ON harness_gym.gym_runs (task_id);
CREATE INDEX IF NOT EXISTS gym_runs_cycle_idx ON harness_gym.gym_runs (cycle);
CREATE INDEX IF NOT EXISTS gym_scores_run_idx ON harness_gym.gym_scores (run_id);
CREATE INDEX IF NOT EXISTS gym_tasks_pool_idx ON harness_gym.gym_tasks (pool);
