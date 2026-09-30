-- 247-replay-runs.sql
--
-- self-learning-frontier-2026-06-12 (P-020 / FB-06, D-001/D-002): the REPLAY
-- HARNESS run store — one row per eval-battery cell of a replay battery
-- (re-running an agent from a historical transcript point, or a synthetic
-- context, under a modified prompt/policy and scoring the divergence).
--
--   replay_runs — per-cell lifecycle: started → scored | rate_limited |
--     errored (the eval-battery's never-abort discipline; a failed cell is
--     RECORDED, never silently dropped). battery_id groups the cells of one
--     runReplayBattery invocation; variant 'baseline' is the comparison
--     anchor (for a historical case it is the original continuation, echoed
--     at zero cost). divergence carries the deterministic divergence signals
--     (jaccard / prefix / length) computed against the historical
--     continuation — judge scores (d1/d2/d3/composite) come from the frozen
--     eval-battery judge.
--
--   signal_origin defaults to 'replay' (migration 241's provenance
--   vocabulary, P-002/D-002): every output of this substrate is born tagged
--   so no organic learner ever consumes it un-opted-in.
--
-- Vocabulary OWNED by packages/operator-core/lib/replay/ (columns stay plain
-- text so the seam can evolve, mirroring learning_governor_loops).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.replay_runs (
    workspace_id  text NOT NULL,
    run_id        text NOT NULL,
    -- Groups the cells of one battery invocation.
    battery_id    text NOT NULL,
    variant_id    text NOT NULL,
    variant_label text,
    -- Transcript ref for a historical case; 'synthetic:<caseId>' otherwise.
    case_ref      text NOT NULL,
    -- The historical cut point (NULL for a synthetic case).
    turn_index    integer,
    repeat        integer NOT NULL DEFAULT 0,
    -- 'started' | 'scored' | 'rate_limited' | 'errored' (eval-battery cell
    -- disposition + the pre-judge 'started').
    status        text NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started', 'scored', 'rate_limited', 'errored')),
    -- Provenance vocabulary shared with migration 241 (P-002/D-002). Replay
    -- outputs are born 'replay'; the CHECK keeps the vocab closed.
    signal_origin text NOT NULL DEFAULT 'replay'
                  CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    -- Frozen-judge scores (NULL until scored).
    d1            numeric,
    d2            numeric,
    d3            numeric,
    composite     numeric,
    judge_rationale text,
    rubric_hash   text,
    -- Deterministic divergence signals vs the historical continuation.
    divergence    jsonb,
    -- Replay-runner + judge spend for this cell.
    cost_usd      numeric NOT NULL DEFAULT 0,
    error         text,
    elapsed_ms    bigint,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, run_id)
);

-- Primary read path: one battery's cells, then newest-first across a workspace.
CREATE INDEX IF NOT EXISTS replay_runs_ws_battery_idx
    ON harness_shared.replay_runs (workspace_id, battery_id, created_at);

CREATE INDEX IF NOT EXISTS replay_runs_ws_created_idx
    ON harness_shared.replay_runs (workspace_id, created_at DESC);

-- Workspace isolation, mirroring learning_governor_loops (244). The operator
-- connects as harness_admin (superuser, bypasses RLS); the policy keeps any
-- non-superuser path workspace-scoped + consistent with harness_shared.
ALTER TABLE harness_shared.replay_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS replay_runs_workspace_isolation ON harness_shared.replay_runs;
CREATE POLICY replay_runs_workspace_isolation ON harness_shared.replay_runs
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (cell lifecycle rows are written then updated in place
-- as the battery progresses — not an append-only ledger; spend ledgering
-- stays on learning_spend_events).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.replay_runs TO harness_app;
GRANT SELECT ON harness_shared.replay_runs TO harness_zero;
