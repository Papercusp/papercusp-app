-- 287-experiment-runs-ledger.sql
--
-- experiment-registry-invocation-api-2026-06-14 (P-050): the experiment LEDGER —
-- one row per `experiment:run` invocation (the run-level summary), distinct from
-- the per-CELL replay_runs (247). This is the durable record the universal
-- experiment API writes so the self-learning system can see how variations
-- performed — what Scout meta-learning + trust graduation read back, and what the
-- Learning-tab scoreboard (P-051) renders.
--
--   experiment_runs — keyed (workspace_id, battery_id): test_id + tier, the
--     compared arms with their normalized judge scores (arms jsonb), the
--     baseline anchor, the selected winner + the full compareArms verdict
--     (comparison jsonb), total spend, and the decision lifecycle. A winner is
--     a PROPOSAL — applying it rides commit→reproject + graduation (D-006), so
--     `decision` starts 'proposed' and only the apply path advances it.
--
--   signal_origin defaults to 'replay' (migration 241's provenance vocabulary,
--     D-002): every experiment output is synthetic w.r.t. the live loop, born
--     tagged so no organic learner consumes it un-opted-in.
--
-- Vocabulary OWNED by packages/operator-core/lib/experiment/. Columns stay plain
-- text so the seam can evolve (mirroring replay_runs / learning_governor_loops).
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.experiment_runs (
    workspace_id     text NOT NULL,
    -- Groups this experiment:run invocation (the battery).
    battery_id       text NOT NULL,
    -- The registered test (descriptor) id: replay | gym | instance | hive | ...
    test_id          text NOT NULL,
    -- Fidelity tier the run executed at.
    tier             text NOT NULL
                     CHECK (tier IN ('offline', 'shadow', 'live')),
    -- The compared arms + their normalized scores (ExperimentArmResult[]).
    arms             jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The baseline-anchor arm id (the compareArms anchor).
    baseline_id      text NOT NULL,
    -- The selected winning arm id (compareArms), NULL when no strict improvement.
    winner           text,
    -- The full compareArms verdict (Omit<CompareSelectResult, 'scenarioId'>).
    comparison       jsonb,
    -- Replay-runner + judge spend summed across the run's cells.
    total_cost_usd   numeric NOT NULL DEFAULT 0,
    budget_exhausted boolean NOT NULL DEFAULT false,
    -- The decision lifecycle (D-006): a winner is a proposal; the apply path
    -- (commit→reproject + graduation) advances it — never experiment:run itself.
    decision         text NOT NULL DEFAULT 'proposed'
                     CHECK (decision IN ('proposed', 'applied', 'rejected')),
    -- Provenance vocabulary shared with migration 241 (P-002/D-002). Offline
    -- replay outputs are born 'replay'; the CHECK keeps the vocab closed.
    signal_origin    text NOT NULL DEFAULT 'replay'
                     CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, battery_id)
);

-- Primary read path: a workspace's experiments by test, newest-first (scoreboard).
CREATE INDEX IF NOT EXISTS experiment_runs_ws_test_idx
    ON harness_shared.experiment_runs (workspace_id, test_id, created_at DESC);

CREATE INDEX IF NOT EXISTS experiment_runs_ws_created_idx
    ON harness_shared.experiment_runs (workspace_id, created_at DESC);

-- Workspace isolation, mirroring replay_runs (247) / learning_governor_loops (244).
-- The operator connects as harness_admin (superuser, bypasses RLS); the policy keeps
-- any non-superuser path workspace-scoped.
ALTER TABLE harness_shared.experiment_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS experiment_runs_workspace_isolation ON harness_shared.experiment_runs;
CREATE POLICY experiment_runs_workspace_isolation ON harness_shared.experiment_runs
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants. The run-level row is written once then updated in place
-- when the decision advances (proposed → applied/rejected).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.experiment_runs TO harness_app;
GRANT SELECT ON harness_shared.experiment_runs TO harness_zero;
