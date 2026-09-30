-- 296-bench-run-operational-store.sql
--
-- benchmark-evaluation-ui-2026-06-16 (P-001 / D-001): the OPERATIONAL live run
-- store the Evaluation UI reads + writes.
--
-- DISTINCT from the reproducibility cards (291 benchmark_rollout /
-- benchmark_run_result, 292 benchmark_fleet_run / benchmark_coord_event): those
-- are IMMUTABLE, firewall-gated (prereg_hash NOT NULL, deterministic rollout_id),
-- NOT-NULL-completion-metric rows for PUBLISHED, graded, reproducible results —
-- they cannot represent an in-flight run (status=running, no grade yet, an arm
-- like 'hive-realqueen' outside their CHECK). THIS store is MUTABLE +
-- lifecycle-driven (status running → done), lenient (metrics nullable while
-- in-flight), and holds the live run the UI streams via @papercusp/sync.
--
-- The columns mirror the on-disk PreservedArmRun / PreservedPerTask / CoordEvent
-- shapes (packages/operator-core/lib/external-bench/preserved-runs.ts) so the
-- file-dir → store import (one-way: dir → store, for preserved/CLI runs) is a 1:1
-- upsert. On grade-completion a bench_run MAY additionally emit reproducibility
-- rows via the existing emitRollout path; the soft `fleet_run_id` link records
-- that. NO FK to the reproducibility tables — the two stores have independent
-- lifecycles (a live run exists long before any reproducibility card).
--
-- LOCKED vocab (CHECK-enforced): status, source, task_status. OPEN text (no
-- CHECK, an evolving union): arm, suite, kind — mirrors migration 291's choice
-- (arm/suite/kind open; grader_status/modality locked).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe. Workspace
-- isolation via RLS + runtime-role grants mirror migration 291 / experiment_runs
-- (287). The operator connects as harness_admin (superuser, bypasses RLS).

-- ─── The run: one arm's pass over a task set (mirrors PreservedArmRun) ────────
CREATE TABLE IF NOT EXISTS harness_shared.bench_runs (
    -- run dir id / launch id (e.g. 'm3-realqueen-2026-06-16'). Global PK, mirroring
    -- benchmark_rollout.rollout_id — run ids embed timestamps/launch ids → unique.
    id                   text NOT NULL PRIMARY KEY,
    workspace_id         text NOT NULL,
    -- FleetArmId — OPEN union (hive-realqueen | fifo-noqueen | mini-swe-agent | …).
    arm                  text NOT NULL,
    -- '11-task-pilot' | 'swe-bench-pro-full' | 'custom:<hash>'.
    task_set_id          text NOT NULL,
    -- BenchSuite — OPEN union.
    suite                text NOT NULL DEFAULT 'swe-bench-pro',
    -- The model pin (opus, fail-closed — never silently downgraded).
    model                text NOT NULL,
    -- Lifecycle (LOCKED): pending → running → grading → done | error | cancelled.
    status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'grading',
                                           'done', 'error', 'cancelled')),
    -- How the row was created (LOCKED): 'ui' launch, 'cli' launcher, 'import'
    -- (one-way file-dir → store import of a preserved/CLI run).
    source               text NOT NULL DEFAULT 'ui'
                         CHECK (source IN ('ui', 'cli', 'import')),
    -- Headline rollup (computed on completion; jsonb so the shape can evolve
    -- additively — mirrors PreservedRunSummary).
    summary              jsonb,
    -- Live/rollup metrics (NULLABLE while in-flight; filled incrementally).
    task_count           integer,
    -- Tasks the grader returned a verdict for / marked resolved.
    graded_count         integer,
    resolved_count       integer,
    non_empty_diffs      integer,
    cost_usd             double precision,
    tokens_in            bigint,
    tokens_out           bigint,
    wall_ms              bigint,
    peak_concurrent_bees integer,
    -- Snapshot reconstructed from recovered fleet state (vs a clean live run).
    recovered            boolean NOT NULL DEFAULT false,
    run_error            text,
    -- The launch input (arms, task ids, cap, budget, model) — for
    -- re-run-with-same-config + the cost-estimate audit trail.
    config               jsonb,
    -- Soft link to the reproducibility fleet run, set when emitted (NO FK).
    fleet_run_id         text,
    -- The spawned hive home slug — for teardown + live-monitoring joins
    -- (spawned_agents / hive_placements).
    hive_slug            text,
    started_at           timestamptz,
    finished_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: a workspace's runs, newest-first (runs-list / history).
CREATE INDEX IF NOT EXISTS bench_runs_ws_created_idx
    ON harness_shared.bench_runs (workspace_id, created_at DESC);
-- Live-run lookups (the in-flight monitor).
CREATE INDEX IF NOT EXISTS bench_runs_ws_status_idx
    ON harness_shared.bench_runs (workspace_id, status);
-- Compare / history filtering by arm + task set.
CREATE INDEX IF NOT EXISTS bench_runs_ws_arm_taskset_idx
    ON harness_shared.bench_runs (workspace_id, arm, task_set_id);

-- ─── Per-task rows (mirrors PreservedPerTask + grader `resolved`) ────────────
CREATE TABLE IF NOT EXISTS harness_shared.bench_run_tasks (
    run_id           text NOT NULL
                     REFERENCES harness_shared.bench_runs (id) ON DELETE CASCADE,
    workspace_id     text NOT NULL,
    instance_id      text NOT NULL,
    -- Live per-task lifecycle (LOCKED): todo → in_progress → collected → graded.
    task_status      text NOT NULL DEFAULT 'todo'
                     CHECK (task_status IN ('todo', 'in_progress', 'collected',
                                            'graded', 'error')),
    -- Official grader verdict. NULL = not yet graded OR infra error (excluded
    -- from accuracy, never counted as a fail — METR discipline, mirrors 291).
    resolved         boolean,
    bee_id           text,
    disposition      text,
    stop_reason      text,
    generation_error text,
    tokens_in        bigint,
    tokens_out       bigint,
    cost_usd         double precision,
    turns            integer,
    wall_clock_ms    bigint,
    diff_bytes       integer,
    arm_meta         jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, instance_id)
);

CREATE INDEX IF NOT EXISTS bench_run_tasks_ws_run_idx
    ON harness_shared.bench_run_tasks (workspace_id, run_id);

-- ─── Coordination / event trace (mirrors CoordEvent; feeds the timeline) ─────
CREATE TABLE IF NOT EXISTS harness_shared.bench_run_events (
    event_id     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    run_id       text NOT NULL
                 REFERENCES harness_shared.bench_runs (id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    -- Ordering within the run (insertion order; the trace is replayed in seq).
    seq          bigint NOT NULL,
    -- CoordEvent.ts — ms epoch (ordering only; nullable).
    ts           bigint,
    -- CoordEventKind — OPEN text (placement | complete | rework | stranded_item |
    -- spawn | handoff | claim | … + the mechanical failure signals).
    kind         text NOT NULL,
    -- Acting agent / bee id.
    agent        text,
    -- The benchmark task this event relates to, if any.
    task_id      text,
    -- CoordEvent.detail + any additive payload.
    payload      jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bench_run_events_ws_run_seq_idx
    ON harness_shared.bench_run_events (workspace_id, run_id, seq);

-- ─── Workspace isolation (RLS), mirroring migration 291 ──────────────────────
ALTER TABLE harness_shared.bench_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.bench_run_tasks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.bench_run_events  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bench_runs_workspace_isolation ON harness_shared.bench_runs;
CREATE POLICY bench_runs_workspace_isolation ON harness_shared.bench_runs
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

DROP POLICY IF EXISTS bench_run_tasks_workspace_isolation ON harness_shared.bench_run_tasks;
CREATE POLICY bench_run_tasks_workspace_isolation ON harness_shared.bench_run_tasks
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

DROP POLICY IF EXISTS bench_run_events_workspace_isolation ON harness_shared.bench_run_events;
CREATE POLICY bench_run_events_workspace_isolation ON harness_shared.bench_run_events
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- ─── Runtime-role grants (mirror migration 291) ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.bench_runs       TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.bench_run_tasks  TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.bench_run_events TO harness_app;
GRANT SELECT ON harness_shared.bench_runs       TO harness_zero;
GRANT SELECT ON harness_shared.bench_run_tasks  TO harness_zero;
GRANT SELECT ON harness_shared.bench_run_events TO harness_zero;
-- The IDENTITY sequence on bench_run_events needs USAGE for harness_app inserts.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA harness_shared TO harness_app;
