-- beekeeper-runner: the Apiary instance-level battery runner (P-003).
--
-- The Beekeeper runner executes the IQ battery corpus against ONE sealed papercusp
-- instance and persists scores + metrics to harness_shared.
-- Schema: instance manifests, battery runs, and collected metrics.

CREATE TABLE IF NOT EXISTS harness_shared.beekeeper_instances (
  instance_id         TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  code_sha            TEXT NOT NULL,
  genome_id           TEXT,
  memory_snapshot_id  TEXT,
  battery_slice_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code_sha, genome_id)
);

-- One battery case execution against an instance.
CREATE TABLE IF NOT EXISTS harness_shared.beekeeper_runs (
  run_id              TEXT PRIMARY KEY,
  instance_id         TEXT NOT NULL REFERENCES harness_shared.beekeeper_instances(instance_id) ON DELETE CASCADE,
  case_id             TEXT NOT NULL,
  case_variant        TEXT NOT NULL,
  case_title          TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  elapsed_ms          BIGINT,
  terminal_state      TEXT,
  deterministic_signals JSONB,
  trace_ref           TEXT,
  UNIQUE (instance_id, case_id)
);

-- Scored metrics for each run (P-002 collectors + IQ battery rubric).
CREATE TABLE IF NOT EXISTS harness_shared.beekeeper_scores (
  run_id              TEXT NOT NULL REFERENCES harness_shared.beekeeper_runs(run_id) ON DELETE CASCADE,
  judge_model         TEXT NOT NULL,
  rubric_hash         TEXT NOT NULL,
  judge_temp          REAL,
  weights             JSONB NOT NULL,
  -- IQ battery hard metrics (P-002).
  success             BOOLEAN,
  tokens_per_task     INTEGER,
  time_to_green_secs  INTEGER,
  first_attempt_pass  BOOLEAN,
  recurrence          INTEGER,
  escalation          BOOLEAN,
  recall_hit          INTEGER,
  -- Judge dimensions.
  d1                  REAL NOT NULL,
  d2                  REAL NOT NULL,
  d3                  REAL NOT NULL,
  composite           REAL NOT NULL,
  rationale           TEXT,
  scored_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, rubric_hash)
);

-- Instance battery session metadata (lineage, D-006).
CREATE TABLE IF NOT EXISTS harness_shared.beekeeper_sessions (
  session_id          TEXT PRIMARY KEY,
  instance_id         TEXT NOT NULL REFERENCES harness_shared.beekeeper_instances(instance_id) ON DELETE CASCADE,
  window_start        TIMESTAMPTZ NOT NULL,
  window_end          TIMESTAMPTZ,
  total_cases         INTEGER,
  passed_cases        INTEGER,
  failed_cases        INTEGER,
  mean_composite      REAL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS beekeeper_runs_instance_idx ON harness_shared.beekeeper_runs (instance_id);
CREATE INDEX IF NOT EXISTS beekeeper_runs_case_idx ON harness_shared.beekeeper_runs (case_id);
CREATE INDEX IF NOT EXISTS beekeeper_scores_run_idx ON harness_shared.beekeeper_scores (run_id);
CREATE INDEX IF NOT EXISTS beekeeper_sessions_instance_idx ON harness_shared.beekeeper_sessions (instance_id);
