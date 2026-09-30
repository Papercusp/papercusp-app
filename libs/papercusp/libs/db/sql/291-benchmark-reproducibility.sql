-- 291-benchmark-reproducibility.sql
--
-- impartial-benchmark-suite-2026-06-15 (BRIEF 8 / P-010): the reproducibility
-- harness storage. Three layers, co-owned with P-011 (cost/scoring,
-- @papercusp/bench-metrics):
--
--   benchmark_run_result — the per-(task × arm × seed) scoreable+provenance row.
--     Mirrors @papercusp/bench-metrics `TaskRunResult` 1:1 (P-011 owns the TS
--     type; P-010 owns this table + the emit path since P-010 emits). Written by
--     emitRollout(); read by P-011's buildSuiteReport() + the P-020 Evaluation UI
--     (sync `evals.runs`/`evals.suites`). `resolved` is NULLABLE: null ≠ false —
--     a null row was never genuinely graded (generation or grader INFRA failure)
--     and is excluded from accuracy, not counted as a fail (METR discipline).
--
--   benchmark_rollout — the Rollout-Card repro artifact, 1:1 with a run_result
--     (shared `rollout_id`). Holds the full config snapshot, exact model/harness
--     versions + git sha, env fingerprint, the VERBATIM raw grader output, the
--     graded submission (diff/env-ref), and the trajectory pointer. This is the
--     published unit of reproducibility (Rollout Cards, arXiv 2605.12131).
--
--   benchmark_prereg — the pre-registered run config, content-hashed
--     (`prereg_hash` = sha256 of the canonical config) and committed to git
--     BEFORE the run (file_path under benchmarks/preregistrations/). Every
--     run_result.prereg_hash MUST match a prereg row — that is the tune-to-test
--     firewall enforced in emitRollout().
--
-- `rollout_id` is DETERMINISTIC = sha256(run_id ∥ suite ∥ task_id ∥ arm ∥ seed),
-- so a re-emit of the same attempt UPSERTs cleanly (idempotent).
--
-- LOCKED vocab (CHECK-enforced, matches @papercusp/bench-metrics ArmId /
-- GraderStatus / GenerationStatus / GraderModality): arm, modality,
-- grader_status, generation_status. `suite` stays open text (BenchSuite is an
-- open union; new families add a literal, no migration).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe. Workspace
-- isolation via RLS, mirroring experiment_runs (287) / replay_runs (247).

-- ─── Layer 3: pre-registration (git-committed before the run) ────────────────
CREATE TABLE IF NOT EXISTS harness_shared.benchmark_prereg (
    -- sha256 (lowercase hex) of the canonical-JSON run config — the content id.
    prereg_hash      text NOT NULL PRIMARY KEY,
    -- One prereg per pilot execution.
    run_id           text NOT NULL,
    workspace_id     text NOT NULL,
    -- Human label, e.g. 'pilot-2026-06-15'.
    label            text,
    -- The suites this run covers (string[] as jsonb).
    suites           jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The canonical run config (arms, task set, seeds, budgets, model params,
    -- grader versions) — the exact design pre-registered before any result.
    config           jsonb NOT NULL,
    -- Where the committed file lands: benchmarks/preregistrations/<run_id>.json.
    file_path        text NOT NULL,
    -- Set true once verifyPreregistration() confirms the file is in git history.
    git_committed    boolean NOT NULL DEFAULT false,
    -- The commit that introduced the prereg file (set by verifyPreregistration).
    git_commit_sha   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- One prereg per run_id (the design is fixed for the whole pilot).
    UNIQUE (workspace_id, run_id)
);

CREATE INDEX IF NOT EXISTS benchmark_prereg_ws_run_idx
    ON harness_shared.benchmark_prereg (workspace_id, run_id);

-- ─── Layer 2: the Rollout Card (repro artifact, 1:1 with a run_result) ───────
CREATE TABLE IF NOT EXISTS harness_shared.benchmark_rollout (
    -- = sha256(run_id ∥ suite ∥ task_id ∥ arm ∥ seed). Shared with run_result.
    rollout_id        text NOT NULL PRIMARY KEY,
    run_id            text NOT NULL,
    workspace_id      text NOT NULL,
    prereg_hash       text NOT NULL,
    suite             text NOT NULL,
    task_id           text NOT NULL,
    arm               text NOT NULL,
    seed              integer NOT NULL,
    -- The resolved per-run config incl. arm settings + model params.
    config_snapshot   jsonb,
    model_id          text NOT NULL,
    -- Exact provider model version string if distinct from model_id.
    model_version     text,
    harness_version   text NOT NULL,
    -- Exact tree sha the harness ran from.
    harness_git_sha   text,
    -- os / node / docker image digests / grader image digest.
    env_fingerprint   jsonb,
    grader_family     text NOT NULL,
    grader_version    text NOT NULL,
    -- Structured grader report (failToPass/passToPass + the benchmark's report).
    grader_output     jsonb,
    -- The benchmark's own output, stored VERBATIM (Rollout-Cards reproducibility).
    raw_grader_output text,
    -- The exact submission graded: M1 the unified diff, M2 the env handle ref.
    submission        text,
    -- Pointer to the full agent trajectory artifact + how to fetch it.
    trajectory_ref    text,
    trajectory_kind   text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS benchmark_rollout_ws_run_idx
    ON harness_shared.benchmark_rollout (workspace_id, run_id);

-- ─── Layer 1: the scoreable+provenance row (mirrors TaskRunResult 1:1) ───────
CREATE TABLE IF NOT EXISTS harness_shared.benchmark_run_result (
    -- = benchmark_rollout.rollout_id (1:1). PK + the idempotent-emit key.
    rollout_id          text NOT NULL PRIMARY KEY
                        REFERENCES harness_shared.benchmark_rollout (rollout_id)
                        ON DELETE CASCADE,
    run_id              text NOT NULL,
    workspace_id        text NOT NULL,
    -- ── identity ──
    suite               text NOT NULL,
    modality            text NOT NULL
                        CHECK (modality IN ('diff', 'in-container')),
    task_id             text NOT NULL,
    arm                 text NOT NULL
                        CHECK (arm IN ('papercusp', 'baseline-a-ablation',
                                       'baseline-b-native', 'baseline-c-bestofn')),
    -- Independent-attempt ordinal — ≥3 distinct per (task × arm).
    seed                integer NOT NULL,
    -- ── grader slice (P-001 §5; identical machinery per arm) ──
    -- NULLABLE: null when never genuinely graded (infra) → excluded from accuracy.
    resolved            boolean,
    grader_status       text NOT NULL
                        CHECK (grader_status IN ('passed', 'failed', 'error', 'timeout')),
    grader_family       text NOT NULL,
    grader_version      text NOT NULL,
    -- M1 (diff) only: per-test breakdown (TestOutcome[]); null for M2.
    fail_to_pass        jsonb,
    pass_to_pass        jsonb,
    -- ── generation / cost slice (P-011) ──
    -- SUMMED across every agent + turn (coordination/sampling overhead counted).
    tokens_in           bigint NOT NULL,
    tokens_out          bigint NOT NULL,
    tokens_total        bigint NOT NULL,
    tokens_cache_read   bigint,
    tokens_cache_write  bigint,
    -- DERIVED at emit via priceRun(tokens, model_id, table). Recomputable.
    cost_usd            double precision NOT NULL,
    price_table_version text NOT NULL,
    wall_clock_ms       bigint NOT NULL,
    turns               integer NOT NULL DEFAULT 0,
    -- GENERATION iso-budget cap this run ran under (null = uncapped / native).
    budget_tokens       bigint,
    -- Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail).
    capped              boolean NOT NULL DEFAULT false,
    -- Generation outcome (parallel to grader_status). error/timeout = infra.
    generation_status   text NOT NULL
                        CHECK (generation_status IN ('completed', 'error', 'timeout')),
    generation_error    text,
    -- Arm-specific detail; opaque to scoring, published for reproducibility.
    arm_meta            jsonb,
    -- ── reproducibility slice (P-010; full content in benchmark_rollout) ──
    model_id            text NOT NULL,
    harness_version     text NOT NULL,
    -- Every row must match a benchmark_prereg row (firewall, enforced in emit).
    prereg_hash         text NOT NULL,
    -- Artifact pointers into the rollout card.
    raw_grader_output_ref text,
    submission_ref      text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- The natural attempt key (rollout_id is its hash; this guards it).
    UNIQUE (workspace_id, run_id, suite, task_id, arm, seed)
);

-- Primary read path: a run's rows, by suite, newest-first (evals.runs / report).
CREATE INDEX IF NOT EXISTS benchmark_run_result_ws_run_suite_idx
    ON harness_shared.benchmark_run_result (workspace_id, run_id, suite);

-- Suite scoreboard across runs (evals.suites).
CREATE INDEX IF NOT EXISTS benchmark_run_result_ws_suite_created_idx
    ON harness_shared.benchmark_run_result (workspace_id, suite, created_at DESC);

-- Firewall checks: rows that ran under a given pre-registration.
CREATE INDEX IF NOT EXISTS benchmark_run_result_prereg_idx
    ON harness_shared.benchmark_run_result (prereg_hash);

-- ─── Workspace isolation (RLS), mirroring experiment_runs (287) ──────────────
-- The operator connects as harness_admin (superuser, bypasses RLS); the policy
-- keeps any non-superuser path workspace-scoped.
ALTER TABLE harness_shared.benchmark_prereg      ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.benchmark_rollout     ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.benchmark_run_result  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS benchmark_prereg_workspace_isolation ON harness_shared.benchmark_prereg;
CREATE POLICY benchmark_prereg_workspace_isolation ON harness_shared.benchmark_prereg
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

DROP POLICY IF EXISTS benchmark_rollout_workspace_isolation ON harness_shared.benchmark_rollout;
CREATE POLICY benchmark_rollout_workspace_isolation ON harness_shared.benchmark_rollout
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

DROP POLICY IF EXISTS benchmark_run_result_workspace_isolation ON harness_shared.benchmark_run_result;
CREATE POLICY benchmark_run_result_workspace_isolation ON harness_shared.benchmark_run_result
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- ─── Runtime-role grants (mirror experiment_runs) ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.benchmark_prereg     TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.benchmark_rollout    TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.benchmark_run_result TO harness_app;
GRANT SELECT ON harness_shared.benchmark_prereg     TO harness_zero;
GRANT SELECT ON harness_shared.benchmark_rollout    TO harness_zero;
GRANT SELECT ON harness_shared.benchmark_run_result TO harness_zero;
